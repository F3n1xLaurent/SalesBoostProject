import crypto from 'crypto';
import type { Request, Response } from 'express';
import type { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { openai } from '../lib/openaiClient';
import { config } from '../config';

type ImportFormat = 'json' | 'xml' | 'csv';
type ImportStatus = 'active' | 'paused' | 'error';
type ImportRunStatus = 'success' | 'error' | 'running';
type TagOperator =
  | 'equals'
  | 'notEquals'
  | 'contains'
  | 'notContains'
  | 'exists'
  | 'notExists'
  | 'greaterThan'
  | 'lessThan'
  | 'greaterOrEqual'
  | 'lessOrEqual'
  | 'in'
  | 'regex';

type ImportAIConfig = {
  entityType: string;
  externalIdField: string | null;
  titleFields: string[];
  descriptionFields: string[];
  fieldLabels: Record<string, string>;
  importantFields: string[];
  ignoredFields: string[];
};

type TagRule = {
  id: string;
  name: string;
  enabled: boolean;
  condition: {
    field: string;
    operator: TagOperator;
    value?: unknown;
  };
};

type ImportSourceWithCount = Prisma.ImportSourceGetPayload<{
  include: { _count: { select: { items: true } }; holding: { select: { name: true } } };
}>;

type ImportedItemWithSource = Prisma.ImportedItemGetPayload<{
  include: { importSource: { select: { name: true; format: true; holdingId: true; holding: { select: { name: true } } } } };
}>;

const TAG_OPERATORS = new Set<TagOperator>([
  'equals',
  'notEquals',
  'contains',
  'notContains',
  'exists',
  'notExists',
  'greaterThan',
  'lessThan',
  'greaterOrEqual',
  'lessOrEqual',
  'in',
  'regex',
]);
const MAX_SOURCE_BYTES = 20_000_000;
const MAX_SAMPLE_ITEMS = 10;
const MAX_RUN_ITEMS = 500;
const SOURCE_FETCH_TIMEOUT_MS = 30_000;
const AI_CONFIG_TIMEOUT_MS = 15_000;
const AI_TAG_RULE_TIMEOUT_MS = 8_000;
const AI_TAG_RULES_TIMEOUT_MS = 15_000;
const AI_AUTOTAG_TIMEOUT_MS = 15_000;
const MAX_AI_AUTOTAG_ITEMS = 5;
const MAX_GENERATED_TAG_RULES = 15;

function parseString(value: unknown): string | null {
  const parsed = String(value ?? '').trim();
  return parsed ? parsed : null;
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/ё/g, 'е');
}

function safeJsonParse<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeout));
}

function createRequestId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
}

function formatBytes(bytes: number): string {
  return `${Math.round(bytes / 1_000_000)} МБ`;
}

function isPlatformSuperadmin(account: NonNullable<Express.Request['authAccount']>): boolean {
  return account.memberships.some((membership) => membership.role === 'platform_superadmin');
}

async function getAccessibleHoldingIds(account: NonNullable<Express.Request['authAccount']>): Promise<string[] | null> {
  if (isPlatformSuperadmin(account)) return null;
  const directHoldingIds = account.memberships
    .map((membership) => membership.holdingId)
    .filter(Boolean) as string[];
  const dealershipIds = account.memberships
    .map((membership) => membership.dealershipId)
    .filter(Boolean) as string[];
  const dealerships = dealershipIds.length
    ? await prisma.dealership.findMany({
      where: { id: { in: dealershipIds }, holdingId: { not: null } },
      select: { holdingId: true },
    })
    : [];
  return Array.from(new Set([
    ...directHoldingIds,
    ...dealerships.map((dealership) => dealership.holdingId).filter(Boolean) as string[],
  ]));
}

async function assertCanAccessHolding(req: Request, holdingId: string): Promise<void> {
  const account = req.authAccount;
  if (!account) throw new Error('Требуется авторизация.');
  const accessibleHoldingIds = await getAccessibleHoldingIds(account);
  if (accessibleHoldingIds !== null && !accessibleHoldingIds.includes(holdingId)) {
    throw new Error('Нет доступа к выбранной компании.');
  }
}

async function getRequestedHoldingFilter(req: Request): Promise<string | null> {
  const holdingId = parseString(req.query.holdingId);
  if (!holdingId) return null;
  await assertCanAccessHolding(req, holdingId);
  return holdingId;
}

async function buildImportSourceWhereForRequest(req: Request): Promise<Prisma.ImportSourceWhereInput> {
  const account = req.authAccount;
  if (!account) throw new Error('Требуется авторизация.');
  const holdingId = await getRequestedHoldingFilter(req);
  if (holdingId) return { holdingId };
  const accessibleHoldingIds = await getAccessibleHoldingIds(account);
  return accessibleHoldingIds === null ? {} : { holdingId: { in: accessibleHoldingIds } };
}

async function assertCanAccessImportSource(req: Request, importSourceId: string): Promise<void> {
  const source = await prisma.importSource.findUnique({
    where: { id: importSourceId },
    select: { holdingId: true },
  });
  if (!source) throw new Error('Импорт не найден.');
  if (!source.holdingId) throw new Error('Импорт не привязан к компании.');
  await assertCanAccessHolding(req, source.holdingId);
}

function parseTagFilters(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(parseTagFilters);
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function assertSafeSourceUrl(rawUrl: unknown): string {
  const value = parseString(rawUrl);
  if (!value) throw new Error('URL источника обязателен.');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Некорректный URL источника.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Поддерживаются только http/https источники.');
  }
  const hostname = url.hostname.toLowerCase();
  if (
    hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname === '127.0.0.1'
    || hostname === '0.0.0.0'
    || hostname === '::1'
    || hostname.startsWith('10.')
    || hostname.startsWith('192.168.')
    || /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)
  ) {
    throw new Error('Локальные и private-адреса для источника запрещены.');
  }
  return url.toString();
}

