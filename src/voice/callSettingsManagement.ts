import type { Request, Response } from 'express';
import type { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { addCall, setVoxSessionId } from './callHistory';
import { startVoiceCall } from './startVoiceCall';

type CustomerTemperament = 'calm' | 'doubtful' | 'irritated' | 'hurried';
type CustomerPatience = 'low' | 'medium' | 'high';
type ReplyLength = 'short' | 'medium' | 'detailed';
type CallPlanTargetType = 'employees' | 'dealerships';
type CallPlanFrequency = 'daily' | 'weekly';

const TEMPERAMENTS = new Set<CustomerTemperament>(['calm', 'doubtful', 'irritated', 'hurried']);
const PATIENCE = new Set<CustomerPatience>(['low', 'medium', 'high']);
const REPLY_LENGTHS = new Set<ReplyLength>(['short', 'medium', 'detailed']);
const VOICES = new Set(['marin', 'cedar', 'sage', 'ash', 'verse', 'coral', 'nova', 'echo']);
const CALL_PLAN_TARGET_TYPES = new Set<CallPlanTargetType>(['employees', 'dealerships']);
const CALL_PLAN_FREQUENCIES = new Set<CallPlanFrequency>(['daily', 'weekly']);
const TIME_RE = /^([01]\d|2[0-2]):([0-5]\d)$/;

function parseString(value: unknown): string | null {
  const parsed = String(value ?? '').trim();
  return parsed ? parsed : null;
}

function parseStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || '').trim()).filter(Boolean);
}

function safeJsonParse<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
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

async function getRequestedHoldingId(req: Request): Promise<string> {
  const holdingId = parseString(req.query.holdingId ?? (req.body as Record<string, unknown> | undefined)?.holdingId);
  if (!holdingId) throw new Error('Компания обязательна.');
  await assertCanAccessHolding(req, holdingId);
  return holdingId;
}

async function assertCanAccessProfile(req: Request, id: string): Promise<string> {
  const item = await prisma.callCustomerProfile.findUnique({ where: { id }, select: { holdingId: true } });
  if (!item) throw new Error('Профиль клиента не найден.');
  await assertCanAccessHolding(req, item.holdingId);
  return item.holdingId;
}

async function assertCanAccessScript(req: Request, id: string): Promise<string> {
  const item = await prisma.callScript.findUnique({ where: { id }, select: { holdingId: true } });
  if (!item) throw new Error('Скрипт не найден.');
  await assertCanAccessHolding(req, item.holdingId);
  return item.holdingId;
}

async function assertCanAccessPlan(req: Request, id: string): Promise<string> {
  const item = await prisma.callPlan.findUnique({ where: { id }, select: { holdingId: true } });
  if (!item) throw new Error('План прозвона не найден.');
  await assertCanAccessHolding(req, item.holdingId);
  return item.holdingId;
}

function normalizeProfile(profile: Prisma.CallCustomerProfileGetPayload<{}>) {
  return {
    id: profile.id,
    holdingId: profile.holdingId,
    name: profile.name,
    voiceId: profile.voiceId,
    age: profile.age,
    character: profile.character,
    temperament: profile.temperament,
    patience: profile.patience,
    replyLength: profile.replyLength,
    communicationStyle: profile.communicationStyle,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  };
}

function normalizeScript(script: Prisma.CallScriptGetPayload<{}>) {
  return {
    id: script.id,
    holdingId: script.holdingId,
    name: script.name,
    profileIds: safeJsonParse<string[]>(script.profileIdsJson, []),
    context: script.context,
    dataCondition: safeJsonParse(script.dataConditionJson, { holdingId: script.holdingId, tags: [] }),
    objections: safeJsonParse(script.objectionsJson, []),
    questions: safeJsonParse(script.questionsJson, []),
    successCriteria: safeJsonParse(script.successCriteriaJson, []),
    createdAt: script.createdAt,
    updatedAt: script.updatedAt,
  };
}

function normalizePlan(plan: Prisma.CallPlanGetPayload<{}>) {
  return {
    id: plan.id,
    holdingId: plan.holdingId,
    name: plan.name,
    targetType: plan.targetType,
    targetIds: safeJsonParse<string[]>(plan.targetIdsJson, []),
    scriptId: plan.scriptId,
    phoneNumberTypeId: plan.phoneNumberTypeId,
    frequency: plan.frequency,
    callTimeFrom: plan.callTimeFrom,
    callTimeTo: plan.callTimeTo,
    lastInitiatedAt: plan.lastInitiatedAt,
    lastBatchId: plan.lastBatchId,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
  };
}

