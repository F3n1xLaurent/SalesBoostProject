import type { Prisma } from '@prisma/client';
import type { Request, Response } from 'express';
import { prisma } from '../db';
import { MOCK_DEALERSHIP_SEEDS, MOCK_HOLDING_SEEDS } from '../super-admin/mockOrganization';
import { APP_ROLES } from './permissions';

type ScopedAccount = NonNullable<Express.Request['authAccount']>;
type HoldingType = 'own' | 'franchised';

function isPlatformSuperadmin(account: ScopedAccount): boolean {
  return account.memberships.some((membership) => membership.role === APP_ROLES.platformSuperadmin);
}

function assertSuperadmin(account: ScopedAccount): void {
  if (!isPlatformSuperadmin(account)) {
    throw new Error('Доступно только суперадмину.');
  }
}

function isHoldingAdmin(account: ScopedAccount): boolean {
  return account.memberships.some((membership) => membership.role === APP_ROLES.holdingAdmin);
}

function isDealershipAdmin(account: ScopedAccount): boolean {
  return account.memberships.some((membership) => membership.role === APP_ROLES.dealershipAdmin);
}

function getHoldingIds(account: ScopedAccount): string[] {
  return [...new Set(
    account.memberships
      .filter((membership) => membership.role === APP_ROLES.holdingAdmin && membership.holdingId)
      .map((membership) => membership.holdingId!),
  )];
}

function getDealershipIds(account: ScopedAccount): string[] {
  return [...new Set(
    account.memberships
      .filter((membership) => membership.role === APP_ROLES.dealershipAdmin && membership.dealershipId)
      .map((membership) => membership.dealershipId!),
  )];
}

function canManageDealershipForAccount(
  account: ScopedAccount,
  params: { dealershipId: string; holdingId?: string | null },
): boolean {
  if (isPlatformSuperadmin(account)) return true;
  if (getDealershipIds(account).includes(params.dealershipId)) return true;
  if (params.holdingId && getHoldingIds(account).includes(params.holdingId)) return true;
  return false;
}

function normalizeHoldingResponse(
  holding: Prisma.HoldingGetPayload<{
    include: {
      dealerships: {
        orderBy: [{ city: 'asc' }, { name: 'asc' }];
      };
    };
  }>,
) {
  return {
    id: holding.id,
    name: holding.name,
    code: holding.code,
    type: holding.type as HoldingType,
    isActive: holding.isActive,
    createdAt: holding.createdAt,
    updatedAt: holding.updatedAt,
    dealershipsCount: holding.dealerships.length,
    dealerships: holding.dealerships.map((dealership) => ({
      id: dealership.id,
      name: dealership.name,
      code: dealership.code,
      city: dealership.city,
      address: dealership.address,
      isActive: dealership.isActive,
      holdingId: dealership.holdingId,
    })),
  };
}

function normalizeDealershipResponse(
  dealership: Prisma.DealershipGetPayload<{
    include: {
      holding: true;
      _count: {
        select: { managerProfiles: true };
      };
    };
  }>,
) {
  return {
    id: dealership.id,
    name: dealership.name,
    code: dealership.code,
    city: dealership.city,
    address: dealership.address,
    isActive: dealership.isActive,
    createdAt: dealership.createdAt,
    updatedAt: dealership.updatedAt,
    holdingId: dealership.holdingId,
    holdingName: dealership.holding?.name ?? null,
    managersCount: dealership._count.managerProfiles,
  };
}

function parseString(value: unknown): string | null {
  const parsed = String(value ?? '').trim();
  return parsed ? parsed : null;
}

function parseBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value === 'true' || value === '1') return true;
    if (value === 'false' || value === '0') return false;
  }
  return fallback;
}

function parseDealershipIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item || '').trim()).filter(Boolean))];
}

function parseHoldingType(value: unknown, fallback: HoldingType = 'own'): HoldingType {
  return value === 'franchised' ? 'franchised' : fallback;
}