async function fetchSourceText(url: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SOURCE_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`Источник вернул HTTP ${response.status}.`);
    const contentLength = Number(response.headers.get('content-length') || 0);
    if (contentLength > MAX_SOURCE_BYTES) {
      throw new Error(`Ответ источника слишком большой. Максимум: ${formatBytes(MAX_SOURCE_BYTES)}.`);
    }
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_SOURCE_BYTES) {
      throw new Error(`Ответ источника слишком большой. Максимум: ${formatBytes(MAX_SOURCE_BYTES)}.`);
    }
    return text;
  } catch (error) {
    if (error instanceof Error && (error.name === 'AbortError' || /aborted/i.test(error.message))) {
      throw new Error(`Скачивание источника прервано по таймауту ${SOURCE_FETCH_TIMEOUT_MS} мс. Endpoint: fetch import source.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function detectFormat(text: string, url?: string): ImportFormat {
  const lowerUrl = (url || '').toLowerCase();
  const trimmed = text.trim();
  if (lowerUrl.endsWith('.xml') || trimmed.startsWith('<')) return 'xml';
  if (lowerUrl.endsWith('.csv')) return 'csv';
  return 'json';
}

function sanitizeXml(xml: string): string {
  return xml
    .replace(/^\uFEFF/, '')
    .replace(/<\?xml[\s\S]*?\?>/gi, '')
    .replace(/<!DOCTYPE[\s\S]*?>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim();
}

function parseXmlNode(xml: string): unknown {
  const trimmed = sanitizeXml(xml);
  const rootMatch = trimmed.match(/^<([\w:.-]+)(?:\s[^>]*)?>([\s\S]*)<\/\1>$/);
  if (!rootMatch) return trimmed.replace(/<[^>]+>/g, '').trim();
  const body = rootMatch[2].trim();
  const childRegex = /<([\w:.-]+)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/g;
  const children: Array<{ key: string; value: unknown }> = [];
  let match: RegExpExecArray | null;
  while ((match = childRegex.exec(body))) {
    children.push({ key: match[1], value: parseXmlNode(match[0]) });
  }
  if (children.length === 0) return body.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();
  const result: Record<string, unknown> = {};
  for (const child of children) {
    if (result[child.key] == null) {
      result[child.key] = child.value;
    } else if (Array.isArray(result[child.key])) {
      (result[child.key] as unknown[]).push(child.value);
    } else {
      result[child.key] = [result[child.key], child.value];
    }
  }
  return result;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getXmlTagNameFromPath(path: string | null | undefined): string | null {
  const parts = String(path || '').split('.').filter(Boolean);
  return parts[parts.length - 1] || null;
}

function countXmlTag(xml: string, tagName: string): number {
  const tag = escapeRegExp(tagName);
  return Array.from(xml.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>`, 'gi'))).length;
}

function findXmlParentPath(xml: string, tagName: string, openingIndex: number): string {
  const stack: string[] = [];
  const tagRegex = /<\/?([A-Za-z_][\w:.-]*)(?:\s[^>]*)?>/g;
  let match: RegExpExecArray | null;
  while ((match = tagRegex.exec(xml)) && match.index < openingIndex) {
    const full = match[0];
    const name = match[1];
    if (full.startsWith('</')) {
      const index = stack.lastIndexOf(name);
      if (index >= 0) stack.splice(index);
    } else if (!full.endsWith('/>')) {
      stack.push(name);
    }
  }
  const parent = stack.filter((name) => name !== tagName).at(-1);
  return parent ? `${parent}.${tagName}` : tagName;
}

function extractXmlElementBlocks(xml: string, tagName: string, limit: number): string[] {
  const tag = escapeRegExp(tagName);
  const tokenRegex = new RegExp(`</?${tag}(?:\\s[^>]*)?>`, 'gi');
  const blocks: string[] = [];
  let cursor = 0;
  while (blocks.length < limit) {
    tokenRegex.lastIndex = cursor;
    const start = tokenRegex.exec(xml);
    if (!start) break;
    if (start[0].startsWith('</')) {
      cursor = tokenRegex.lastIndex;
      continue;
    }
    let depth = 1;
    const startIndex = start.index;
    while (depth > 0) {
      const next = tokenRegex.exec(xml);
      if (!next) return blocks;
      if (next[0].startsWith('</')) depth -= 1;
      else if (!next[0].endsWith('/>')) depth += 1;
      if (depth === 0) {
        blocks.push(xml.slice(startIndex, tokenRegex.lastIndex));
        cursor = tokenRegex.lastIndex;
      }
    }
  }
  return blocks;
}

function getXmlItemTagCandidates(xml: string): Array<{ tagName: string; count: number; firstIndex: number; score: number }> {
  const counts = new Map<string, { count: number; firstIndex: number }>();
  const tagRegex = /<([A-Za-z_][\w:.-]*)(?:\s[^>]*)?>/g;
  let match: RegExpExecArray | null;
  while ((match = tagRegex.exec(xml))) {
    const tagName = match[1];
    const current = counts.get(tagName);
    counts.set(tagName, { count: (current?.count || 0) + 1, firstIndex: current?.firstIndex ?? match.index });
  }
  return Array.from(counts.entries())
    .map(([tagName, info]) => {
      let score = Math.min(info.count, 100);
      if (/^(offer|item|product|car|vehicle|record|row|entry)$/i.test(tagName)) score += 1000;
      if (info.count > 1) score += 100;
      return { tagName, count: info.count, firstIndex: info.firstIndex, score };
    })
    .sort((a, b) => b.score - a.score);
}

function extractXmlSampleItems(text: string, limit: number): { path: string; items: unknown[]; totalItems: number } | null {
  const xml = sanitizeXml(text);
  const [candidate] = getXmlItemTagCandidates(xml);
  if (!candidate) return null;
  const blocks = extractXmlElementBlocks(xml, candidate.tagName, limit);
  if (blocks.length === 0) return null;
  return {
    path: findXmlParentPath(xml, candidate.tagName, candidate.firstIndex),
    items: blocks.map(parseXmlNode),
    totalItems: candidate.count,
  };
}

function extractXmlItemsByPath(text: string, path: string, limit: number): { items: unknown[]; totalItems: number } | null {
  const tagName = getXmlTagNameFromPath(path);
  if (!tagName) return null;
  const xml = sanitizeXml(text);
  const blocks = extractXmlElementBlocks(xml, tagName, limit);
  if (blocks.length === 0) return null;
  return {
    items: blocks.map(parseXmlNode),
    totalItems: countXmlTag(xml, tagName),
  };
}

function parseSource(text: string, format: ImportFormat): unknown {
  if (format === 'json') return JSON.parse(text);
  if (format === 'xml') return parseXmlNode(text);
  throw new Error('CSV пока не поддерживается в MVP.');
}

function flattenObject(value: unknown, prefix = '', out: Record<string, unknown> = {}): Record<string, unknown> {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    if (prefix) out[prefix] = value;
    return out;
  }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (nested != null && typeof nested === 'object' && !Array.isArray(nested)) {
      flattenObject(nested, path, out);
    } else {
      out[path] = nested;
    }
  }
  return out;
}

function getByPath(value: unknown, path: string | null | undefined): unknown {
  if (!path) return value;
  return path.split('.').filter(Boolean).reduce((current: unknown, segment) => {
    if (current == null) return undefined;
    if (Array.isArray(current)) {
      const index = Number(segment);
      return Number.isInteger(index) ? current[index] : undefined;
    }
    if (typeof current === 'object') return (current as Record<string, unknown>)[segment];
    return undefined;
  }, value);
}

function findBestItemsPath(value: unknown, prefix = ''): { path: string; items: unknown[] } {
  if (Array.isArray(value)) return { path: prefix, items: value };
  if (!value || typeof value !== 'object') return { path: prefix, items: [] };
  let best = { path: prefix, items: [] as unknown[] };
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    const candidate = findBestItemsPath(nested, prefix ? `${prefix}.${key}` : key);
    if (candidate.items.length > best.items.length) best = candidate;
  }
  if (best.items.length === 0) {
    const objectCandidate = findBestObjectItemsPath(value, prefix);
    if (objectCandidate.items.length > 0) return objectCandidate;
  }
  return best;
}