function normalizePlanCall(call: Prisma.CallPlanCallGetPayload<{}>) {
  return {
    id: call.id,
    planId: call.planId,
    callId: call.callId,
    employeeId: call.employeeId,
    employeeName: call.employeeName,
    dealershipId: call.dealershipId,
    dealershipName: call.dealershipName,
    phone: call.phone,
    phoneNumberTypeId: call.phoneNumberTypeId,
    scriptId: call.scriptId,
    profileId: call.profileId,
    importedItemId: call.importedItemId,
    status: call.status,
    outcome: call.outcome,
    startedAt: call.startedAt,
    endedAt: call.endedAt,
    transcript: safeJsonParse(call.transcriptJson, []),
    evaluation: safeJsonParse(call.evaluationJson, null),
    totalScore: call.totalScore,
    failureReason: call.failureReason,
    createdAt: call.createdAt,
    updatedAt: call.updatedAt,
  };
}

function labelForTemperament(value: string): string {
  if (value === 'calm') return 'спокойный';
  if (value === 'doubtful') return 'сомневающийся';
  if (value === 'irritated') return 'раздражённый';
  if (value === 'hurried') return 'торопящийся';
  return value || 'реалистичный';
}

function labelForPatience(value: string): string {
  if (value === 'low') return 'низкое';
  if (value === 'medium') return 'среднее';
  if (value === 'high') return 'высокое';
  return value || 'среднее';
}

function labelForReplyLength(value: string): string {
  if (value === 'short') return 'короткие';
  if (value === 'medium') return 'средние';
  if (value === 'detailed') return 'подробные';
  return value || 'средние';
}

function pickRandom<T>(items: T[]): T | null {
  if (items.length === 0) return null;
  return items[Math.floor(Math.random() * items.length)] ?? null;
}

function parseProfilePayload(body: Record<string, unknown>) {
  const name = parseString(body.name);
  const voiceId = parseString(body.voiceId) || 'marin';
  const age = Math.max(18, Math.min(65, Number(body.age || 35)));
  const temperament = parseString(body.temperament) as CustomerTemperament | null;
  const patience = parseString(body.patience) as CustomerPatience | null;
  const replyLength = parseString(body.replyLength) as ReplyLength | null;
  if (!name) throw new Error('Название профиля обязательно.');
  if (!VOICES.has(voiceId)) throw new Error('Некорректный голос.');
  if (!temperament || !TEMPERAMENTS.has(temperament)) throw new Error('Некорректный темперамент.');
  if (!patience || !PATIENCE.has(patience)) throw new Error('Некорректное терпение клиента.');
  if (!replyLength || !REPLY_LENGTHS.has(replyLength)) throw new Error('Некорректная длина реплик.');
  return {
    name,
    voiceId,
    age,
    character: parseString(body.character) || '',
    temperament,
    patience,
    replyLength,
    communicationStyle: parseString(body.communicationStyle) || '',
  };
}

function parseScriptPayload(body: Record<string, unknown>, holdingId: string) {
  const name = parseString(body.name);
  if (!name) throw new Error('Название скрипта обязательно.');
  const dataCondition = body.dataCondition && typeof body.dataCondition === 'object'
    ? body.dataCondition as Record<string, unknown>
    : {};
  const tags = parseStringArray(dataCondition.tags);
  return {
    name,
    profileIdsJson: JSON.stringify(parseStringArray(body.profileIds)),
    context: parseString(body.context) || '',
    dataConditionJson: JSON.stringify({ holdingId, tags }),
    objectionsJson: JSON.stringify(Array.isArray(body.objections) ? body.objections : []),
    questionsJson: JSON.stringify(Array.isArray(body.questions) ? body.questions : []),
    successCriteriaJson: JSON.stringify(Array.isArray(body.successCriteria) ? body.successCriteria : []),
  };
}

function timeToMinutes(value: string): number {
  const [, hours, minutes] = value.match(TIME_RE) || [];
  return Number(hours) * 60 + Number(minutes);
}