function slugifyHoldingCode(input: string): string {
  const translitMap: Record<string, string> = {
    а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y',
    к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f',
    х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
  };
  const slug = input
    .trim()
    .toLowerCase()
    .replace(/[а-яё]/g, (char) => translitMap[char] ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  return slug || 'holding';
}

async function generateUniqueHoldingCode(tx: Prisma.TransactionClient, name: string): Promise<string> {
  const base = slugifyHoldingCode(name);
  let candidate = base;
  let counter = 2;

  while (true) {
    const existing = await tx.holding.findUnique({
      where: { code: candidate },
      select: { id: true },
    });
    if (!existing) return candidate;
    candidate = `${base}-${counter}`;
    counter += 1;
  }
}

async function getHoldingsSnapshot() {
  return prisma.holding.findMany({
    include: {
      dealerships: {
        orderBy: [{ city: 'asc' }, { name: 'asc' }],
      },
    },
    orderBy: { name: 'asc' },
  });
}

function buildHoldingWhere(
  filters: { search?: string | null; type?: HoldingType | null; isActive?: boolean | null },
  scope: Prisma.HoldingWhereInput = {},
): Prisma.HoldingWhereInput {
  const and: Prisma.HoldingWhereInput[] = [];

  if (filters.type) and.push({ type: filters.type });
  if (filters.isActive != null) and.push({ isActive: filters.isActive });
  if (filters.search) {
    and.push({
      OR: [
        { name: { contains: filters.search } },
        { code: { contains: filters.search } },
        { dealerships: { some: { name: { contains: filters.search } } } },
        { dealerships: { some: { code: { contains: filters.search } } } },
      ],
    });
  }

  if (and.length === 0) return scope;
  return { AND: [scope, ...and] };
}

async function getDealershipsSnapshot() {
  return prisma.dealership.findMany({
    include: {
      holding: true,
      _count: {
        select: { managerProfiles: true },
      },
    },
    orderBy: [{ city: 'asc' }, { name: 'asc' }],
  });
}

export async function syncMockOrganization(): Promise<{
  holdingsCreated: number;
  dealershipsCreated: number;
  dealershipsUpdated: number;
}> {
  let holdingsCreated = 0;
  let dealershipsCreated = 0;
  let dealershipsUpdated = 0;

  await prisma.$transaction(async (tx) => {
    const holdingByKey = new Map<string, string>();

    for (const seed of MOCK_HOLDING_SEEDS) {
      const existing = await tx.holding.findFirst({
        where: {
          OR: [{ code: seed.code }, { name: seed.name }],
        },
      });

      if (existing) {
        const updated = await tx.holding.update({
          where: { id: existing.id },
          data: {
            name: seed.name,
            code: seed.code,
            type: seed.type ?? 'own',
            isActive: seed.isActive ?? true,
          },
        });
        holdingByKey.set(seed.key, updated.id);
      } else {
        const created = await tx.holding.create({
          data: {
            name: seed.name,
            code: seed.code,
            type: seed.type ?? 'own',
            isActive: seed.isActive ?? true,
          },
        });
        holdingsCreated += 1;
        holdingByKey.set(seed.key, created.id);
      }
    }

    for (const seed of MOCK_DEALERSHIP_SEEDS) {
      const holdingId = seed.holdingKey ? holdingByKey.get(seed.holdingKey) ?? null : null;
      const existing = await tx.dealership.findFirst({
        where: {
          OR: [{ code: seed.code }, { name: seed.name, city: seed.city }],
        },
      });

      if (existing) {
        await tx.dealership.update({
          where: { id: existing.id },
          data: {
            name: seed.name,
            code: seed.code,
            city: seed.city,
            address: seed.address,
            holdingId,
            isActive: seed.isActive ?? true,
          },
        });
        dealershipsUpdated += 1;
      } else {
        await tx.dealership.create({
          data: {
            name: seed.name,
            code: seed.code,
            city: seed.city,
            address: seed.address,
            holdingId,
            isActive: seed.isActive ?? true,
          },
        });
        dealershipsCreated += 1;
      }
    }
  });

  return { holdingsCreated, dealershipsCreated, dealershipsUpdated };
}

export async function handleListHoldings(req: Request, res: Response): Promise<void> {
  const account = req.authAccount;
  if (!account) {
    res.status(401).json({ error: 'Требуется авторизация.' });
    return;
  }

  try {
    const search = parseString(req.query.search);
    const type = req.query.type != null ? parseHoldingType(req.query.type, 'own') : null;
    const statusRaw = parseString(req.query.status);
    const isActive = statusRaw === 'active' ? true : statusRaw === 'inactive' ? false : null;
    let items;
    if (isPlatformSuperadmin(account)) {
      items = await prisma.holding.findMany({
        where: buildHoldingWhere({ search, type, isActive }),
        include: {
          dealerships: {
            orderBy: [{ city: 'asc' }, { name: 'asc' }],
          },
        },
        orderBy: { name: 'asc' },
      });
    } else if (isHoldingAdmin(account)) {
      items = await prisma.holding.findMany({
        where: buildHoldingWhere({ search, type, isActive }, { id: { in: getHoldingIds(account) } }),
        include: {
          dealerships: {
            orderBy: [{ city: 'asc' }, { name: 'asc' }],
          },
        },
        orderBy: { name: 'asc' },
      });
    } else if (isDealershipAdmin(account)) {
      const dealerships = await prisma.dealership.findMany({
        where: { id: { in: getDealershipIds(account) }, holdingId: { not: null } },
        select: { holdingId: true },
      });
      const holdingIds = [...new Set(dealerships.map((item) => item.holdingId).filter(Boolean))] as string[];
      items = holdingIds.length === 0
        ? []
        : await prisma.holding.findMany({
            where: buildHoldingWhere({ search, type, isActive }, { id: { in: holdingIds } }),
            include: {
              dealerships: {
                orderBy: [{ city: 'asc' }, { name: 'asc' }],
              },
            },
            orderBy: { name: 'asc' },
          });
    } else {
      throw new Error('Нет доступа.');
    }
    res.json({ items: items.map(normalizeHoldingResponse) });
  } catch (error) {
    res.status(403).json({ error: error instanceof Error ? error.message : 'Нет доступа.' });
  }
}

export async function handleListDealerships(req: Request, res: Response): Promise<void> {
  const account = req.authAccount;
  if (!account) {
    res.status(401).json({ error: 'Требуется авторизация.' });
    return;
  }

  try {
    let items;
    if (isPlatformSuperadmin(account)) {
      items = await getDealershipsSnapshot();
    } else if (isHoldingAdmin(account)) {
      items = await prisma.dealership.findMany({
        where: { holdingId: { in: getHoldingIds(account) } },
        include: {
          holding: true,
          _count: {
            select: { managerProfiles: true },
          },
        },
        orderBy: [{ city: 'asc' }, { name: 'asc' }],
      });
    } else if (isDealershipAdmin(account)) {
      items = await prisma.dealership.findMany({
        where: { id: { in: getDealershipIds(account) } },
        include: {
          holding: true,
          _count: {
            select: { managerProfiles: true },
          },
        },
        orderBy: [{ city: 'asc' }, { name: 'asc' }],
      });
    } else {
      throw new Error('Нет доступа.');
    }
    res.json({ items: items.map(normalizeDealershipResponse) });
  } catch (error) {
    res.status(403).json({ error: error instanceof Error ? error.message : 'Нет доступа.' });
  }
}

export async function handleCreateHolding(req: Request, res: Response): Promise<void> {
  const account = req.authAccount;
  if (!account) {
    res.status(401).json({ error: 'Требуется авторизация.' });
    return;
  }

  try {
    assertSuperadmin(account);
  } catch (error) {
    res.status(403).json({ error: error instanceof Error ? error.message : 'Нет доступа.' });
    return;
  }

  const body = (req.body || {}) as Record<string, unknown>;
  const name = parseString(body.name);
  const code = parseString(body.code);
  const type = parseHoldingType(body.type, 'own');
  const isActive = parseBoolean(body.isActive, true);
  const dealershipIds = parseDealershipIds(body.dealershipIds);

  if (!name) {
    res.status(400).json({ error: 'Название холдинга обязательно.' });
    return;
  }

  try {
    const created = await prisma.$transaction(async (tx) => {
      const resolvedCode = code ?? await generateUniqueHoldingCode(tx, name);
      const holding = await tx.holding.create({
        data: { name, code: resolvedCode, type, isActive },
      });

      if (dealershipIds.length > 0) {
        await tx.dealership.updateMany({
          where: { id: { in: dealershipIds } },
          data: { holdingId: holding.id },
        });
      }

      return tx.holding.findUniqueOrThrow({
        where: { id: holding.id },
        include: {
          dealerships: {
            orderBy: [{ city: 'asc' }, { name: 'asc' }],
          },
        },
      });
    });

    res.status(201).json({ item: normalizeHoldingResponse(created) });
  } catch (error) {
    console.error('Create holding error:', error);
    res.status(500).json({ error: 'Не удалось создать холдинг.' });
  }
}

export async function handleUpdateHolding(req: Request, res: Response): Promise<void> {
  const account = req.authAccount;
  if (!account) {
    res.status(401).json({ error: 'Требуется авторизация.' });
    return;
  }

  try {
    assertSuperadmin(account);
  } catch (error) {
    res.status(403).json({ error: error instanceof Error ? error.message : 'Нет доступа.' });
    return;
  }

  const holdingId = String(req.params.holdingId || '').trim();
  if (!holdingId) {
    res.status(400).json({ error: 'Некорректный holdingId.' });
    return;
  }

  const body = (req.body || {}) as Record<string, unknown>;
  const name = body.name != null ? parseString(body.name) : undefined;
  const code = body.code != null ? parseString(body.code) : undefined;
  const type = body.type != null ? parseHoldingType(body.type, 'own') : undefined;
  const isActive = body.isActive != null ? parseBoolean(body.isActive, true) : undefined;
  const dealershipIds = body.dealershipIds != null ? parseDealershipIds(body.dealershipIds) : undefined;

  if (body.name != null && !name) {
    res.status(400).json({ error: 'Название холдинга не может быть пустым.' });
    return;
  }

  try {
    await prisma.$transaction(async (tx) => {
      const holdingData: Prisma.HoldingUpdateInput = {};
      if (name !== undefined && name !== null) holdingData.name = name;
      if (code !== undefined) holdingData.code = code;
      if (type !== undefined) holdingData.type = type;
      if (isActive !== undefined) holdingData.isActive = isActive;

      await tx.holding.update({
        where: { id: holdingId },
        data: holdingData,
      });

      if (dealershipIds) {
        await tx.dealership.updateMany({
          where: { holdingId },
          data: { holdingId: null },
        });

        if (dealershipIds.length > 0) {
          await tx.dealership.updateMany({
            where: { id: { in: dealershipIds } },
            data: { holdingId },
          });
        }
      }
    });

    const updated = await prisma.holding.findUniqueOrThrow({
      where: { id: holdingId },
      include: {
        dealerships: {
          orderBy: [{ city: 'asc' }, { name: 'asc' }],
        },
      },
    });

    res.json({ item: normalizeHoldingResponse(updated) });
  } catch (error) {
    console.error('Update holding error:', error);
    res.status(500).json({ error: 'Не удалось обновить холдинг.' });
  }
}

export async function handleDeleteHolding(req: Request, res: Response): Promise<void> {
  const account = req.authAccount;
  if (!account) {
    res.status(401).json({ error: 'Требуется авторизация.' });
    return;
  }

  try {
    assertSuperadmin(account);
  } catch (error) {
    res.status(403).json({ error: error instanceof Error ? error.message : 'Нет доступа.' });
    return;
  }

  const holdingId = String(req.params.holdingId || '').trim();
  if (!holdingId) {
    res.status(400).json({ error: 'Некорректный holdingId.' });
    return;
  }

  try {
    await prisma.$transaction(async (tx) => {
      await tx.dealership.updateMany({
        where: { holdingId },
        data: { holdingId: null },
      });
      await tx.accountMembership.deleteMany({
        where: { holdingId },
      });
      await tx.holding.delete({
        where: { id: holdingId },
      });
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Delete holding error:', error);
    res.status(500).json({ error: 'Не удалось удалить холдинг.' });
  }
}

export async function handleCreateDealership(req: Request, res: Response): Promise<void> {
  const account = req.authAccount;
  if (!account) {
    res.status(401).json({ error: 'Требуется авторизация.' });
    return;
  }

  try {
    assertSuperadmin(account);
  } catch (error) {
    res.status(403).json({ error: error instanceof Error ? error.message : 'Нет доступа.' });
    return;
  }

  const body = (req.body || {}) as Record<string, unknown>;
  const name = parseString(body.name);
  const code = parseString(body.code);
  const city = parseString(body.city);
  const address = parseString(body.address);
  const holdingId = parseString(body.holdingId);
  const isActive = parseBoolean(body.isActive, true);

  if (!name) {
    res.status(400).json({ error: 'Название автосалона обязательно.' });
    return;
  }

  try {
    const created = await prisma.dealership.create({
      data: {
        name,
        code,
        city,
        address,
        holdingId,
        isActive,
      },
      include: {
        holding: true,
        _count: {
          select: { managerProfiles: true },
        },
      },
    });

    res.status(201).json({ item: normalizeDealershipResponse(created) });
  } catch (error) {
    console.error('Create dealership error:', error);
    res.status(500).json({ error: 'Не удалось создать автосалон.' });
  }
}

export async function handleUpdateDealership(req: Request, res: Response): Promise<void> {
  const account = req.authAccount;
  if (!account) {
    res.status(401).json({ error: 'Требуется авторизация.' });
    return;
  }

  try {
    if (!isPlatformSuperadmin(account) && !isHoldingAdmin(account) && !isDealershipAdmin(account)) {
      throw new Error('Нет доступа.');
    }
  } catch (error) {
    res.status(403).json({ error: error instanceof Error ? error.message : 'Нет доступа.' });
    return;
  }

  const dealershipId = String(req.params.dealershipId || '').trim();
  if (!dealershipId) {
    res.status(400).json({ error: 'Некорректный dealershipId.' });
    return;
  }

  const body = (req.body || {}) as Record<string, unknown>;
  const name = body.name != null ? parseString(body.name) : undefined;
  const code = body.code != null ? parseString(body.code) : undefined;
  const city = body.city != null ? parseString(body.city) : undefined;
  const address = body.address != null ? parseString(body.address) : undefined;
  const holdingId = body.holdingId != null ? parseString(body.holdingId) : undefined;
  const isActive = body.isActive != null ? parseBoolean(body.isActive, true) : undefined;

  if (body.name != null && !name) {
    res.status(400).json({ error: 'Название автосалона не может быть пустым.' });
    return;
  }

  try {
    const existing = await prisma.dealership.findUnique({
      where: { id: dealershipId },
      select: { id: true, holdingId: true },
    });
    if (!existing) {
      res.status(404).json({ error: 'Автосалон не найден.' });
      return;
    }
    if (!canManageDealershipForAccount(account, { dealershipId: existing.id, holdingId: existing.holdingId })) {
      res.status(403).json({ error: 'Нет доступа к этому автосалону.' });
      return;
    }

    const dealershipData: Prisma.DealershipUpdateInput = {};
    if (name !== undefined && name !== null) dealershipData.name = name;
    if (code !== undefined) dealershipData.code = code;
    if (city !== undefined) dealershipData.city = city;
    if (address !== undefined) dealershipData.address = address;
    if (holdingId !== undefined) {
      dealershipData.holding = holdingId
        ? { connect: { id: holdingId } }
        : { disconnect: true };
    }
    if (isActive !== undefined) dealershipData.isActive = isActive;

    const updated = await prisma.dealership.update({
      where: { id: dealershipId },
      data: dealershipData,
      include: {
        holding: true,
        _count: {
          select: { managerProfiles: true },
        },
      },
    });

    res.json({ item: normalizeDealershipResponse(updated) });
  } catch (error) {
    console.error('Update dealership error:', error);
    res.status(500).json({ error: 'Не удалось обновить автосалон.' });
  }
}

export async function handleDeleteDealership(req: Request, res: Response): Promise<void> {
  const account = req.authAccount;
  if (!account) {
    res.status(401).json({ error: 'Требуется авторизация.' });
    return;
  }

  try {
    assertSuperadmin(account);
  } catch (error) {
    res.status(403).json({ error: error instanceof Error ? error.message : 'Нет доступа.' });
    return;
  }

  const dealershipId = String(req.params.dealershipId || '').trim();
  if (!dealershipId) {
    res.status(400).json({ error: 'Некорректный dealershipId.' });
    return;
  }

  try {
    await prisma.accountMembership.deleteMany({
      where: { dealershipId },
    });
    await prisma.dealership.delete({
      where: { id: dealershipId },
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Delete dealership error:', error);
    res.status(500).json({ error: 'Не удалось удалить автосалон.' });
  }
}

export async function handleSyncMockOrganization(req: Request, res: Response): Promise<void> {
  const account = req.authAccount;
  if (!account) {
    res.status(401).json({ error: 'Требуется авторизация.' });
    return;
  }

  try {
    assertSuperadmin(account);
    const summary = await syncMockOrganization();
    res.json({ success: true, summary });
  } catch (error) {
    console.error('Sync mock organization error:', error);
    res.status(403).json({ error: error instanceof Error ? error.message : 'Не удалось синхронизировать структуру.' });
  }
}