function scoreObjectItemPath(path: string, value: unknown): number {
  if (!path || !value || typeof value !== 'object' || Array.isArray(value)) return 0;
  const flat = flattenObject(value);
  const fieldsCount = Object.keys(flat).filter((field) => flat[field] != null && flat[field] !== '').length;
  if (fieldsCount === 0) return 0;
  const segments = path.split('.');
  const last = segments[segments.length - 1] || '';
  const parent = segments[segments.length - 2] || '';
  let score = Math.min(fieldsCount, 20);
  if (/^(offer|item|product|car|vehicle|record|row|entry)$/i.test(last)) score += 50;
  if (/s$/i.test(parent) || /^(items|offers|products|cars|vehicles|records|rows|entries)$/i.test(parent)) score += 20;
  if (Object.values(value as Record<string, unknown>).some((nested) => Array.isArray(nested))) score -= 20;
  return score;
}

function findBestObjectItemsPath(value: unknown, prefix = ''): { path: string; items: unknown[]; score: number } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { path: prefix, items: [], score: 0 };
  let best = { path: prefix, items: [] as unknown[], score: scoreObjectItemPath(prefix, value) };
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    const candidate = findBestObjectItemsPath(nested, path);
    if (candidate.score > best.score) best = candidate;
  }
  return best.score > 0 ? { path: best.path, items: [getByPath(value, best.path) ?? value], score: best.score } : best;
}

function normalizeConfig(input: unknown, sampleItems: unknown[]): ImportAIConfig {
  const first = flattenObject(sampleItems[0] || {});
  const fields = Object.keys(first);
  const raw = input && typeof input === 'object' ? input as Partial<ImportAIConfig> : {};
  const pickFields = (value: unknown, fallback: string[]) => (
    Array.isArray(value)
      ? value
        .map((item) => String(item || '').trim())
        .filter((field) => field && (fields.length === 0 || fields.includes(field)))
        .slice(0, 12)
      : fallback
  );
  const titleFallback = fields.filter((field) => /name|title|mark|brand|model|year/i.test(field)).slice(0, 3);
  const descriptionFallback = fields.filter((field) => !titleFallback.includes(field)).slice(0, 8);
  return {
    entityType: parseString(raw.entityType) || 'item',
    externalIdField: (() => {
      const configured = parseString(raw.externalIdField);
      if (configured && (fields.length === 0 || fields.includes(configured))) return configured;
      return fields.find((field) => /(^|\.)(id|vin|uuid|code)$/i.test(field)) || null;
    })(),
    titleFields: pickFields(raw.titleFields, titleFallback.length ? titleFallback : fields.slice(0, 2)),
    descriptionFields: pickFields(raw.descriptionFields, descriptionFallback),
    fieldLabels: raw.fieldLabels && typeof raw.fieldLabels === 'object' ? raw.fieldLabels as Record<string, string> : {},
    importantFields: pickFields(raw.importantFields, fields.slice(0, 10)),
    ignoredFields: pickFields(raw.ignoredFields, []),
  };
}