function parsePlanPayload(body: Record<string, unknown>, holdingId: string) {
  const targetType = parseString(body.targetType) as CallPlanTargetType | null;
  const frequency = parseString(body.frequency) as CallPlanFrequency | null;
  const targetIds = parseStringArray(body.targetIds);
  const scriptId = parseString(body.scriptId);
  const phoneNumberTypeId = parseString(body.phoneNumberTypeId);
  const callTimeFrom = parseString(body.callTimeFrom) || '';
  const callTimeTo = parseString(body.callTimeTo) || '';
  if (!targetType || !CALL_PLAN_TARGET_TYPES.has(targetType)) throw new Error('Выберите тип прозвона.');
  if (targetIds.length === 0) throw new Error('Выберите сотрудников или точки.');
  if (!scriptId) throw new Error('Выберите скрипт.');
  if (!phoneNumberTypeId) throw new Error('Выберите тип номера.');
  if (!frequency || !CALL_PLAN_FREQUENCIES.has(frequency)) throw new Error('Выберите частотность.');
  if (!TIME_RE.test(callTimeFrom) || !TIME_RE.test(callTimeTo)) throw new Error('Укажите время звонка с 09:00 до 22:00.');
  const fromMinutes = timeToMinutes(callTimeFrom);
  const toMinutes = timeToMinutes(callTimeTo);
  if (fromMinutes < 9 * 60 || toMinutes > 22 * 60 || toMinutes - fromMinutes < 15) {
    throw new Error('Диапазон времени должен быть с 09:00 до 22:00, минимум 15 минут.');
  }
  return {
    name: parseString(body.name) || (targetType === 'employees' ? 'Обзвон сотрудников' : 'Обзвон точек'),
    targetType,
    targetIdsJson: JSON.stringify(targetIds),
    scriptId,
    phoneNumberTypeId,
    frequency,
    callTimeFrom,
    callTimeTo,
    holdingId,
  };
}

async function assertPlanReferences(holdingId: string, payload: ReturnType<typeof parsePlanPayload>): Promise<void> {
  const script = await prisma.callScript.findFirst({ where: { id: payload.scriptId, holdingId }, select: { id: true } });
  if (!script) throw new Error('Выбранный скрипт не найден в этой компании.');
  const phoneType = await prisma.phoneNumberType.findFirst({ where: { id: payload.phoneNumberTypeId, ownership: 'user', isActive: true }, select: { id: true } });
  if (!phoneType) throw new Error('Выбранный тип номера сотрудников не найден.');
  const targetIds = safeJsonParse<string[]>(payload.targetIdsJson, []);
  if (payload.targetType === 'employees') {
    const count = await prisma.managerProfile.count({ where: { id: { in: targetIds }, dealership: { holdingId } } });
    if (count !== targetIds.length) throw new Error('В выборке есть сотрудники вне выбранной компании.');
  } else {
    const count = await prisma.dealership.count({ where: { id: { in: targetIds }, holdingId } });
    if (count !== targetIds.length) throw new Error('В выборке есть точки вне выбранной компании.');
  }
}

export async function handleListCallCustomerProfiles(req: Request, res: Response): Promise<void> {
  try {
    const holdingId = await getRequestedHoldingId(req);
    const items = await prisma.callCustomerProfile.findMany({ where: { holdingId }, orderBy: { updatedAt: 'desc' } });
    res.json({ items: items.map(normalizeProfile) });
  } catch (error) {
    res.status(error instanceof Error && error.message.includes('доступ') ? 403 : 400).json({ error: error instanceof Error ? error.message : 'Не удалось загрузить профили.' });
  }
}

export async function handleCreateCallCustomerProfile(req: Request, res: Response): Promise<void> {
  try {
    const holdingId = await getRequestedHoldingId(req);
    const data = parseProfilePayload((req.body || {}) as Record<string, unknown>);
    const created = await prisma.callCustomerProfile.create({ data: { holdingId, ...data } });
    res.status(201).json({ item: normalizeProfile(created) });
  } catch (error) {
    res.status(error instanceof Error && error.message.includes('доступ') ? 403 : 400).json({ error: error instanceof Error ? error.message : 'Не удалось создать профиль.' });
  }
}

export async function handleUpdateCallCustomerProfile(req: Request, res: Response): Promise<void> {
  try {
    const id = String(req.params.id || '').trim();
    await assertCanAccessProfile(req, id);
    const data = parseProfilePayload((req.body || {}) as Record<string, unknown>);
    const updated = await prisma.callCustomerProfile.update({ where: { id }, data });
    res.json({ item: normalizeProfile(updated) });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Не удалось обновить профиль.';
    res.status(message.includes('не найден') ? 404 : message.includes('доступ') ? 403 : 400).json({ error: message });
  }
}

export async function handleDeleteCallCustomerProfile(req: Request, res: Response): Promise<void> {
  try {
    const id = String(req.params.id || '').trim();
    const holdingId = await assertCanAccessProfile(req, id);
    await prisma.$transaction(async (tx) => {
      const scripts = await tx.callScript.findMany({ where: { holdingId }, select: { id: true, profileIdsJson: true } });
      await tx.callCustomerProfile.delete({ where: { id } });
      await Promise.all(scripts.map((script) => {
        const profileIds = safeJsonParse<string[]>(script.profileIdsJson, []);
        if (!profileIds.includes(id)) return Promise.resolve();
        return tx.callScript.update({
          where: { id: script.id },
          data: { profileIdsJson: JSON.stringify(profileIds.filter((profileId) => profileId !== id)) },
        });
      }));
    });
    res.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Не удалось удалить профиль.';
    res.status(message.includes('не найден') ? 404 : message.includes('доступ') ? 403 : 400).json({ error: message });
  }
}

