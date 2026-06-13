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

function normalizeImportSource(source: Prisma.ImportSourceGetPayload<{ include?: never }> & { _count?: { items: number } }) {
  return {
    id: source.id,
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

function normalizeImportedItemWithSource(item: Prisma.ImportedItemGetPayload<{ include: { importSource: { select: { name: true; format: true } } } }>) {
  return {
    ...normalizeImportedItem(item),
    importSourceName: item.importSource.name,
    importSourceFormat: item.importSource.format as ImportFormat,
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
          { role: 'system', content: 'Return JSON tag rule only: {name, condition:{field, operator, value}}. No code.' },
          { role: 'user', content: JSON.stringify({ text, availableFields, operators: Array.from(TAG_OPERATORS) }) },
        ],
        temperature: 0,
        max_tokens: 300,
      }),
      AI_TAG_RULE_TIMEOUT_MS,
      `OpenAI tag rule request timed out after ${AI_TAG_RULE_TIMEOUT_MS}ms.`,
    );
    console.info(`[${requestId}] OpenAI request completed in ${Date.now() - startedAt}ms: tag rule generation`);
    const rule = normalizeTagRules([{ id: 'rule-1', ...JSON.parse(response.choices[0]?.message?.content || '{}') }])[0];
    if (!rule || !availableFields.includes(rule.condition.field)) throw new Error('AI вернул некорректное правило.');
    res.json({ name: rule.name, enabled: rule.enabled, condition: rule.condition });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Не удалось сформировать правило.';
    console.warn('Import tag rule AI failed:', {
      endpoint: 'POST /api/imports/generate-tag-rule',
      openaiRequest: 'chat.completions.create',
      provider: config.aiApiProvider,
      baseURL: config.openaiBaseUrl || 'https://api.openai.com/v1',
      model: config.openaiImportModel,
      proxyUsed: Boolean(config.httpsProxy && config.aiApiProvider !== 'proxyapi'),
      timeoutMs: AI_TAG_RULE_TIMEOUT_MS,
      error: message,
    });
    res.status(400).json({
      error: `Таймаут OpenAI на генерации правила тега (${AI_TAG_RULE_TIMEOUT_MS} мс). Endpoint: POST /api/imports/generate-tag-rule.`,
      details: {
        endpoint: 'POST /api/imports/generate-tag-rule',
        openaiRequest: 'chat.completions.create',
        provider: config.aiApiProvider,
        baseURL: config.openaiBaseUrl || 'https://api.openai.com/v1',
        model: config.openaiImportModel,
        proxyUsed: Boolean(config.httpsProxy && config.aiApiProvider !== 'proxyapi'),
        timeoutMs: AI_TAG_RULE_TIMEOUT_MS,
        error: message,
      },
    });
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

export async function handleListImports(_req: Request, res: Response): Promise<void> {
  const items = await prisma.importSource.findMany({
    include: { _count: { select: { items: true } } },
    orderBy: { updatedAt: 'desc' },
  });
  res.json({ items: items.map(normalizeImportSource) });
}

export async function handleListImportedItems(req: Request, res: Response): Promise<void> {
  const limit = Math.min(Math.max(Number(req.query.limit || 100), 1), 500);
  const sourceId = parseString(req.query.sourceId);
  const items = await prisma.importedItem.findMany({
    where: sourceId ? { importSourceId: sourceId } : undefined,
    include: { importSource: { select: { name: true, format: true } } },
    orderBy: { updatedAt: 'desc' },
    take: limit,
  });
  res.json({ items: items.map(normalizeImportedItemWithSource) });
}

export async function handleGetImport(req: Request, res: Response): Promise<void> {
  const id = String(req.params.id || '').trim();
  const source = await prisma.importSource.findUnique({
    where: { id },
    include: { _count: { select: { items: true } } },
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
  const aiConfig = normalizeConfig(body.aiConfig, []);
  const tagRules = normalizeTagRules(body.tagRules);
  if (!name || !format || !itemsPath) {
    res.status(400).json({ error: 'Название, формат и путь элементов обязательны.' });
    return;
  }
  if (!['json', 'xml', 'csv'].includes(format)) {
    res.status(400).json({ error: 'Некорректный формат источника.' });
    return;
  }
  const created = await prisma.importSource.create({
    data: {
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
    include: { _count: { select: { items: true } } },
  });
  res.status(201).json({ item: normalizeImportSource(created) });
}

export async function handleUpdateImport(req: Request, res: Response): Promise<void> {
  const id = String(req.params.id || '').trim();
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
  if (body.aiConfig != null) {
    const config = normalizeConfig(body.aiConfig, []);
    data.aiConfigJson = JSON.stringify(config);
    data.entityType = config.entityType;
  }
  if (body.tagRules != null) data.tagRulesJson = JSON.stringify(normalizeTagRules(body.tagRules));
  const updated = await prisma.importSource.update({
    where: { id },
    data,
    include: { _count: { select: { items: true } } },
  });
  res.json({ item: normalizeImportSource(updated) });
}

export async function handleDeleteImport(req: Request, res: Response): Promise<void> {
  const id = String(req.params.id || '').trim();
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
        await prisma.importedItem.update({
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
        updatedItems += 1;
      } else {
        await prisma.importedItem.create({
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
        createdItems += 1;
      }
    }
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
  res.json({ run: await runImport(id) });
}