function valueToText(value: unknown): string {
  if (value == null || value === '') return '';
  if (typeof value === 'boolean') return value ? 'да' : 'нет';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function uniqStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function buildTitle(item: unknown, config: ImportAIConfig): string {
  const flat = flattenObject(item);
  const title = config.titleFields.map((field) => valueToText(flat[field])).filter(Boolean).join(' ');
  return title || valueToText(Object.values(flat).find((value) => value != null)) || 'Без названия';
}

function buildDescription(item: unknown, config: ImportAIConfig): string {
  const flat = flattenObject(item);
  const title = buildTitle(item, config);
  const fields = uniqStrings([
    ...config.importantFields,
    ...config.titleFields,
    ...config.descriptionFields,
    ...Object.keys(flat),
  ])
    .filter((field) => !config.ignoredFields.includes(field))
    .filter((field) => valueToText(flat[field]))
    .slice(0, 40);

  const lines = [
    `Тип сущности: ${config.entityType || 'item'}`,
    `Название: ${title}`,
    'Данные:',
    ...fields.map((field) => {
      const label = config.fieldLabels[field] || field;
      return `- ${label} (${field}): ${valueToText(flat[field])}`;
    }),
  ];
  return lines.join('\n');
}

function normalizeTagRules(input: unknown): TagRule[] {
  if (!Array.isArray(input)) return [];
  return input.map((item, index) => {
    const raw = item && typeof item === 'object' ? item as Partial<TagRule> : {};
    const condition = raw.condition && typeof raw.condition === 'object' ? raw.condition as TagRule['condition'] : null;
    const operator = condition?.operator;
    const field = parseString(condition?.field);
    const name = parseString(raw.name);
    if (!name || !field || !operator || !TAG_OPERATORS.has(operator)) return null;
    return {
      id: parseString(raw.id) || `rule-${index + 1}`,
      name,
      enabled: raw.enabled !== false,
      condition: {
        field,
        operator,
        value: condition.value,
      },
    };
  }).filter(Boolean) as TagRule[];
}

function normalizeGeneratedTagName(value: string): string {
  const cleaned = value
    .trim()
    .replace(/^["'«»\s]+|["'«»\s]+$/g, '')
    .replace(/^(?:тег|tag)\s*(?:для|for|:|-)?\s*/i, '')
    .replace(/\s+(?:tag|тег)$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  const normalized = normalizeText(cleaned);
  const knownTranslations: Array<[RegExp, string]> = [
    [/^(?:new\s+cars?|new\s+vehicles?|cars?\s+new)$/i, 'Новые машины'],
    [/^(?:used\s+cars?|used\s+vehicles?|pre-?owned\s+cars?|cars?\s+with\s+mileage)$/i, 'С пробегом'],
    [/^(?:premium|luxury)(?:\s+cars?|\s+vehicles?)?$/i, 'Премиум'],
    [/^(?:available|in\s+stock)(?:\s+cars?|\s+vehicles?)?$/i, 'В наличии'],
    [/^(?:credit|loan|financing)$/i, 'Кредит'],
  ];
  const translated = knownTranslations.find(([pattern]) => pattern.test(cleaned))?.[1];
  if (translated) return translated;
  return normalized.includes('нов') && normalized.includes('маш') ? 'Новые машины' : cleaned;
}

function isRussianTagName(value: string): boolean {
  return /[А-Яа-яЁё]/.test(value) && !/^(?:тег|tag)\b/i.test(value.trim());
}

function normalizeGeneratedTagRules(input: unknown, availableFields: string[]): TagRule[] {
  const rawRules = Array.isArray(input)
    ? input
    : input && typeof input === 'object' && Array.isArray((input as { rules?: unknown }).rules)
      ? (input as { rules: unknown[] }).rules
      : [];
  return normalizeTagRules(rawRules.map((rule, index) => ({ id: `ai-rule-${index + 1}`, enabled: true, ...rule })))
    .map((rule) => ({ ...rule, name: normalizeGeneratedTagName(rule.name) }))
    .filter((rule) => rule.name && isRussianTagName(rule.name))
    .filter((rule) => availableFields.includes(rule.condition.field))
    .slice(0, MAX_GENERATED_TAG_RULES);
}

function parseHeuristicRuleValue(raw: string): unknown {
  const value = raw.trim().replace(/^["'«]+|["'».,]+$/g, '').trim();
  if (!value) return undefined;
  if (/^(true|да|yes|истина)$/i.test(value)) return true;
  if (/^(false|нет|no|ложь)$/i.test(value)) return false;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if (value.includes(',')) return value.split(',').map((item) => item.trim()).filter(Boolean);
  return value;
}

function generateTagRuleHeuristic(text: string, availableFields: string[]): TagRule | null {
  const normalized = normalizeText(text);
  const field = availableFields.find((candidate) => normalizeText(candidate) && normalized.includes(normalizeText(candidate)));
  if (!field) return null;

  const nameMatch =
    text.match(/тег\s+["«]([^"»]+)["»]/i)
    || text.match(/тег\s+([А-Яа-яA-Za-z0-9 _-]+?)(?:,|\s+если|\s+когда|$)/i);
  const name = parseString(nameMatch?.[1]);
  if (!name) return null;

  let operator: TagOperator = 'equals';
  if (/не\s+содерж|not\s+contains/i.test(normalized)) operator = 'notContains';
  else if (/содерж|contains/i.test(normalized)) operator = 'contains';
  else if (/не\s+равн|!=|not\s+equal/i.test(normalized)) operator = 'notEquals';
  else if (/больше\s+или\s+равн|>=|greater\s+or\s+equal/i.test(normalized)) operator = 'greaterOrEqual';
  else if (/меньше\s+или\s+равн|<=|less\s+or\s+equal/i.test(normalized)) operator = 'lessOrEqual';
  else if (/больше|>|greater/i.test(normalized)) operator = 'greaterThan';
  else if (/меньше|<|less/i.test(normalized)) operator = 'lessThan';
  else if (/не\s+существ|пуст|not\s+exists/i.test(normalized)) operator = 'notExists';
  else if (/существ|заполн|exists/i.test(normalized)) operator = 'exists';
  else if (/\bв\s+списк| in /i.test(normalized)) operator = 'in';
  else if (/regex|регуляр/i.test(normalized)) operator = 'regex';

  const valueMatch =
    text.match(/(?:равно|=|содержит|больше(?:\s+или\s+равно)?|меньше(?:\s+или\s+равно)?|значение)\s+["«]?([^"».,]+)["»]?/i)
    || text.match(new RegExp(`${escapeRegExp(field)}\\s*(?:=|==|>|<|>=|<=)\\s*["«]?([^"».,]+)["»]?`, 'i'));

  return {
    id: 'rule-1',
    name,
    enabled: true,
    condition: {
      field,
      operator,
      value: operator === 'exists' || operator === 'notExists' ? undefined : parseHeuristicRuleValue(valueMatch?.[1] || ''),
    },
  };
}

function compareNumber(left: unknown, right: unknown, fn: (a: number, b: number) => boolean): boolean {
  const a = Number(left);
  const b = Number(right);
  return Number.isFinite(a) && Number.isFinite(b) && fn(a, b);
}

function tagRuleMatches(item: unknown, rule: TagRule): boolean {
  const flat = flattenObject(item);
  const actual = flat[rule.condition.field];
  const expected = rule.condition.value;
  switch (rule.condition.operator) {
    case 'equals': return actual === expected || String(actual) === String(expected);
    case 'notEquals': return !(actual === expected || String(actual) === String(expected));
    case 'contains': return String(actual ?? '').toLowerCase().includes(String(expected ?? '').toLowerCase());
    case 'notContains': return !String(actual ?? '').toLowerCase().includes(String(expected ?? '').toLowerCase());
    case 'exists': return actual !== undefined && actual !== null && actual !== '';
    case 'notExists': return actual === undefined || actual === null || actual === '';
    case 'greaterThan': return compareNumber(actual, expected, (a, b) => a > b);
    case 'lessThan': return compareNumber(actual, expected, (a, b) => a < b);
    case 'greaterOrEqual': return compareNumber(actual, expected, (a, b) => a >= b);
    case 'lessOrEqual': return compareNumber(actual, expected, (a, b) => a <= b);
    case 'in': return Array.isArray(expected) && expected.map(String).includes(String(actual));
    case 'regex':
      try { return new RegExp(String(expected ?? '')).test(String(actual ?? '')); } catch { return false; }
  }
}

function tagRuleMatchesNormalized(normalizedItem: Record<string, unknown>, rawItem: unknown, rule: TagRule): boolean {
  const rawFlat = flattenObject(rawItem);
  const actual = normalizedItem[rule.condition.field] ?? rawFlat[rule.condition.field];
  return tagRuleMatches({ [rule.condition.field]: actual }, rule);
}

function applyTagRules(normalizedItem: Record<string, unknown>, rawItem: unknown, rules: TagRule[]): string[] {
  return rules
    .filter((rule) => rule.enabled)
    .filter((rule) => tagRuleMatchesNormalized(normalizedItem, rawItem, rule))
    .map((rule) => rule.name);
}

function truncateText(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function limitRecordForPrompt(input: Record<string, unknown>, maxFields = 40): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input).slice(0, maxFields)) {
    result[key] = typeof value === 'string' ? truncateText(value, 500) : value;
  }
  return result;
}

function normalizeAiAutotagResult(
  input: unknown,
  allowedTags: Set<string>,
  allowedItemIds: Set<string>,
): Array<{ itemId: string; tags: string[] }> {
  const rawItems = Array.isArray(input)
    ? input
    : input && typeof input === 'object' && Array.isArray((input as { items?: unknown }).items)
      ? (input as { items: unknown[] }).items
      : [];

  return rawItems.map((entry) => {
    const raw = entry && typeof entry === 'object' ? entry as { itemId?: unknown; id?: unknown; tags?: unknown } : {};
    const itemId = parseString(raw.itemId) || parseString(raw.id);
    if (!itemId || !allowedItemIds.has(itemId)) return null;
    const tags = Array.isArray(raw.tags)
      ? raw.tags.map((tag) => String(tag || '').trim()).filter((tag) => allowedTags.has(tag))
      : [];
    return { itemId, tags: uniqStrings(tags) };
  }).filter(Boolean) as Array<{ itemId: string; tags: string[] }>;
}

async function applyAiAutotagsToImportedItems(importSourceId: string, itemIds: string[], rules: TagRule[]): Promise<number> {
  const enabledRules = rules.filter((rule) => rule.enabled);
  const targetIds = uniqStrings(itemIds).slice(0, MAX_AI_AUTOTAG_ITEMS);
  if (targetIds.length === 0 || enabledRules.length === 0) return 0;

  const items = await prisma.importedItem.findMany({
    where: { importSourceId, id: { in: targetIds } },
    orderBy: { updatedAt: 'desc' },
    take: MAX_AI_AUTOTAG_ITEMS,
  });
  if (items.length === 0) return 0;

  const allowedTags = new Set(enabledRules.map((rule) => rule.name));
  const allowedItemIds = new Set(items.map((item) => item.id));
  const requestId = createRequestId('import-autotag-ai');
  const startedAt = Date.now();

  try {
    console.info(`[${requestId}] OpenAI request started: import autotagging`, {
      provider: config.aiApiProvider,
      baseURL: config.openaiBaseUrl || 'https://api.openai.com/v1',
      model: config.openaiImportModel,
      items: items.length,
      rules: enabledRules.length,
      proxyUsed: Boolean(config.httpsProxy && config.aiApiProvider !== 'proxyapi'),
    });

    const response = await withTimeout(
      openai.chat.completions.create({
        model: config.openaiImportModel,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: [
              'Ты размечаешь импортированные элементы тегами по правилам.',
              'Верни только JSON вида {"items":[{"itemId":"...","tags":["..."]}]}',
              'Используй только имена тегов из rules[].name. Если правило не подходит, не добавляй тег.',
              'Не придумывай новые теги и не меняй itemId.',
            ].join(' '),
          },
          {
            role: 'user',
            content: JSON.stringify({
              task: `Autotag up to ${MAX_AI_AUTOTAG_ITEMS} already imported items by the provided rules.`,
              rules: enabledRules.map((rule) => ({
                tag: rule.name,
                condition: rule.condition,
              })),
              items: items.map((item) => ({
                itemId: item.id,
                title: item.title,
                description: truncateText(item.description, 2500),
                normalizedData: limitRecordForPrompt(safeJsonParse<Record<string, unknown>>(item.normalizedDataJson, {})),
              })),
            }).slice(0, 18000),
          },
        ],
        temperature: 0,
        max_tokens: 800,
      }),
      AI_AUTOTAG_TIMEOUT_MS,
      `OpenAI import autotag request timed out after ${AI_AUTOTAG_TIMEOUT_MS}ms.`,
    );

    const parsed = JSON.parse(response.choices[0]?.message?.content || '{}');
    const results = normalizeAiAutotagResult(parsed, allowedTags, allowedItemIds);
    await Promise.all(results.map((result) => prisma.importedItem.update({
      where: { id: result.itemId },
      data: { tagsJson: JSON.stringify(result.tags) },
    })));
    console.info(`[${requestId}] OpenAI request completed in ${Date.now() - startedAt}ms: import autotagging`, {
      updatedItems: results.length,
    });
    return results.length;
  } catch (error) {
    console.warn(`[${requestId}] OpenAI request failed after ${Date.now() - startedAt}ms: import autotagging`, {
      endpoint: 'import run autotagging',
      openaiRequest: 'chat.completions.create',
      provider: config.aiApiProvider,
      baseURL: config.openaiBaseUrl || 'https://api.openai.com/v1',
      model: config.openaiImportModel,
      timeoutMs: AI_AUTOTAG_TIMEOUT_MS,
      error: error instanceof Error ? error.message : 'Unknown autotagging error',
    });
    return 0;
  }
}

function previewItems(items: unknown[], config: ImportAIConfig, rules: TagRule[]) {
  return items.slice(0, 5).map((item) => ({
    title: buildTitle(item, config),
    description: buildDescription(item, config),
    tags: applyTagRules(flattenObject(item), item, rules),
  }));
}

async function generateAiConfig(sampleItems: unknown[]): Promise<ImportAIConfig> {
  const fallback = normalizeConfig(null, sampleItems);
  const requestId = createRequestId('import-config-ai');
  const startedAt = Date.now();
  try {
    console.info(`[${requestId}] OpenAI request started: import config generation`);
    const response = await withTimeout(
      openai.chat.completions.create({
        model: config.openaiImportModel,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: 'Return only JSON ImportAIConfig. Do not return code. Fields must reference flattened dot-paths from the sample.',
          },
          {
            role: 'user',
            content: JSON.stringify({
              task: 'Analyze data sample and create safe import config.',
              schema: {
                entityType: 'string',
                externalIdField: 'string|null',
                titleFields: 'string[]',
                descriptionFields: 'string[]',
                fieldLabels: 'Record<string,string>',
                importantFields: 'string[]',
                ignoredFields: 'string[]',
              },
              sampleItems,
            }).slice(0, 12000),
          },
        ],
        temperature: 0.1,
        max_tokens: 800,
      }),
      AI_CONFIG_TIMEOUT_MS,
      `OpenAI import config request timed out after ${AI_CONFIG_TIMEOUT_MS}ms.`,
    );
    console.info(`[${requestId}] OpenAI request completed in ${Date.now() - startedAt}ms: import config generation`);
    return normalizeConfig(JSON.parse(response.choices[0]?.message?.content || '{}'), sampleItems);
  } catch (error) {
    console.warn(`[${requestId}] OpenAI request failed after ${Date.now() - startedAt}ms: import config generation`, error);
    return fallback;
  }
}

async function analyzeSourceUrl(url: string) {
  const text = await fetchSourceText(url);
  const format = detectFormat(text, url);
  const found = format === 'xml'
    ? extractXmlSampleItems(text, MAX_SAMPLE_ITEMS)
    : findBestItemsPath(parseSource(text, format));
  if (!found) throw new Error('Не удалось найти массив элементов в источнике.');
  const sampleItems = found.items.slice(0, MAX_SAMPLE_ITEMS);
  if (sampleItems.length === 0) throw new Error('Не удалось найти массив элементов в источнике.');
  const aiConfig = await generateAiConfig(sampleItems);
  return {
    format,
    itemsPath: found.path,
    sampleItems,
    aiConfig,
    previewItems: previewItems(sampleItems, aiConfig, []),
  };
}

function normalizeImportSource(source: ImportSourceWithCount | (Prisma.ImportSourceGetPayload<{ include?: never }> & { _count?: { items: number }; holding?: { name: string } | null })) {
  return {
    id: source.id,
    holdingId: source.holdingId ?? null,
    holdingName: source.holding?.name ?? null,
    name: source.name,
    url: source.url,
    format: source.format as ImportFormat,
    status: source.status as ImportStatus,
    schedule: source.schedule,
    itemsPath: source.itemsPath,
    entityType: source.entityType,
    aiConfig: safeJsonParse<ImportAIConfig>(source.aiConfigJson, normalizeConfig(null, [])),
    tagRules: safeJsonParse<TagRule[]>(source.tagRulesJson, []),
    lastRunAt: source.lastRunAt,
    lastError: source.lastError,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
    itemsCount: source._count?.items ?? 0,
  };
}

function normalizeImportedItem(item: Prisma.ImportedItemGetPayload<{}>) {
  return {
    id: item.id,
    importSourceId: item.importSourceId,
    externalId: item.externalId,
    title: item.title,
    description: item.description,
    rawData: safeJsonParse(item.rawDataJson, null),
    normalizedData: safeJsonParse(item.normalizedDataJson, {}),
    tags: safeJsonParse<string[]>(item.tagsJson, []),
    contentHash: item.contentHash,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

function normalizeImportedItemWithSource(item: ImportedItemWithSource) {
  return {
    ...normalizeImportedItem(item),
    importSourceName: item.importSource.name,
    importSourceFormat: item.importSource.format as ImportFormat,
    holdingId: item.importSource.holdingId,
    holdingName: item.importSource.holding?.name ?? null,
  };
}

function normalizeImportRun(run: Prisma.ImportRunGetPayload<{}>) {
  return {
    id: run.id,
    importSourceId: run.importSourceId,
    status: run.status as ImportRunStatus,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    totalItems: run.totalItems,
    createdItems: run.createdItems,
    updatedItems: run.updatedItems,
    skippedItems: run.skippedItems,
    errorMessage: run.errorMessage,
  };
}

export async function handleAnalyzeImportSource(req: Request, res: Response): Promise<void> {
  try {
    const url = assertSafeSourceUrl((req.body || {}).url);
    res.json(await analyzeSourceUrl(url));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Не удалось проанализировать источник.' });
  }
}

export async function handleGenerateImportTagRule(req: Request, res: Response): Promise<void> {
  const body = (req.body || {}) as Record<string, unknown>;
  const text = parseString(body.text);
  const availableFields = Array.isArray(body.availableFields) ? body.availableFields.map(String) : [];
  let aiRawContent: string | null = null;
  let aiParsedJson: unknown = null;
  let aiNormalizedRule: TagRule | null = null;
  let aiValidationReason: string | null = null;
  if (!text) {
    res.status(400).json({ error: 'Опишите правило.' });
    return;
  }
  const heuristicRule = generateTagRuleHeuristic(text, availableFields);
  if (heuristicRule) {
    res.json({ name: heuristicRule.name, enabled: heuristicRule.enabled, condition: heuristicRule.condition });
    return;
  }
  try {
    const requestId = createRequestId('tag-rule-ai');
    const startedAt = Date.now();
    console.info(`[${requestId}] OpenAI request started: tag rule generation`, {
      provider: config.aiApiProvider,
      baseURL: config.openaiBaseUrl || 'https://api.openai.com/v1',
      model: config.openaiImportModel,
      proxyUsed: Boolean(config.httpsProxy && config.aiApiProvider !== 'proxyapi'),
    });
    const response = await withTimeout(
      openai.chat.completions.create({
        model: config.openaiImportModel,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: [
              'Return JSON tag rule only: {name, condition:{field, operator, value}}. No code.',
              'The name must be a short, clear Russian tag name.',
              'Do not use the words "тег" or "tag" in the name.',
              'Do not return English tag names.',
              'Examples: "Новые машины", "С пробегом", "Кредит", "Премиум".',
            ].join(' '),
          },
          { role: 'user', content: JSON.stringify({ text, availableFields, operators: Array.from(TAG_OPERATORS) }) },
        ],
        temperature: 0,
        max_tokens: 300,
      }),
      AI_TAG_RULE_TIMEOUT_MS,
      `OpenAI tag rule request timed out after ${AI_TAG_RULE_TIMEOUT_MS}ms.`,
    );
    console.info(`[${requestId}] OpenAI request completed in ${Date.now() - startedAt}ms: tag rule generation`);
    aiRawContent = response.choices[0]?.message?.content || '';
    aiParsedJson = JSON.parse(aiRawContent || '{}');
    const rule = normalizeTagRules([{ id: 'rule-1', ...(aiParsedJson && typeof aiParsedJson === 'object' ? aiParsedJson : {}) }])[0];
    aiNormalizedRule = rule ?? null;
    if (!rule) {
      aiValidationReason = 'Не удалось привести ответ AI к структуре {name, condition:{field, operator, value}}.';
      throw new Error('AI вернул некорректное правило.');
    }
    if (!availableFields.includes(rule.condition.field)) {
      aiValidationReason = `AI выбрал поле "${rule.condition.field}", которого нет в availableFields.`;
      throw new Error('AI вернул некорректное правило.');
    }
    const normalizedName = normalizeGeneratedTagName(rule.name);
    if (!isRussianTagName(normalizedName)) {
      aiValidationReason = `AI вернул название "${rule.name}", после нормализации "${normalizedName}". Нужно короткое русское название без слов "тег/tag".`;
      throw new Error('AI вернул некорректное название тега.');
    }
    res.json({ name: normalizedName, enabled: rule.enabled, condition: rule.condition });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Не удалось сформировать правило.';
    const isTimeout = message.toLowerCase().includes('timed out') || message.toLowerCase().includes('таймаут');
    const diagnostics = {
      endpoint: 'POST /api/imports/generate-tag-rule',
      openaiRequest: 'chat.completions.create',
      provider: config.aiApiProvider,
      baseURL: config.openaiBaseUrl || 'https://api.openai.com/v1',
      model: config.openaiImportModel,
      proxyUsed: Boolean(config.httpsProxy && config.aiApiProvider !== 'proxyapi'),
      timeoutMs: AI_TAG_RULE_TIMEOUT_MS,
      error: message,
      validationReason: aiValidationReason,
      availableFields,
      aiRawContent,
      aiParsedJson,
      aiNormalizedRule,
    };
    console.warn('Import tag rule AI failed:', {
      ...diagnostics,
      aiRawContent: aiRawContent ? aiRawContent.slice(0, 2000) : null,
    });
    res.status(400).json({
      error: isTimeout
        ? `Таймаут OpenAI на генерации правила тега (${AI_TAG_RULE_TIMEOUT_MS} мс). Endpoint: POST /api/imports/generate-tag-rule.`
        : message,
      details: diagnostics,
    });
  }
}

export async function handleGenerateImportTagRules(req: Request, res: Response): Promise<void> {
  const body = (req.body || {}) as Record<string, unknown>;
  const sampleItems = Array.isArray(body.sampleItems) ? body.sampleItems.slice(0, MAX_AI_AUTOTAG_ITEMS) : [];
  const availableFields = Array.isArray(body.availableFields) ? body.availableFields.map(String) : [];
  if (sampleItems.length === 0 || availableFields.length === 0) {
    res.status(400).json({ error: 'Нужны sample-элементы и список полей.' });
    return;
  }

  const compactItems = sampleItems.map((item, index) => ({
    itemIndex: index + 1,
    fields: limitRecordForPrompt(flattenObject(item), 50),
  }));
  const requestId = createRequestId('tag-rules-ai');
  const startedAt = Date.now();

  try {
    console.info(`[${requestId}] OpenAI request started: tag rules generation`, {
      provider: config.aiApiProvider,
      baseURL: config.openaiBaseUrl || 'https://api.openai.com/v1',
      model: config.openaiImportModel,
      items: compactItems.length,
      fields: availableFields.length,
      proxyUsed: Boolean(config.httpsProxy && config.aiApiProvider !== 'proxyapi'),
    });
    const response = await withTimeout(
      openai.chat.completions.create({
        model: config.openaiImportModel,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: [
              'Return only JSON: {"rules":[{"name":"...","condition":{"field":"...","operator":"...","value":...}}]}',
              `Create up to ${MAX_GENERATED_TAG_RULES} useful autotagging rules for imported business data when possible.`,
              'Use only fields from availableFields and only supported operators.',
              'Rule names must be short, clear Russian tag names.',
              'Do not use the words "тег" or "tag" in rule names.',
              'Do not return English rule names.',
              'Prefer broad, stable tags. Do not invent fields.',
              'Good names: "Новые машины", "С пробегом", "Кредит", "Премиум", "В наличии".',
            ].join(' '),
          },
          {
            role: 'user',
            content: JSON.stringify({
              task: `Generate up to ${MAX_GENERATED_TAG_RULES} autotagging rules from up to ${MAX_AI_AUTOTAG_ITEMS} imported sample items.`,
              availableFields,
              operators: Array.from(TAG_OPERATORS),
              sampleItems: compactItems,
            }).slice(0, 18000),
          },
        ],
        temperature: 0.1,
        max_tokens: 1600,
      }),
      AI_TAG_RULES_TIMEOUT_MS,
      `OpenAI tag rules request timed out after ${AI_TAG_RULES_TIMEOUT_MS}ms.`,
    );
    const rules = normalizeGeneratedTagRules(JSON.parse(response.choices[0]?.message?.content || '{}'), availableFields);
    if (rules.length === 0) throw new Error('AI не вернул применимые правила.');
    console.info(`[${requestId}] OpenAI request completed in ${Date.now() - startedAt}ms: tag rules generation`, {
      rules: rules.length,
    });
    res.json({ rules });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Не удалось сформировать правила.';
    console.warn(`[${requestId}] OpenAI request failed after ${Date.now() - startedAt}ms: tag rules generation`, {
      endpoint: 'POST /api/imports/generate-tag-rules',
      openaiRequest: 'chat.completions.create',
      provider: config.aiApiProvider,
      baseURL: config.openaiBaseUrl || 'https://api.openai.com/v1',
      model: config.openaiImportModel,
      timeoutMs: AI_TAG_RULES_TIMEOUT_MS,
      error: message,
    });
    res.status(400).json({ error: message });
  }
}