export async function handleListCallScripts(req: Request, res: Response): Promise<void> {
  try {
    const holdingId = await getRequestedHoldingId(req);
    const items = await prisma.callScript.findMany({ where: { holdingId }, orderBy: { updatedAt: 'desc' } });
    res.json({ items: items.map(normalizeScript) });
  } catch (error) {
    res.status(error instanceof Error && error.message.includes('доступ') ? 403 : 400).json({ error: error instanceof Error ? error.message : 'Не удалось загрузить скрипты.' });
  }
}

export async function handleCreateCallScript(req: Request, res: Response): Promise<void> {
  try {
    const holdingId = await getRequestedHoldingId(req);
    const data = parseScriptPayload((req.body || {}) as Record<string, unknown>, holdingId);
    const created = await prisma.callScript.create({ data: { holdingId, ...data } });
    res.status(201).json({ item: normalizeScript(created) });
  } catch (error) {
    res.status(error instanceof Error && error.message.includes('доступ') ? 403 : 400).json({ error: error instanceof Error ? error.message : 'Не удалось создать скрипт.' });
  }
}

export async function handleUpdateCallScript(req: Request, res: Response): Promise<void> {
  try {
    const id = String(req.params.id || '').trim();
    const holdingId = await assertCanAccessScript(req, id);
    const data = parseScriptPayload((req.body || {}) as Record<string, unknown>, holdingId);
    const updated = await prisma.callScript.update({ where: { id }, data });
    res.json({ item: normalizeScript(updated) });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Не удалось обновить скрипт.';
    res.status(message.includes('не найден') ? 404 : message.includes('доступ') ? 403 : 400).json({ error: message });
  }
}

export async function handleDeleteCallScript(req: Request, res: Response): Promise<void> {
  try {
    const id = String(req.params.id || '').trim();
    await assertCanAccessScript(req, id);
    await prisma.callScript.delete({ where: { id } });
    res.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Не удалось удалить скрипт.';
    res.status(message.includes('не найден') ? 404 : message.includes('доступ') ? 403 : 400).json({ error: message });
  }
}

export async function handleGetCallPlanOptions(req: Request, res: Response): Promise<void> {
  try {
    const holdingId = await getRequestedHoldingId(req);
    const [employees, dealerships, phoneNumberTypes, scripts] = await Promise.all([
      prisma.managerProfile.findMany({
        where: { dealership: { holdingId }, status: 'active' },
        include: {
          dealership: true,
          account: { include: { phoneNumbers: { include: { type: true }, where: { isActive: true } } } },
        },
        orderBy: { fullName: 'asc' },
      }),
      prisma.dealership.findMany({
        where: { holdingId, isActive: true },
        include: { managerProfiles: { where: { status: 'active' }, select: { id: true } } },
        orderBy: { name: 'asc' },
      }),
      prisma.phoneNumberType.findMany({ where: { ownership: 'user', isActive: true }, orderBy: { name: 'asc' } }),
      prisma.callScript.findMany({ where: { holdingId }, orderBy: { name: 'asc' } }),
    ]);
    res.json({
      employees: employees.map((employee) => ({
        id: employee.id,
        accountId: employee.accountId,
        fullName: employee.fullName,
        email: employee.email,
        phone: employee.phone,
        dealershipId: employee.dealershipId,
        dealershipName: employee.dealership.name,
        phoneNumbers: employee.account?.phoneNumbers.map((phoneNumber) => ({
          id: phoneNumber.id,
          typeId: phoneNumber.typeId,
          typeName: phoneNumber.type.name,
          phone: phoneNumber.phone,
        })) ?? [],
      })),
      dealerships: dealerships.map((dealership) => ({
        id: dealership.id,
        name: dealership.name,
        city: dealership.city,
        address: dealership.address,
        employeesCount: dealership.managerProfiles.length,
      })),
      phoneNumberTypes: phoneNumberTypes.map((type) => ({
        id: type.id,
        name: type.name,
        ownership: type.ownership,
        isActive: type.isActive,
        createdAt: type.createdAt,
        updatedAt: type.updatedAt,
      })),
      scripts: scripts.map(normalizeScript),
    });
  } catch (error) {
    res.status(error instanceof Error && error.message.includes('доступ') ? 403 : 400).json({ error: error instanceof Error ? error.message : 'Не удалось загрузить данные плана.' });
  }
}

