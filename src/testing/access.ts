import type { RequestHandler } from 'express';

export const requireTestingSuperadmin: RequestHandler = (req, res, next) => {
  if (!req.authAccount) {
    res.status(401).json({ error: 'Требуется авторизация.' });
    return;
  }
  if (!req.authAccount.memberships.some((membership) => membership.role === 'platform_superadmin')) {
    res.status(403).json({ error: 'Тестирование доступно только суперадминам.' });
    return;
  }
  next();
};