export async function handleTestImportTagRules(req: Request, res: Response): Promise<void> {
  const body = (req.body || {}) as Record<string, unknown>;
  const sampleItems = Array.isArray(body.sampleItems) ? body.sampleItems.slice(0, MAX_SAMPLE_ITEMS) : [];
  const rules = normalizeTagRules(body.tagRules);
  res.json({
    items: sampleItems.map((item) => ({
      item,
      tags: applyTagRules(flattenObject(item), item, rules),
    })),
  });
}

export async function handlePreviewImportConfig(req: Request, res: Response): Promise<void> {
  const body = (req.body || {}) as Record<string, unknown>;
  const config = normalizeConfig(body.aiConfig, Array.isArray(body.sampleItems) ? body.sampleItems : []);
  const rules = normalizeTagRules(body.tagRules);
  const sampleItems = Array.isArray(body.sampleItems) ? body.sampleItems : [];
  res.json({ previewItems: previewItems(sampleItems, config, rules) });
}

export async function handleListImports(req: Request, res: Response): Promise<void> {
  const where = await buildImportSourceWhereForRequest(req);
  const items = await prisma.importSource.findMany({
    where,
    include: { _count: { select: { items: true } }, holding: { select: { name: true } } },
    orderBy: { updatedAt: 'desc' },
  });
  res.json({ items: items.map(normalizeImportSource) });
}