export async function handleListCallPlans(req: Request, res: Response): Promise<void> {
  try {
    const holdingId = await getRequestedHoldingId(req);
    const items = await prisma.callPlan.findMany({ where: { holdingId }, orderBy: { updatedAt: 'desc' } });
    res.json({ items: items.map(normalizePlan) });
  } catch (error) {
    res.status(error instanceof Error && error.message.includes('доступ') ? 403 : 400).json({ error: error instanceof Error ? error.message : 'Не удалось загрузить планы прозвона.' });
  }
}

export async function handleCreateCallPlan(req: Request, res: Response): Promise<void> {
  try {
    const holdingId = await getRequestedHoldingId(req);
    const data = parsePlanPayload((req.body || {}) as Record<string, unknown>, holdingId);
    await assertPlanReferences(holdingId, data);
    const created = await prisma.callPlan.create({ data });
    res.status(201).json({ item: normalizePlan(created) });
  } catch (error) {
    res.status(error instanceof Error && error.message.includes('доступ') ? 403 : 400).json({ error: error instanceof Error ? error.message : 'Не удалось создать план прозвона.' });
  }
}

export async function handleUpdateCallPlan(req: Request, res: Response): Promise<void> {
  try {
    const id = String(req.params.id || '').trim();
    const holdingId = await assertCanAccessPlan(req, id);
    const data = parsePlanPayload((req.body || {}) as Record<string, unknown>, holdingId);
    await assertPlanReferences(holdingId, data);
    const updated = await prisma.callPlan.update({ where: { id }, data });
    res.json({ item: normalizePlan(updated) });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Не удалось обновить план прозвона.';
    res.status(message.includes('не найден') ? 404 : message.includes('доступ') ? 403 : 400).json({ error: message });
  }
}

async function buildCallPlanTargets(plan: Prisma.CallPlanGetPayload<{}>) {
  const targetIds = safeJsonParse<string[]>(plan.targetIdsJson, []);
  const where: Prisma.ManagerProfileWhereInput = plan.targetType === 'employees'
    ? { id: { in: targetIds }, dealership: { holdingId: plan.holdingId } }
    : { dealershipId: { in: targetIds }, dealership: { holdingId: plan.holdingId } };
  const employees = await prisma.managerProfile.findMany({
    where,
    include: {
      dealership: true,
      account: {
        include: {
          phoneNumbers: {
            where: { typeId: plan.phoneNumberTypeId, isActive: true },
            include: { type: true },
          },
        },
      },
    },
    orderBy: { fullName: 'asc' },
  });
  return employees.flatMap((employee) => (employee.account?.phoneNumbers ?? []).map((phoneNumber) => ({
    employee,
    phoneNumber,
    dealershipId: employee.dealershipId,
    dealershipName: employee.dealership.name,
  })));
}

async function pickImportedSampleForScript(script: Prisma.CallScriptGetPayload<{}>) {
  const dataCondition = safeJsonParse<{ holdingId?: string | null; tags?: string[] }>(script.dataConditionJson, { holdingId: script.holdingId, tags: [] });
  const tags = Array.isArray(dataCondition.tags) ? dataCondition.tags.map(String).filter(Boolean) : [];
  if (tags.length === 0) return null;
  const candidates = await prisma.importedItem.findMany({
    where: { importSource: { holdingId: script.holdingId } },
    orderBy: { updatedAt: 'desc' },
    take: 100,
  });
  const matched = candidates.filter((item) => {
    const itemTags = safeJsonParse<string[]>(item.tagsJson, []);
    return tags.every((tag) => itemTags.includes(tag));
  });
  return pickRandom(matched);
}

