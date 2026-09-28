import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { prisma } from '../db';

export type EvaluationChecklistItemDefinition = {
  id: string;
  title: string;
  instruction: string;
  category: string;
  points: number;
  allowNa: boolean;
};

function isSuper(req: Request): boolean {
  return Boolean(req.authAccount?.memberships.some((item) => item.role === 'platform_superadmin'));
}

function isActiveSuper(req: Request): boolean {
  return isSuper(req) && String(req.get('x-admin-role') || '').trim() === 'super';
}

function isCompanyAdmin(req: Request): boolean {
  return Boolean(req.authAccount?.memberships.some((item) => item.role === 'holding_admin'));
}

function assertPageRole(req: Request): void {
  const activeRole = String(req.get('x-admin-role') || '').trim();
  if (activeRole && !['super', 'company'].includes(activeRole)) throw new Error('Нет доступа к чек-листам.');
  if (!isSuper(req) && !isCompanyAdmin(req)) throw new Error('Нет доступа к чек-листам.');
}

function holdingIds(req: Request): string[] | null {
  if (isSuper(req)) return null;
  return [...new Set((req.authAccount?.memberships || [])
    .filter((item) => item.role === 'holding_admin' && item.holdingId)
    .map((item) => item.holdingId as string))];
}

function assertHolding(req: Request, holdingId: string): void {
  const allowed = holdingIds(req);
  if (allowed !== null && !allowed.includes(holdingId)) throw new Error('Нет доступа к выбранной компании.');
}

function text(value: unknown): string {
  return String(value ?? '').trim();
}

function parseItems(value: unknown): EvaluationChecklistItemDefinition[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('Добавьте хотя бы один пункт чек-листа.');
  const ids = new Set<string>();
  const items = value.map((raw, index) => {
    const source = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    const title = text(source.title);
    const points = Number(source.points);
    if (!title) throw new Error(`Укажите название пункта №${index + 1}.`);
    if (!Number.isFinite(points) || points <= 0 || points > 100) throw new Error(`Некорректные баллы в пункте «${title}».`);
    let id = text(source.id) || randomUUID();
    if (ids.has(id)) id = randomUUID();
    ids.add(id);
    return {
      id,
      title,
      instruction: text(source.instruction) || title,
      category: text(source.category) || 'Общее',
      points: Math.round(points * 10) / 10,
      allowNa: Boolean(source.allowNa),
    };
  });
  const total = Math.round(items.reduce((sum, item) => sum + item.points, 0) * 10) / 10;
  if (total > 100) throw new Error(`Сумма баллов чек-листа не может превышать 100. Сейчас: ${total}.`);
  return items;
}

function normalize(item: { id: string; holdingId: string | null; name: string; isTemplate: boolean; sourceTemplateId: string | null; itemsJson: string; isArchived: boolean; createdAt: Date; updatedAt: Date }) {
  let items: EvaluationChecklistItemDefinition[] = [];
  try { items = JSON.parse(item.itemsJson) as EvaluationChecklistItemDefinition[]; } catch { /* empty */ }
  return {
    ...item,
    items,
    totalPoints: Math.round(items.reduce((sum, row) => sum + Number(row.points || 0), 0) * 10) / 10,
  };
}

export async function handleListEvaluationChecklists(req: Request, res: Response): Promise<void> {
  try {
    assertPageRole(req);
    const requestedHoldingId = text(req.query.holdingId) || null;
    if (requestedHoldingId) assertHolding(req, requestedHoldingId);
    const allowed = holdingIds(req);
    const companyWhere = requestedHoldingId
      ? { holdingId: requestedHoldingId }
      : allowed === null ? { holdingId: { not: null } } : { holdingId: { in: allowed } };
    const items = await prisma.evaluationChecklist.findMany({
      where: {
        isArchived: false,
        OR: [{ isTemplate: true, holdingId: null }, { isTemplate: false, ...companyWhere }],
      },
      orderBy: [{ isTemplate: 'desc' }, { updatedAt: 'desc' }],
    });
    res.json({ items: items.map(normalize) });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Не удалось загрузить чек-листы.';
    res.status(message.includes('доступ') ? 403 : 400).json({ error: message });
  }
}