export async function handleListImportedItems(req: Request, res: Response): Promise<void> {
  const limit = Math.min(Math.max(Number(req.query.limit || 25), 1), 100);
  const offset = Math.max(Number(req.query.offset || 0), 0);
  const sourceId = parseString(req.query.sourceId);
  const sourceWhere = await buildImportSourceWhereForRequest(req);
  const search = parseString(req.query.search);
  const tagFilters = parseTagFilters(req.query.tags);
  const where: Prisma.ImportedItemWhereInput = {};
  if (sourceId) where.importSourceId = sourceId;
  where.importSource = sourceWhere;
  if (search) {
    where.OR = [
      { title: { contains: search } },
      { description: { contains: search } },
      { rawDataJson: { contains: search } },
      { normalizedDataJson: { contains: search } },
    ];
  }
  if (tagFilters.length > 0) {
    const tagCandidateItems = await prisma.importedItem.findMany({
      where,
      include: { importSource: { select: { name: true, format: true, holdingId: true, holding: { select: { name: true } } } } },
      orderBy: { updatedAt: 'desc' },
    });
    const filteredItems = tagCandidateItems.filter((item) => {
      const tags = safeJsonParse<string[]>(item.tagsJson, []);
      return tagFilters.every((tag) => tags.includes(tag));
    });
    res.json({
      items: filteredItems.slice(offset, offset + limit).map(normalizeImportedItemWithSource),
      total: filteredItems.length,
      limit,
      offset,
    });
    return;
  }

  const [items, total] = await Promise.all([
    prisma.importedItem.findMany({
      where,
      include: { importSource: { select: { name: true, format: true, holdingId: true, holding: { select: { name: true } } } } },
      orderBy: { updatedAt: 'desc' },
      skip: offset,
      take: limit,
    }),
    prisma.importedItem.count({ where }),
  ]);
  res.json({ items: items.map(normalizeImportedItemWithSource), total, limit, offset });
}