function buildCallPlanRealtimePrompt(input: {
  script: Prisma.CallScriptGetPayload<{}>;
  profile: Prisma.CallCustomerProfileGetPayload<{}> | null;
  importedItem: Prisma.ImportedItemGetPayload<{}> | null;
}) {
  const profile = input.profile;
  const importedItem = input.importedItem;
  const profileName = profile?.name || 'Покупатель';
  const age = profile?.age ? `${profile.age}` : '35';
  const temperament = labelForTemperament(profile?.temperament || '');
  const patience = labelForPatience(profile?.patience || '');
  const replyLength = labelForReplyLength(profile?.replyLength || '');
  const communicationStyle = profile?.communicationStyle?.trim() || 'Говори естественно, как реальный клиент по телефону.';
  const context = input.script.context?.trim() || 'Потребность клиента не указана. Веди себя как реалистичный покупатель и уточняй детали по предложению.';
  const itemTitle = importedItem?.title?.trim() || 'предложение из выборки';
  const itemDescription = importedItem?.description?.trim() || '';
  const objections = safeJsonParse<Array<{ phrase?: string; whenAppropriate?: string }>>(input.script.objectionsJson, []);
  const questions = safeJsonParse<Array<{ text?: string; required?: boolean }>>(input.script.questionsJson, []);
  const criteria = safeJsonParse<Array<{ sourceType?: string; sourceId?: string; expectedAnswer?: string; score?: number }>>(input.script.successCriteriaJson, []);

  const objectionLines = objections.length
    ? objections.map((item, index) => `${index + 1}) "${item.phrase || 'Возражение'}"${item.whenAppropriate ? ` — уместно: ${item.whenAppropriate}` : ''}`).join('\n')
    : 'Нет специальных возражений. При необходимости используй одно естественное сомнение по цене, условиям или следующему шагу.';
  const questionLines = questions.length
    ? questions.map((item, index) => `${index + 1}) ${item.required ? '[обязательный]' : '[необязательный]'} ${item.text || ''}`).join('\n')
    : 'Нет заданных вопросов. Задавай только естественные вопросы по контексту.';
  const firstMessageInstruction = [
    `Смысл первой реплики: поздороваться, сказать что звонишь по поводу «${itemTitle}», и уточнить, актуально ли предложение.`,
    `Сформулируй эту реплику НЕ шаблонно, а в стиле профиля клиента: ${communicationStyle}`,
    'Не копируй дословно пример из prompt. Сохрани смысл, но подстрой лексику, длину и тон под профиль клиента.',
  ].join(' ');
  const criteriaLines = criteria.length
    ? criteria.map((item, index) => `${index + 1}) Эталон: "${item.expectedAnswer || ''}" — максимум ${item.score ?? 0} баллов. Если ответил также или почти также — максимум; если близко — половина; если не ответил — 0.`).join('\n')
    : 'Условия успеха не заданы.';

  return [
    '=== РОЛЬ (КРИТИЧНО) ===',
    'Ты — ПОКУПАТЕЛЬ (клиент), который САМ ЗВОНИТ сотруднику компании по конкретному предложению/данным из выборки. На другом конце провода — СОТРУДНИК/МЕНЕДЖЕР. Ты тестируешь: насколько хорошо он общается, даёт информацию, отвечает на вопросы, отрабатывает возражения и доводит до следующего шага.',
    'Ты НИКОГДА не сотрудник и не менеджер. Запрещено говорить фразы менеджера: «Слушаю вас», «Для чего вам нужно?», «Какой у вас бюджет?», «Понял, вам важно…». Ты — клиент: отвечаешь на вопросы о себе и задаёшь вопросы по предложению, условиям, деталям и следующему шагу.',
    '',
    '=== ПРОФИЛЬ КЛИЕНТА ===',
    `Профиль: ${profileName}. Возраст: ${age}. Темперамент: ${temperament}. Терпение: ${patience}. Длина реплик: ${replyLength}.`,
    `Стиль коммуникации: ${communicationStyle}`,
    '',
    '=== КОНТЕКСТ И ПОТРЕБНОСТЬ ===',
    context,
    '',
    '=== ДАННЫЕ ИЗ ВЫБОРКИ ===',
    `Основной объект разговора: ${itemTitle}.`,
    itemDescription ? `Описание: ${itemDescription}` : 'Описание отсутствует. Используй только те детали, которые есть в разговоре или данных ниже.',
    '',
    '=== ПЕРВОЕ СООБЩЕНИЕ ===',
    firstMessageInstruction,
    'Если сотрудник первым сказал «Алло» или «Слушаю» — после короткого приветствия произнеси эту первую реплику в своём стиле. Не повторяй «Алло».',
    '',
    '=== ЕСЛИ ТЕБЯ ПЕРЕБИЛИ (КРИТИЧНО) ===',
    'Когда сотрудник тебя перебил, НЕ повторяй длинную фразу с начала. Если перебили на приветствии — ответь коротко: «Да, здравствуйте» / «Добрый день» и перейди к сути. Если перебили в середине другой фразы — продолжай мысль коротко или ответь на реплику сотрудника. Никогда не копируй одну и ту же длинную реплику дважды.',
    '',
    '=== ФАЗЫ ДИАЛОГА ===',
    '1) first_contact — ты позвонил по конкретному предложению. Дождись, что сотрудник поздоровается, представится и уточнит предмет разговора. Если не представился — не упрекай вслух.',
    '2) needs_discovery — расскажи потребность из контекста, если сотрудник спросит. Не задавай сам вопросы менеджера клиенту.',
    '3) product_presentation — слушай презентацию. Задавай вопросы по данным выборки и своей потребности. Если информация выглядит неверной или неполной — вырази сомнение.',
    '4) objections_and_questions — задай обязательные вопросы из списка по очереди и подними одно уместное возражение. Не возвращайся к закрытой теме.',
    '5) closing_attempt — если сотрудник предлагает следующий шаг, согласись и попробуй зафиксировать дату/время или формат связи. Если не предлагает — подожди 1–2 реплики, потом скажи, что подумаешь.',
    '',
    '=== ВОПРОСЫ, КОТОРЫЕ НУЖНО ПРОВЕРИТЬ ===',
    questionLines,
    '',
    '=== КАК ЗАДАВАТЬ ВОПРОСЫ (КРИТИЧНО) ===',
    'Задавай только ОДИН вопрос за одну свою реплику. Запрещено задавать 2–3 вопроса подряд в одной реплике, даже если они перечислены рядом в списке.',
    'После каждого вопроса дождись ответа сотрудника. Только после ответа переходи к следующему вопросу из списка или к уточнению.',
    'Не превращай список вопросов в анкету. Диалог должен идти естественно: вопрос → ответ сотрудника → короткая реакция → следующий вопрос.',
    'Если сотрудник сам уже ответил на один из вопросов, не задавай его повторно; отметь его как закрытый и переходи дальше.',
    '',
    '=== ВОЗРАЖЕНИЯ ===',
    objectionLines,
    '',
    '=== УСЛОВИЯ УСПЕХА ДЛЯ ОЦЕНКИ ===',
    criteriaLines,
    '',
    '=== РЕАКЦИИ НА ПОВЕДЕНИЕ СОТРУДНИКА ===',
    '- Грубость или токсичный тон: не благодари, не хвали. Коротко: «Простите, но мне не нравится такой тон» / «Это неуместно». При сильной грубости — один раз ответь и завершай разговор.',
    '- Низкие усилия («ок», «хз», одно слово): «Можете ответить конкретнее?» / «Мне нужен развёрнутый ответ». Если второй раз подряд — жёстче.',
    '- Уход от вопроса: «Вы не ответили на мой вопрос» / «Я спрашивал о другом». Не повторяй один и тот же вопрос больше одного раза.',
    '- Отписка («посмотрите на сайте»): «Я звоню именно чтобы узнать от вас, а не с сайта.»',
    '- Нормальное поведение: отвечай естественно и двигай разговор вперёд.',
    '',
    '=== ТАЙМИНГ И ТЕРПЕНИЕ ===',
    'Ведёшь себя как живой человек: не спеши, дай сотруднику договорить. Если только что задал вопрос — подожди ответа. Не говори «вы не ответили», если сотрудник только поздоровался или сказал короткую вступительную фразу.',
    '',
    '=== ЗАВЕРШЕНИЕ ДИАЛОГА ===',
    'Завершай разговор, когда договорились о следующем шаге, разговор естественно исчерпан, или сотрудник ведёт себя грубо/неадекватно. В конце чётко скажи прощание: «До свидания», «Хорошо, тогда на этом закончим», «Спасибо, до свидания».',
    '',
    '=== ТЕХНИЧЕСКИЙ СИГНАЛ ДЛЯ ЗАВЕРШЕНИЯ ЗВОНКА ===',
    'После своей последней фразы прощания обязательно один раз вызови функцию end_call с краткой причиной: { "reason": "next_step_scheduled" }, { "reason": "will_think" }, { "reason": "bad_tone" } или другой короткой причиной. Не вызывай end_call раньше последней реплики и не вызывай дважды.',
    '',
    '=== ЯЗЫК И СТИЛЬ ===',
    'Язык: только русский. Тон: реалистичный клиент, не поддакивающий. Длина: 1–3 предложения на реплику. Без эмодзи, без мета-комментариев. Не выходи из роли.',
  ].join('\n');
}

