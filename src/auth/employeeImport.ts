import { randomUUID, randomBytes, scrypt } from 'node:crypto';
import { promisify } from 'node:util';
import type { Request, Response } from 'express';
import { Prisma, type PrismaClient } from '@prisma/client';
import { prisma } from '../db';
import { recordRequestEvent } from '../analytics/requestEvent';
import { normalizeEmployeePhoneKey } from './employeePhoneUniqueness';
import { reportError } from '../monitoring/reportError';
const MAX_ROWS = 200;
const deriveKey = promisify(scrypt);
type Row = {
  line: number;
  email: string;
  fullName: string;
  branchId: string;
  branchName: string;
  password: string;
  phone: string | null;
  errors: string[];
};
class ImportError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
export async function validateEmployeeImport(req: Request, db: Pick<PrismaClient, 'holding' | 'dealership' | 'account' | 'managerProfile' | 'phoneNumber'> = prisma): Promise<{
  companyId: string;
  rows: Row[];
  valid: boolean;
}> {
  const actor = req.authAccount;
  if (!actor)
    throw new ImportError('Требуется авторизация.', 401);
  const roleMap: Record<string, string> = { super: 'platform_superadmin', company: 'holding_admin', dealer: 'dealership_admin', staff: 'manager' };
  const requestedRole = roleMap[String(req.get('x-admin-role') ?? '')];
  const memberships = requestedRole ? actor.memberships.filter(item => item.role === requestedRole) : actor.memberships;
  if (!memberships.some(item => ['platform_superadmin', 'holding_admin', 'dealership_admin'].includes(item.role)))
    throw new ImportError('Импорт доступен только руководителям.', 403);
  const body = req.body as Record<string, unknown> | undefined;
  const companyId = typeof body?.companyId === 'string' ? body.companyId : '';
  if (!companyId || !Array.isArray(body?.rows) || !body.rows.length || body.rows.length > MAX_ROWS)
    throw new ImportError(`Выберите компанию и загрузите от 1 до ${MAX_ROWS} строк.`);
  const superadmin = memberships.some(item => item.role === 'platform_superadmin');
  const allowedCompany = memberships.some(item => item.role === 'holding_admin' && item.holdingId === companyId);
  const branchIds = memberships.filter(item => item.role === 'dealership_admin').flatMap(item => item.dealershipId ? [item.dealershipId] : []);
  const allowed = await db.dealership.findMany({ where: { holdingId: companyId, isDeleted: false, holding: { isDeleted: false }, ...(!superadmin && !allowedCompany ? { id: { in: branchIds } } : {}) }, select: { id: true, name: true } });
  if (!superadmin && !allowedCompany && !allowed.length)
    throw new ImportError('Компания недоступна.', 403);
  const company = await db.holding.findFirst({ where: { id: companyId, isDeleted: false }, select: { id: true } });
  if (!company)
    throw new ImportError('Компания не найдена.', 404);
  const branches = new Map(allowed.map(item => [item.id, item.name]));
  const rows: Row[] = body.rows.map((value, index) => {
    const item = value && typeof value === 'object' ? value as Record<string, unknown> : {};
    const str = (key: string) => typeof item[key] === 'string' ? item[key] as string : '';
    return { line: index + 2, email: str('email').trim().toLowerCase(), fullName: str('fullName').trim(), branchId: str('branchId').trim(), branchName: branches.get(str('branchId').trim()) ?? '', password: str('password'), phone: str('phone').trim() || null, errors: [] };
  });
  const [existing, profiles, phones] = await Promise.all([
    db.account.findMany({ where: { email: { in: rows.map(item => item.email) } }, select: { email: true } }),
    db.managerProfile.findMany({ where: { dealershipId: { in: allowed.map(item => item.id) } }, select: { accountId: true, dealershipId: true, phone: true } }),
    db.phoneNumber.findMany({ where: { account: { managerProfiles: { some: { dealershipId: { in: allowed.map(item => item.id) } } } } }, select: { accountId: true, phone: true } }),
  ]);
  const existingEmails = new Set(existing.map(item => item.email.toLowerCase()));
  const batchEmails = new Map<string, number>();
  const usedPhones = new Set(profiles.filter(item => item.phone).map(item => `${item.dealershipId}:${normalizeEmployeePhoneKey(item.phone)}`));
  for (const phone of phones)
    for (const profile of profiles)
      if (phone.accountId && phone.accountId === profile.accountId)
        usedPhones.add(`${profile.dealershipId}:${normalizeEmployeePhoneKey(phone.phone)}`);
  const batchPhones = new Map<string, number>();
  rows.forEach((row, index) => {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.email) || row.email.length > 254)
      row.errors.push('Некорректный email');
    if (row.fullName.length < 2 || row.fullName.length > 160)
      row.errors.push('Имя должно содержать от 2 до 160 символов');
    if (!branches.has(row.branchId))
      row.errors.push('Точка не найдена в выбранной компании или недоступна');
    if (row.password.length < 8 || row.password.length > 128)
      row.errors.push('Пароль должен содержать от 8 до 128 символов');
    if (existingEmails.has(row.email))
      row.errors.push('Аккаунт с таким email уже существует');
    const previous = batchEmails.get(row.email);
    if (previous !== undefined) {
      row.errors.push('Повтор email в файле');
      rows[previous].errors.push('Повтор email в файле');
    }
    else
      batchEmails.set(row.email, index);
    if (row.phone) {
      const key = normalizeEmployeePhoneKey(row.phone);
      if (!/^\d{10,15}$/.test(key))
        row.errors.push('Некорректный телефон');
      const scopedKey = `${row.branchId}:${key}`;
      if (usedPhones.has(scopedKey))
        row.errors.push('Телефон уже принадлежит сотруднику этой точки');
      const duplicate = batchPhones.get(scopedKey);
      if (duplicate !== undefined) {
        row.errors.push('Повтор телефона в точке');
        rows[duplicate].errors.push('Повтор телефона в точке');
      }
      else
        batchPhones.set(scopedKey, index);
    }
  });
  return { companyId, rows, valid: rows.every(row => row.errors.length === 0) };
}
function preview(result: Awaited<ReturnType<typeof validateEmployeeImport>>) {
  return { valid: result.valid, total: result.rows.length, rows: result.rows.map(({ password, ...row }) => row) };
}
export function createEmployeeImportHandlers(db: PrismaClient = prisma, emit: typeof recordRequestEvent = recordRequestEvent) {
  const handleError = (error: unknown, res: Response) => {
    if (error instanceof ImportError)
      return res.status(error.status).json({ error: error.message });
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
      return res.status(409).json({ error: 'Данные изменились: один из email уже существует. Повторите проверку файла.' });
    reportError(error, { task: 'employee-import' });
    return res.status(500).json({ error: 'Не удалось импортировать сотрудников. Изменения не сохранены.' });
  };
  return {
    preview: async (req: Request, res: Response) => {
      try {
        return res.json(preview(await validateEmployeeImport(req, db)));
      }
      catch (error) {
        return handleError(error, res);
      }
    },
    commit: async (req: Request, res: Response) => {
      try {
        const checked = await validateEmployeeImport(req, db);
        if (!checked.valid)
          return res.status(422).json({ ...preview(checked), error: 'Исправьте ошибки в файле и повторите проверку.' });
        const hashes: string[] = [];
        // Use the worker pool rather than blocking HTTP on synchronous password hashing.
        for (let offset = 0; offset < checked.rows.length; offset += 4) {
          hashes.push(...await Promise.all(checked.rows.slice(offset, offset + 4).map(async (row) => { const salt = randomBytes(16).toString('hex'); const key = await deriveKey(row.password, salt, 64) as Buffer; return `scrypt$${salt}$${key.toString('hex')}`; })));
        }
        await db.$transaction(async (tx) => {
          const fresh = await validateEmployeeImport(req, tx);
          if (!fresh.valid)
            throw new ImportError('Данные изменились. Повторите проверку файла перед импортом.', 409);
          for (let i = 0; i < checked.rows.length; i++) {
            const row = checked.rows[i];
            await tx.account.create({ data: { email: row.email, displayName: row.fullName, passwordHash: hashes[i], memberships: { create: { role: 'manager', holdingId: checked.companyId, dealershipId: row.branchId } }, managerProfiles: { create: { fullName: row.fullName, email: row.email, phone: row.phone ? `+${normalizeEmployeePhoneKey(row.phone)}` : null, dealershipId: row.branchId } } } });
          }
        }, { timeout: 15000 });
        const importId = randomUUID(), branches = new Set(checked.rows.map(row => row.branchId));
        emit(req, { eventName: 'employees_imported', companyId: checked.companyId, branchId: branches.size === 1 ? checked.rows[0].branchId : null, targetType: 'company', targetId: checked.companyId, deduplicationKey: `employees_imported:${importId}`, properties: { import_id: importId, imported_count: checked.rows.length, source: 'csv' } });
        return res.status(201).json({ importId, importedCount: checked.rows.length });
      }
      catch (error) {
        return handleError(error, res);
      }
    },
  };
}