export async function handleListImportedTags(req: Request, res: Response): Promise<void> {
  const holdingId = await getRequestedHoldingFilter(req);
  if (!holdingId) {
    res.json({ tags: [] });
    return;
  }
  const items = await prisma.importedItem.findMany({
    where: { importSource: { holdingId } },
    select: { tagsJson: true },
    take: 5000,
  });
  const tags = Array.from(new Set(items.flatMap((item) => safeJsonParse<string[]>(item.tagsJson, []))))
    .sort((a, b) => a.localeCompare(b, 'ru'));
  res.json({ tags });
}

export async function handleGetImport(req: Request, res: Response): Promise<void> {
  const id = String(req.params.id || '').trim();
  try {
    await assertCanAccessImportSource(req, id);
  } catch (error) {
    res.status(error instanceof Error && error.message === 'Импорт не найден.' ? 404 : 403).json({ error: error instanceof Error ? error.message : 'Нет доступа к импорту.' });
    return;
  }
  const source = await prisma.importSource.findUnique({
    where: { id },
    include: { _count: { select: { items: true } }, holding: { select: { name: true } } },
  });
  if (!source) {
    res.status(404).json({ error: 'Импорт не найден.' });
    return;
  }
  const [items, runs] = await Promise.all([
    prisma.importedItem.findMany({ where: { importSourceId: id }, orderBy: { updatedAt: 'desc' }, take: 30 }),
    prisma.importRun.findMany({ where: { importSourceId: id }, orderBy: { startedAt: 'desc' }, take: 20 }),
  ]);
  res.json({
    item: normalizeImportSource(source),
    importedItems: items.map(normalizeImportedItem),
    runs: runs.map(normalizeImportRun),
  });
}

export async function handleCreateImport(req: Request, res: Response): Promise<void> {
  const body = (req.body || {}) as Record<string, unknown>;
  const name = parseString(body.name);
  const url = assertSafeSourceUrl(body.url);
  const format = parseString(body.format) as ImportFormat | null;
  const itemsPath = parseString(body.itemsPath);
  const holdingId = parseString(body.holdingId);
  const aiConfig = normalizeConfig(body.aiConfig, []);
  const tagRules = normalizeTagRules(body.tagRules);
  if (!name || !format || !itemsPath || !holdingId) {
    res.status(400).json({ error: 'Название, компания, формат и путь элементов обязательны.' });
    return;
  }
  try {
    await assertCanAccessHolding(req, holdingId);
  } catch (error) {
    res.status(403).json({ error: error instanceof Error ? error.message : 'Нет доступа к выбранной компании.' });
    return;
  }
  if (!['json', 'xml', 'csv'].includes(format)) {
    res.status(400).json({ error: 'Некорректный формат источника.' });
    return;
  }
  const created = await prisma.importSource.create({
    data: {
      holdingId,
      name,
      url,
      format,
      status: 'active',
      schedule: parseString(body.schedule),
      itemsPath,
      entityType: aiConfig.entityType,
      aiConfigJson: JSON.stringify(aiConfig),
      tagRulesJson: JSON.stringify(tagRules),
    },
    include: { _count: { select: { items: true } }, holding: { select: { name: true } } },
  });
  await runImport(created.id);
  const createdWithItems = await prisma.importSource.findUnique({
    where: { id: created.id },
    include: { _count: { select: { items: true } }, holding: { select: { name: true } } },
  });
  res.status(201).json({ item: normalizeImportSource(createdWithItems || created) });
}

