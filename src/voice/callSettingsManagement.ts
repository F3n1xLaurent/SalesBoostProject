import type { Request, Response } from 'express';
import type { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { createCallBatch } from './callBatchOrchestrator';

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

async function buildCallPlanJobs(plan: Prisma.CallPlanGetPayload<{}>) {
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
    phone: phoneNumber.phone,
    dealershipId: employee.dealershipId,
    dealershipName: employee.dealership.name,
  })));
}

export async function handleInitiateCallPlan(req: Request, res: Response): Promise<void> {
  try {
    const id = String(req.params.id || '').trim();
    await assertCanAccessPlan(req, id);
    const plan = await prisma.callPlan.findUnique({ where: { id } });
    if (!plan) throw new Error('План прозвона не найден.');
    const jobs = await buildCallPlanJobs(plan);
    if (jobs.length === 0) throw new Error('Нет сотрудников с активными номерами выбранного типа.');
    const batch = await createCallBatch({
      mode: plan.targetType === 'dealerships' ? 'all_dealerships' : 'manual',
      title: plan.name,
      jobs,
      maxConcurrency: 10,
      startIntervalMs: 250,
      maxAttempts: 3,
      scenario: 'realtime_pure',
    });
    const updated = await prisma.callPlan.update({
      where: { id },
      data: { lastInitiatedAt: new Date(), lastBatchId: batch.batchId },
    });
    res.json({ item: normalizePlan(updated), batchId: batch.batchId, totalJobs: batch.totalJobs });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Не удалось инициировать прозвон.';
    res.status(message.includes('не найден') ? 404 : message.includes('доступ') ? 403 : 400).json({ error: message });
  }
}