export async function handleInitiateCallPlan(req: Request, res: Response): Promise<void> {
  try {
    const id = String(req.params.id || '').trim();
    await assertCanAccessPlan(req, id);
    const plan = await prisma.callPlan.findUnique({ where: { id } });
    if (!plan) throw new Error('План прозвона не найден.');
    const script = await prisma.callScript.findFirst({ where: { id: plan.scriptId, holdingId: plan.holdingId } });
    if (!script) throw new Error('Скрипт плана не найден.');
    const targets = await buildCallPlanTargets(plan);
    const target = pickRandom(targets);
    if (!target) throw new Error('Нет сотрудников с активными номерами выбранного типа.');
    const profileIds = safeJsonParse<string[]>(script.profileIdsJson, []);
    const profiles = profileIds.length
      ? await prisma.callCustomerProfile.findMany({ where: { id: { in: profileIds }, holdingId: plan.holdingId } })
      : [];
    const profile = pickRandom(profiles);
    const importedItem = await pickImportedSampleForScript(script);
    const prompt = buildCallPlanRealtimePrompt({ script, profile, importedItem });
    const result = await startVoiceCall(target.phoneNumber.phone, { scenario: 'realtime_pure', instructions: prompt });
    if ('error' in result) throw new Error(result.error);
    addCall(result.callId, target.phoneNumber.phone);
    if (result.callSessionHistoryId) setVoxSessionId(result.callId, result.callSessionHistoryId);
    const toNormalized = '+' + String(target.phoneNumber.phone).replace(/\D/g, '');
    await prisma.voiceCallSession.create({
      data: {
        callId: result.callId,
        to: toNormalized,
        scenario: result.scenario ?? 'realtime_pure',
        source: 'scheduled',
        dealershipId: target.dealershipId,
        managerId: target.employee.id,
        planId: plan.id,
        caseContextJson: JSON.stringify({
          planId: plan.id,
          scriptId: script.id,
          profileId: profile?.id ?? null,
          importedItemId: importedItem?.id ?? null,
        }),
        startedAt: new Date(result.startedAt),
      },
    }).catch(() => undefined);
    const criteria = safeJsonParse(script.successCriteriaJson, []);
    await prisma.callPlanCall.create({
      data: {
        planId: plan.id,
        callId: result.callId,
        employeeId: target.employee.id,
        employeeName: target.employee.fullName,
        dealershipId: target.dealershipId,
        dealershipName: target.dealershipName,
        phone: toNormalized,
        phoneNumberTypeId: plan.phoneNumberTypeId,
        scriptId: script.id,
        profileId: profile?.id ?? null,
        importedItemId: importedItem?.id ?? null,
        promptText: prompt,
        criteriaJson: JSON.stringify(criteria),
        status: 'running',
        startedAt: new Date(result.startedAt),
      },
    });
    const updated = await prisma.callPlan.update({
      where: { id },
      data: { lastInitiatedAt: new Date(), lastBatchId: result.callId },
    });
    res.json({ item: normalizePlan(updated), callId: result.callId, batchId: result.callId, totalJobs: 1 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Не удалось инициировать прозвон.';
    res.status(message.includes('не найден') ? 404 : message.includes('доступ') ? 403 : 400).json({ error: message });
  }
}

export async function handlePreviewCallPlanPrompt(req: Request, res: Response): Promise<void> {
  try {
    const id = String(req.params.id || '').trim();
    await assertCanAccessPlan(req, id);
    const plan = await prisma.callPlan.findUnique({ where: { id } });
    if (!plan) throw new Error('План прозвона не найден.');
    const script = await prisma.callScript.findFirst({ where: { id: plan.scriptId, holdingId: plan.holdingId } });
    if (!script) throw new Error('Скрипт плана не найден.');
    const profileIds = safeJsonParse<string[]>(script.profileIdsJson, []);
    const profiles = profileIds.length
      ? await prisma.callCustomerProfile.findMany({ where: { id: { in: profileIds }, holdingId: plan.holdingId } })
      : [];
    const profile = pickRandom(profiles);
    const importedItem = await pickImportedSampleForScript(script);
    const prompt = buildCallPlanRealtimePrompt({ script, profile, importedItem });
    res.json({
      prompt,
      profile: profile ? normalizeProfile(profile) : null,
      importedItem: importedItem ? {
        id: importedItem.id,
        title: importedItem.title,
        description: importedItem.description,
        tags: safeJsonParse<string[]>(importedItem.tagsJson, []),
      } : null,
      script: normalizeScript(script),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Не удалось сгенерировать промпт.';
    res.status(message.includes('не найден') ? 404 : message.includes('доступ') ? 403 : 400).json({ error: message });
  }
}

export async function handleListCallPlanCalls(req: Request, res: Response): Promise<void> {
  try {
    const id = String(req.params.id || '').trim();
    await assertCanAccessPlan(req, id);
    const items = await prisma.callPlanCall.findMany({
      where: { planId: id },
      orderBy: { startedAt: 'desc' },
      take: 100,
    });
    res.json({ items: items.map(normalizePlanCall) });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Не удалось загрузить историю прозвона.';
    res.status(message.includes('не найден') ? 404 : message.includes('доступ') ? 403 : 400).json({ error: message });
  }
}