export async function handleUpdateImport(req: Request, res: Response): Promise<void> {
  const id = String(req.params.id || '').trim();
  try {
    await assertCanAccessImportSource(req, id);
  } catch (error) {
    res.status(error instanceof Error && error.message === 'Импорт не найден.' ? 404 : 403).json({ error: error instanceof Error ? error.message : 'Нет доступа к импорту.' });
    return;
  }
  const body = (req.body || {}) as Record<string, unknown>;
  const data: Prisma.ImportSourceUpdateInput = {};
  if (body.name != null) data.name = parseString(body.name) || undefined;
  if (body.url != null) data.url = assertSafeSourceUrl(body.url);
  if (body.status != null) {
    const status = parseString(body.status);
    if (!status || !['active', 'paused', 'error'].includes(status)) {
      res.status(400).json({ error: 'Некорректный статус импорта.' });
      return;
    }
    data.status = status;
  }
  if (body.schedule !== undefined) data.schedule = parseString(body.schedule);
  if (body.holdingId !== undefined) {
    const holdingId = parseString(body.holdingId);
    if (holdingId) {
      try {
        await assertCanAccessHolding(req, holdingId);
      } catch (error) {
        res.status(403).json({ error: error instanceof Error ? error.message : 'Нет доступа к выбранной компании.' });
        return;
      }
      data.holding = { connect: { id: holdingId } };
    } else {
      data.holding = { disconnect: true };
    }
  }
  if (body.aiConfig != null) {
    const config = normalizeConfig(body.aiConfig, []);
    data.aiConfigJson = JSON.stringify(config);
    data.entityType = config.entityType;
  }
  if (body.tagRules != null) data.tagRulesJson = JSON.stringify(normalizeTagRules(body.tagRules));
  const updated = await prisma.importSource.update({
    where: { id },
    data,
    include: { _count: { select: { items: true } }, holding: { select: { name: true } } },
  });
  res.json({ item: normalizeImportSource(updated) });
}

export async function handleDeleteImport(req: Request, res: Response): Promise<void> {
  const id = String(req.params.id || '').trim();
  try {
    await assertCanAccessImportSource(req, id);
  } catch (error) {
    res.status(error instanceof Error && error.message === 'Импорт не найден.' ? 404 : 403).json({ error: error instanceof Error ? error.message : 'Нет доступа к импорту.' });
    return;
  }
  await prisma.importSource.delete({ where: { id } });
  res.json({ success: true });
}

export async function runImport(importSourceId: string) {
  const source = await prisma.importSource.findUnique({ where: { id: importSourceId } });
  if (!source) throw new Error('Импорт не найден.');
  const run = await prisma.importRun.create({ data: { importSourceId, status: 'running' } });
  try {
    const text = await fetchSourceText(source.url);
    const format = source.format as ImportFormat;
    const xmlItems = format === 'xml' ? extractXmlItemsByPath(text, source.itemsPath, MAX_RUN_ITEMS) : null;
    const parsed = xmlItems ? null : parseSource(text, format);
    const rawItems = xmlItems ? xmlItems.items : getByPath(parsed, source.itemsPath);
    const totalRawItems = xmlItems?.totalItems ?? (Array.isArray(rawItems) ? rawItems.length : 0);
    const items = Array.isArray(rawItems) ? rawItems.slice(0, MAX_RUN_ITEMS) : [];
    const config = safeJsonParse<ImportAIConfig>(source.aiConfigJson, normalizeConfig(null, []));
    const rules = normalizeTagRules(safeJsonParse(source.tagRulesJson, []));
    let createdItems = 0;
    let updatedItems = 0;
    const processedItemIds: string[] = [];
    for (const item of items) {
      const normalizedData = flattenObject(item);
      const externalId = config.externalIdField ? valueToText(normalizedData[config.externalIdField]) || null : null;
      const title = buildTitle(item, config);
      const description = buildDescription(item, config);
      const tags = applyTagRules(normalizedData, item, rules);
      const contentHash = crypto.createHash('sha256').update(JSON.stringify({ externalId, normalizedData })).digest('hex');
      const existing = await prisma.importedItem.findFirst({
        where: externalId
          ? { importSourceId, externalId }
          : { importSourceId, contentHash },
        select: { id: true },
      });
      if (existing) {
        const updated = await prisma.importedItem.update({
          where: { id: existing.id },
          data: {
            externalId,
            title,
            description,
            rawDataJson: JSON.stringify(item),
            normalizedDataJson: JSON.stringify(normalizedData),
            tagsJson: JSON.stringify(tags),
            contentHash,
          },
        });
        if (processedItemIds.length < MAX_AI_AUTOTAG_ITEMS) processedItemIds.push(updated.id);
        updatedItems += 1;
      } else {
        const created = await prisma.importedItem.create({
          data: {
            importSourceId,
            externalId,
            title,
            description,
            rawDataJson: JSON.stringify(item),
            normalizedDataJson: JSON.stringify(normalizedData),
            tagsJson: JSON.stringify(tags),
            contentHash,
          },
        });
        if (processedItemIds.length < MAX_AI_AUTOTAG_ITEMS) processedItemIds.push(created.id);
        createdItems += 1;
      }
    }
    await applyAiAutotagsToImportedItems(importSourceId, processedItemIds, rules);
    const finished = await prisma.importRun.update({
      where: { id: run.id },
      data: {
        status: 'success',
        finishedAt: new Date(),
        totalItems: items.length,
        createdItems,
        updatedItems,
        skippedItems: Math.max(0, totalRawItems - items.length),
      },
    });
    await prisma.importSource.update({
      where: { id: importSourceId },
      data: { lastRunAt: new Date(), lastError: null, status: 'active' },
    });
    return normalizeImportRun(finished);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Ошибка запуска импорта.';
    const finished = await prisma.importRun.update({
      where: { id: run.id },
      data: { status: 'error', finishedAt: new Date(), errorMessage: message },
    });
    await prisma.importSource.update({
      where: { id: importSourceId },
      data: { lastRunAt: new Date(), lastError: message, status: 'error' },
    }).catch(() => {});
    return normalizeImportRun(finished);
  }
}

export async function handleRunImport(req: Request, res: Response): Promise<void> {
  const id = String(req.params.id || '').trim();
  try {
    await assertCanAccessImportSource(req, id);
  } catch (error) {
    res.status(error instanceof Error && error.message === 'Импорт не найден.' ? 404 : 403).json({ error: error instanceof Error ? error.message : 'Нет доступа к импорту.' });
    return;
  }
  res.json({ run: await runImport(id) });
}
