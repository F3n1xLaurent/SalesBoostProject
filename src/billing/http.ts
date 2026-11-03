import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { calculateBillingAccess } from './access';

const isoDate = z.string().datetime({ offset: true }).transform((v) => new Date(v));
export const paymentInput = z.object({
  amountKopecks: z.number().int().positive().max(2_147_483_647),
  paidAt: isoDate,
  startsAt: isoDate,
  endsAt: isoDate.nullable(),
  calls: z.boolean(),
  trainer: z.boolean(),
  comment: z.string().trim().min(1, 'Добавьте комментарий, например номер договора.').max(4000),
  status: z.enum(['active', 'cancelled']),
  version: z.number().int().positive().optional(),
}).refine((v) => v.calls || v.trainer, 'Выберите хотя бы один модуль.')
  .refine((v) => !v.endsAt || v.endsAt >= v.startsAt, 'Окончание доступа должно быть не раньше начала.');

export const billingRouter = Router();
// Require the actual platform role; templates and client role headers cannot grant billing access.
billingRouter.use((req, res, next) => {
  if (!req.authAccount?.memberships.some((m) => m.role === 'platform_superadmin')) {
    res.status(403).json({ error: 'Биллинг доступен только суперадминистратору.' });
    return;
  }
  next();
});

billingRouter.get('/:holdingId', async (req, res) => {
  try {
    const holding = await prisma.holding.findUnique({
      where: { id: req.params.holdingId },
      include: { billingPayments: { orderBy: [{ paidAt: 'desc' }, { createdAt: 'desc' }] }, billingChanges: { orderBy: { createdAt: 'desc' } } },
    });
    if (!holding) return res.status(404).json({ error: 'Компания не найдена.' });
    return res.json({ enabled: holding.billingEnabled, payments: holding.billingPayments, changes: holding.billingChanges,
      access: calculateBillingAccess(holding.billingEnabled, holding.billingPayments) });
  } catch (error) { console.error('[billing] read', error); return res.status(500).json({ error: 'Не удалось загрузить биллинг.' }); }
});

billingRouter.patch('/:holdingId', async (req, res) => {
  const input = z.object({ enabled: z.boolean() }).safeParse(req.body);
  if (!input.success) return res.status(400).json({ error: 'Укажите состояние биллинга.' });
  try {
    const actor = req.authAccount!;
    await prisma.$transaction(async (tx) => {
      const holding = await tx.holding.findUnique({ where: { id: req.params.holdingId } });
      if (!holding || holding.isDeleted) throw new Error('Компания не найдена.');
      if (holding.billingEnabled === input.data.enabled) return;
      await tx.holding.update({ where: { id: holding.id }, data: { billingEnabled: input.data.enabled } });
      await tx.billingChange.create({ data: { holdingId: holding.id, actorId: actor.id, actorName: actor.displayName || actor.email,
        action: 'settings', beforeJson: JSON.stringify({ enabled: holding.billingEnabled }), afterJson: JSON.stringify(input.data) } });
    });
    return res.json({ success: true });
  } catch (error) { console.error('[billing] settings', error); return res.status(400).json({ error: 'Не удалось изменить биллинг компании.' }); }
});

for (const method of ['post', 'put'] as const) {
  billingRouter[method](method === 'post' ? '/:holdingId/payments' : '/:holdingId/payments/:paymentId', async (req, res) => {
    const input = paymentInput.safeParse(req.body);
    if (!input.success) return res.status(400).json({ error: input.error.issues[0].message });
    if (method === 'put' && !input.data.version) return res.status(400).json({ error: 'Не указана версия оплаты.' });
    try {
      const actor = req.authAccount!;
      const result = await prisma.$transaction(async (tx) => {
        const holding = await tx.holding.findUnique({ where: { id: req.params.holdingId } });
        if (!holding || holding.isDeleted) return { status: 404, error: 'Компания не найдена.' };
        const before = method === 'put' ? await tx.billingPayment.findFirst({ where: { id: ('paymentId' in req.params ? req.params.paymentId : undefined), holdingId: holding.id } }) : null;
        if (method === 'put' && !before) return { status: 404, error: 'Оплата не найдена.' };
        const { version, ...data } = input.data;
        if (before) {
          const changed = await tx.billingPayment.updateMany({ where: { id: before.id, version }, data: { ...data, version: { increment: 1 } } });
          if (!changed.count) return { status: 409, error: 'Оплата уже изменена. Обновите страницу и повторите правку.' };
        }
        const payment = before ? await tx.billingPayment.findUniqueOrThrow({ where: { id: before.id } })
          : await tx.billingPayment.create({ data: { ...data, holdingId: holding.id } });
        await tx.billingChange.create({ data: { holdingId: holding.id, paymentId: payment.id, actorId: actor.id,
          actorName: actor.displayName || actor.email, action: before ? 'updated' : 'created',
          beforeJson: before ? JSON.stringify(before) : null, afterJson: JSON.stringify(payment) } });
        return { status: before ? 200 : 201, payment };
      });
      return res.status(result.status).json(result.error ? { error: result.error } : result.payment);
    } catch (error) { console.error('[billing] payment', error); return res.status(500).json({ error: 'Не удалось сохранить оплату.' }); }
  });
}