export async function handleCreateEvaluationChecklist(req: Request, res: Response): Promise<void> {
  try {
    assertPageRole(req);
    const body = (req.body || {}) as Record<string, unknown>;
    const isTemplate = Boolean(body.isTemplate);
    if (isTemplate && !isActiveSuper(req)) throw new Error('Только суперадмин может создавать шаблоны.');
    const holdingId = isTemplate ? null : text(body.holdingId);
    if (!isTemplate && !holdingId) throw new Error('Компания обязательна.');
    if (holdingId) assertHolding(req, holdingId);
    const name = text(body.name);
    if (!name) throw new Error('Название чек-листа обязательно.');
    const sourceTemplateId = text(body.sourceTemplateId) || null;
    let itemsInput = body.items;
    if (sourceTemplateId && (!Array.isArray(itemsInput) || itemsInput.length === 0)) {
      const template = await prisma.evaluationChecklist.findFirst({ where: { id: sourceTemplateId, isTemplate: true, isArchived: false } });
      if (!template) throw new Error('Шаблон чек-листа не найден.');
      itemsInput = JSON.parse(template.itemsJson);
    }
    const items = parseItems(itemsInput);
    const created = await prisma.evaluationChecklist.create({
      data: { holdingId: holdingId || null, name, isTemplate, sourceTemplateId: null, itemsJson: JSON.stringify(items) },
    });
    res.status(201).json({ item: normalize(created) });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Не удалось создать чек-лист.';
    res.status(message.includes('доступ') || message.includes('суперадмин') ? 403 : 400).json({ error: message });
  }
}

export async function handleUpdateEvaluationChecklist(req: Request, res: Response): Promise<void> {
  try {
    assertPageRole(req);
    const id = text(req.params.id);
    const existing = await prisma.evaluationChecklist.findUnique({ where: { id } });
    if (!existing || existing.isArchived) throw new Error('Чек-лист не найден.');
    if (existing.isTemplate) {
      if (!isActiveSuper(req)) throw new Error('Только суперадмин может редактировать шаблоны.');
    } else if (existing.holdingId) {
      assertHolding(req, existing.holdingId);
    }
    const body = (req.body || {}) as Record<string, unknown>;
    const name = text(body.name);
    if (!name) throw new Error('Название чек-листа обязательно.');
    const items = parseItems(body.items);
    const updated = await prisma.evaluationChecklist.update({
      where: { id },
      data: { name, itemsJson: JSON.stringify(items) },
    });
    res.json({ item: normalize(updated) });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Не удалось обновить чек-лист.';
    res.status(message.includes('не найден') ? 404 : message.includes('доступ') || message.includes('суперадмин') ? 403 : 400).json({ error: message });
  }
}

export async function handleArchiveEvaluationChecklist(req: Request, res: Response): Promise<void> {
  try {
    assertPageRole(req);
    const id = text(req.params.id);
    const existing = await prisma.evaluationChecklist.findUnique({ where: { id } });
    if (!existing) throw new Error('Чек-лист не найден.');
    if (existing.isTemplate) {
      if (!isActiveSuper(req)) throw new Error('Только суперадмин может архивировать шаблоны.');
    } else if (existing.holdingId) {
      assertHolding(req, existing.holdingId);
    }
    const linkedScripts = await prisma.callScript.count({ where: { checklistId: id } });
    if (linkedScripts > 0) throw new Error(`Чек-лист используется в ${linkedScripts} скриптах. Сначала выберите для них другой чек-лист.`);
    await prisma.evaluationChecklist.update({ where: { id }, data: { isArchived: true } });
    res.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Не удалось архивировать чек-лист.';
    res.status(message.includes('не найден') ? 404 : message.includes('доступ') || message.includes('суперадмин') ? 403 : 400).json({ error: message });
  }
}
