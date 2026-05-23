import type { Prisma } from '@prisma/client';
import type { Request, Response } from 'express';
import { prisma } from '../db';
import { normalizeCitySearchName, seedCityDictionaryIfNeeded } from '../data/cityDictionary';
import { MOCK_DEALERSHIP_SEEDS, MOCK_HOLDING_SEEDS } from '../super-admin/mockOrganization';
import { APP_ROLES } from './permissions';

type ScopedAccount = NonNullable<Express.Request['authAccount']>;
type HoldingType = 'own' | 'franchised';
type DealershipType = 'own' | 'franchised';
type DealershipDirection = 'new_cars' | 'used_cars';
type PhoneNumberOwnership = 'dealership' | 'user';

const DEFAULT_WORKING_HOURS_FROM = '09:00';
const DEFAULT_WORKING_HOURS_TO = '21:00';
const CITY_SEARCH_DEFAULT_LIMIT = 100;
const CITY_SEARCH_MAX_LIMIT = 100;

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
      type: dealership.type as DealershipType,
      directions: parseDealershipDirectionsJson(dealership.directionsJson),
      city: dealership.city,
      address: dealership.address,
      workingHoursFrom: dealership.workingHoursFrom,
      workingHoursTo: dealership.workingHoursTo,
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
    type: dealership.type as DealershipType,
    directions: parseDealershipDirectionsJson(dealership.directionsJson),
    city: dealership.city,
    address: dealership.address,
    workingHoursFrom: dealership.workingHoursFrom,
    workingHoursTo: dealership.workingHoursTo,
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

function parsePositiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
}

function parseBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value === 'true' || value === '1') return true;
    if (value === 'false' || value === '0') return false;
  }
  return fallback;
}

function parseTime(value: unknown): string | null {
  const parsed = String(value ?? '').trim();
  if (!/^\d{2}:\d{2}$/.test(parsed)) return null;
  const [hours, minutes] = parsed.split(':').map((part) => Number(part));
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return parsed;
}

function isValidTimeRange(from: string | null | undefined, to: string | null | undefined): boolean {
  if (!from || !to) return true;
  return to >= from;
}

function parseDealershipIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item || '').trim()).filter(Boolean))];
}

function parseHoldingType(value: unknown, fallback: HoldingType = 'own'): HoldingType {
  return value === 'franchised' ? 'franchised' : fallback;
}

function parseDealershipType(value: unknown, fallback: DealershipType = 'own'): DealershipType {
  return value === 'franchised' ? 'franchised' : fallback;
}

function parseDealershipDirections(value: unknown): DealershipDirection[] {
  if (!Array.isArray(value)) return [];
  const allowed = new Set<DealershipDirection>(['new_cars', 'used_cars']);
  return [...new Set(value.map((item) => String(item || '').trim()).filter((item): item is DealershipDirection => allowed.has(item as DealershipDirection)))];
}

function parseDealershipDirectionsJson(value: string | null | undefined): DealershipDirection[] {
  if (!value) return [];
  try {
    return parseDealershipDirections(JSON.parse(value));
  } catch {
    return [];
  }
}

function parsePhoneNumberOwnership(value: unknown, fallback: PhoneNumberOwnership = 'dealership'): PhoneNumberOwnership {
  return value === 'user' ? 'user' : fallback;
}

function formatPhoneNumber(value: unknown): string | null {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (!digits) return null;

  if (digits.length === 11 && (digits.startsWith('7') || digits.startsWith('8'))) {
    const local = digits.startsWith('8') ? `7${digits.slice(1)}` : digits;
    return `+${local[0]} ${local.slice(1, 4)} ${local.slice(4, 7)} ${local.slice(7, 9)} ${local.slice(9, 11)}`;
  }

  if (raw.startsWith('+')) {
    return `+${digits}`;
  }

  return digits.length > 10 ? `+${digits}` : digits;
}

function normalizePhoneNumberTypeResponse(type: Prisma.PhoneNumberTypeGetPayload<{}>) {
  return {
    id: type.id,
    name: type.name,
    ownership: type.ownership as PhoneNumberOwnership,
    isActive: type.isActive,
    createdAt: type.createdAt,
    updatedAt: type.updatedAt,
  };
}

function normalizePhoneNumberResponse(
  phoneNumber: Prisma.PhoneNumberGetPayload<{
    include: { type: true };
  }>,
) {
  return {
    id: phoneNumber.id,
    typeId: phoneNumber.typeId,
    typeName: phoneNumber.type.name,
    phone: phoneNumber.phone,
    dealershipId: phoneNumber.dealershipId,
    accountId: phoneNumber.accountId,
    isActive: phoneNumber.isActive,
    createdAt: phoneNumber.createdAt,
    updatedAt: phoneNumber.updatedAt,
  };
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

async function generateUniqueDealershipCode(name: string): Promise<string> {
  const base = slugifyHoldingCode(name);
  let candidate = base;
  let counter = 2;

  while (true) {
    const existing = await prisma.dealership.findUnique({
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
            type: 'own',
            directionsJson: JSON.stringify(['new_cars', 'used_cars']),
            city: seed.city,
            address: seed.address,
            workingHoursFrom: DEFAULT_WORKING_HOURS_FROM,
            workingHoursTo: DEFAULT_WORKING_HOURS_TO,
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
            type: 'own',
            directionsJson: JSON.stringify(['new_cars', 'used_cars']),
            city: seed.city,
            address: seed.address,
            workingHoursFrom: DEFAULT_WORKING_HOURS_FROM,
            workingHoursTo: DEFAULT_WORKING_HOURS_TO,
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

export async function handleListCities(req: Request, res: Response): Promise<void> {
  const account = req.authAccount;
  if (!account) {
    res.status(401).json({ error: 'Требуется авторизация.' });
    return;
  }

  const search = parseString(req.query.search);
  const limit = Math.min(parsePositiveInteger(req.query.limit, CITY_SEARCH_DEFAULT_LIMIT), CITY_SEARCH_MAX_LIMIT);
  const offset = parsePositiveInteger(req.query.offset, 0);

  try {
    await seedCityDictionaryIfNeeded(prisma);
    const normalizedSearch = search ? normalizeCitySearchName(search) : null;
    const items = normalizedSearch
      ? await prisma.$queryRawUnsafe<Array<{ name: string }>>(
          `
            SELECT "name"
            FROM "city_dictionary"
            WHERE "searchName" LIKE ?
            ORDER BY
              CASE
                WHEN "searchName" = ? THEN 0
                WHEN "searchName" LIKE ? THEN 1
                ELSE 2
              END,
              "name" ASC
            LIMIT ? OFFSET ?
          `,
          `%${normalizedSearch}%`,
          normalizedSearch,
          `${normalizedSearch}%`,
          limit + 1,
          offset,
        )
      : await prisma.cityDictionary.findMany({
          orderBy: { name: 'asc' },
          skip: offset,
          take: limit + 1,
          select: { name: true },
        });
    const hasMore = items.length > limit;

    res.json({
      items: items.slice(0, limit).map((item) => item.name),
      limit,
      offset,
      hasMore,
    });
  } catch (error) {
    console.error('List cities error:', error);
    res.status(500).json({ error: 'Не удалось загрузить города.' });
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
  const type = parseDealershipType(body.type, 'own');
  const directions = parseDealershipDirections(body.directions);
  const city = parseString(body.city);
  const address = parseString(body.address);
  const workingHoursFrom = parseTime(body.workingHoursFrom) ?? DEFAULT_WORKING_HOURS_FROM;
  const workingHoursTo = parseTime(body.workingHoursTo) ?? DEFAULT_WORKING_HOURS_TO;
  const holdingId = parseString(body.holdingId);
  const isActive = parseBoolean(body.isActive, true);

  if (!name) {
    res.status(400).json({ error: 'Название автосалона обязательно.' });
    return;
  }
  if ((body.workingHoursFrom != null && !parseTime(body.workingHoursFrom)) || (body.workingHoursTo != null && !parseTime(body.workingHoursTo))) {
    res.status(400).json({ error: 'Укажите время работы автосалона в формате 00:00.' });
    return;
  }
  if (!isValidTimeRange(workingHoursFrom, workingHoursTo)) {
    res.status(400).json({ error: 'Время окончания работы не может быть меньше времени начала.' });
    return;
  }

  try {
    const resolvedCode = code ?? await generateUniqueDealershipCode(name);
    const created = await prisma.dealership.create({
      data: {
        name,
        code: resolvedCode,
        type,
        directionsJson: JSON.stringify(directions),
        city,
        address,
        workingHoursFrom,
        workingHoursTo,
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
  const type = body.type != null ? parseDealershipType(body.type, 'own') : undefined;
  const directions = body.directions != null ? parseDealershipDirections(body.directions) : undefined;
  const city = body.city != null ? parseString(body.city) : undefined;
  const address = body.address != null ? parseString(body.address) : undefined;
  const workingHoursFrom = body.workingHoursFrom != null ? parseTime(body.workingHoursFrom) : undefined;
  const workingHoursTo = body.workingHoursTo != null ? parseTime(body.workingHoursTo) : undefined;
  const holdingId = body.holdingId != null ? parseString(body.holdingId) : undefined;
  const isActive = body.isActive != null ? parseBoolean(body.isActive, true) : undefined;

  if (body.name != null && !name) {
    res.status(400).json({ error: 'Название автосалона не может быть пустым.' });
    return;
  }
  if ((body.workingHoursFrom != null && !workingHoursFrom) || (body.workingHoursTo != null && !workingHoursTo)) {
    res.status(400).json({ error: 'Укажите время работы автосалона в формате 00:00.' });
    return;
  }

  try {
    const existing = await prisma.dealership.findUnique({
      where: { id: dealershipId },
      select: { id: true, holdingId: true, workingHoursFrom: true, workingHoursTo: true },
    });
    if (!existing) {
      res.status(404).json({ error: 'Автосалон не найден.' });
      return;
    }
    if (!canManageDealershipForAccount(account, { dealershipId: existing.id, holdingId: existing.holdingId })) {
      res.status(403).json({ error: 'Нет доступа к этому автосалону.' });
      return;
    }

    const nextWorkingHoursFrom = workingHoursFrom !== undefined ? workingHoursFrom : existing.workingHoursFrom;
    const nextWorkingHoursTo = workingHoursTo !== undefined ? workingHoursTo : existing.workingHoursTo;
    if (!isValidTimeRange(nextWorkingHoursFrom, nextWorkingHoursTo)) {
      res.status(400).json({ error: 'Время окончания работы не может быть меньше времени начала.' });
      return;
    }

    const dealershipData: Prisma.DealershipUpdateInput = {};
    if (name !== undefined && name !== null) dealershipData.name = name;
    if (code !== undefined) dealershipData.code = code;
    if (type !== undefined) dealershipData.type = type;
    if (directions !== undefined) dealershipData.directionsJson = JSON.stringify(directions);
    if (city !== undefined) dealershipData.city = city;
    if (address !== undefined) dealershipData.address = address;
    if (workingHoursFrom !== undefined && workingHoursFrom !== null) dealershipData.workingHoursFrom = workingHoursFrom;
    if (workingHoursTo !== undefined && workingHoursTo !== null) dealershipData.workingHoursTo = workingHoursTo;
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

export async function handleListPhoneNumberTypes(req: Request, res: Response): Promise<void> {
  const account = req.authAccount;
  if (!account) {
    res.status(401).json({ error: 'Требуется авторизация.' });
    return;
  }

  const ownershipRaw = parseString(req.query.ownership);
  const ownership = ownershipRaw === 'dealership' || ownershipRaw === 'user' ? ownershipRaw : null;
  const onlyActive = parseString(req.query.active) === 'true';

  try {
    const items = await prisma.phoneNumberType.findMany({
      where: {
        ...(ownership ? { ownership } : {}),
        ...(onlyActive ? { isActive: true } : {}),
      },
      orderBy: [{ ownership: 'asc' }, { name: 'asc' }],
    });
    res.json({ items: items.map(normalizePhoneNumberTypeResponse) });
  } catch (error) {
    console.error('List phone number types error:', error);
    res.status(500).json({ error: 'Не удалось загрузить типы номеров.' });
  }
}

export async function handleCreatePhoneNumberType(req: Request, res: Response): Promise<void> {
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
  const ownership = parsePhoneNumberOwnership(body.ownership);
  const isActive = parseBoolean(body.isActive, true);

  if (!name) {
    res.status(400).json({ error: 'Название типа номера обязательно.' });
    return;
  }

  try {
    const created = await prisma.phoneNumberType.create({
      data: { name, ownership, isActive },
    });
    res.status(201).json({ item: normalizePhoneNumberTypeResponse(created) });
  } catch (error) {
    console.error('Create phone number type error:', error);
    res.status(500).json({ error: 'Не удалось создать тип номера.' });
  }
}

export async function handleUpdatePhoneNumberType(req: Request, res: Response): Promise<void> {
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

  const typeId = String(req.params.typeId || '').trim();
  const body = (req.body || {}) as Record<string, unknown>;
  const name = body.name != null ? parseString(body.name) : undefined;
  const ownership = body.ownership != null ? parsePhoneNumberOwnership(body.ownership) : undefined;
  const isActive = body.isActive != null ? parseBoolean(body.isActive, true) : undefined;

  if (!typeId) {
    res.status(400).json({ error: 'Некорректный typeId.' });
    return;
  }
  if (body.name != null && !name) {
    res.status(400).json({ error: 'Название типа номера не может быть пустым.' });
    return;
  }

  try {
    const updated = await prisma.phoneNumberType.update({
      where: { id: typeId },
      data: {
        ...(name !== undefined && name !== null ? { name } : {}),
        ...(ownership !== undefined ? { ownership } : {}),
        ...(isActive !== undefined ? { isActive } : {}),
      },
    });
    res.json({ item: normalizePhoneNumberTypeResponse(updated) });
  } catch (error) {
    console.error('Update phone number type error:', error);
    res.status(500).json({ error: 'Не удалось обновить тип номера.' });
  }
}

export async function handleListDealershipPhoneNumbers(req: Request, res: Response): Promise<void> {
  const account = req.authAccount;
  if (!account) {
    res.status(401).json({ error: 'Требуется авторизация.' });
    return;
  }

  const dealershipId = String(req.params.dealershipId || '').trim();
  if (!dealershipId) {
    res.status(400).json({ error: 'Некорректный dealershipId.' });
    return;
  }

  try {
    const dealership = await prisma.dealership.findUnique({
      where: { id: dealershipId },
      select: { id: true, holdingId: true },
    });
    if (!dealership) {
      res.status(404).json({ error: 'Автосалон не найден.' });
      return;
    }
    if (!canManageDealershipForAccount(account, { dealershipId: dealership.id, holdingId: dealership.holdingId })) {
      res.status(403).json({ error: 'Нет доступа к этому автосалону.' });
      return;
    }

    const items = await prisma.phoneNumber.findMany({
      where: { dealershipId },
      include: { type: true },
      orderBy: [{ isActive: 'desc' }, { createdAt: 'desc' }],
    });
    res.json({ items: items.map(normalizePhoneNumberResponse) });
  } catch (error) {
    console.error('List dealership phone numbers error:', error);
    res.status(500).json({ error: 'Не удалось загрузить номера телефонов.' });
  }
}

export async function handleCreateDealershipPhoneNumber(req: Request, res: Response): Promise<void> {
  const account = req.authAccount;
  if (!account) {
    res.status(401).json({ error: 'Требуется авторизация.' });
    return;
  }

  const dealershipId = String(req.params.dealershipId || '').trim();
  const body = (req.body || {}) as Record<string, unknown>;
  const typeId = parseString(body.typeId);
  const phone = formatPhoneNumber(body.phone);
  const isActive = parseBoolean(body.isActive, true);

  if (!dealershipId) {
    res.status(400).json({ error: 'Некорректный dealershipId.' });
    return;
  }
  if (!typeId) {
    res.status(400).json({ error: 'Выберите тип номера.' });
    return;
  }
  if (!phone) {
    res.status(400).json({ error: 'Укажите номер телефона.' });
    return;
  }

  try {
    const dealership = await prisma.dealership.findUnique({
      where: { id: dealershipId },
      select: { id: true, holdingId: true },
    });
    if (!dealership) {
      res.status(404).json({ error: 'Автосалон не найден.' });
      return;
    }
    if (!canManageDealershipForAccount(account, { dealershipId: dealership.id, holdingId: dealership.holdingId })) {
      res.status(403).json({ error: 'Нет доступа к этому автосалону.' });
      return;
    }

    const type = await prisma.phoneNumberType.findUnique({
      where: { id: typeId },
      select: { id: true, ownership: true, isActive: true },
    });
    if (!type || type.ownership !== 'dealership' || !type.isActive) {
      res.status(400).json({ error: 'Выберите активный тип номера для автосалона.' });
      return;
    }

    const created = await prisma.phoneNumber.create({
      data: { dealershipId, typeId, phone, isActive },
      include: { type: true },
    });
    res.status(201).json({ item: normalizePhoneNumberResponse(created) });
  } catch (error) {
    console.error('Create dealership phone number error:', error);
    res.status(500).json({ error: 'Не удалось добавить номер телефона.' });
  }
}

export async function handleUpdateDealershipPhoneNumber(req: Request, res: Response): Promise<void> {
  const account = req.authAccount;
  if (!account) {
    res.status(401).json({ error: 'Требуется авторизация.' });
    return;
  }

  const phoneNumberId = String(req.params.phoneNumberId || '').trim();
  const body = (req.body || {}) as Record<string, unknown>;
  const typeId = body.typeId != null ? parseString(body.typeId) : undefined;
  const phone = body.phone != null ? formatPhoneNumber(body.phone) : undefined;
  const isActive = body.isActive != null ? parseBoolean(body.isActive, true) : undefined;

  if (!phoneNumberId) {
    res.status(400).json({ error: 'Некорректный phoneNumberId.' });
    return;
  }
  if (body.phone != null && !phone) {
    res.status(400).json({ error: 'Укажите номер телефона.' });
    return;
  }

  try {
    const existing = await prisma.phoneNumber.findUnique({
      where: { id: phoneNumberId },
      include: { dealership: { select: { id: true, holdingId: true } } },
    });
    if (!existing || !existing.dealership) {
      res.status(404).json({ error: 'Номер телефона не найден.' });
      return;
    }
    if (!canManageDealershipForAccount(account, { dealershipId: existing.dealership.id, holdingId: existing.dealership.holdingId })) {
      res.status(403).json({ error: 'Нет доступа к этому автосалону.' });
      return;
    }

    if (typeId) {
      const type = await prisma.phoneNumberType.findUnique({
        where: { id: typeId },
        select: { id: true, ownership: true, isActive: true },
      });
      if (!type || type.ownership !== 'dealership' || !type.isActive) {
        res.status(400).json({ error: 'Выберите активный тип номера для автосалона.' });
        return;
      }
    }

    const updated = await prisma.phoneNumber.update({
      where: { id: phoneNumberId },
      data: {
        ...(typeId !== undefined && typeId !== null ? { typeId } : {}),
        ...(phone !== undefined && phone !== null ? { phone } : {}),
        ...(isActive !== undefined ? { isActive } : {}),
      },
      include: { type: true },
    });
    res.json({ item: normalizePhoneNumberResponse(updated) });
  } catch (error) {
    console.error('Update dealership phone number error:', error);
    res.status(500).json({ error: 'Не удалось обновить номер телефона.' });
  }
}

export async function handleDeleteDealershipPhoneNumber(req: Request, res: Response): Promise<void> {
  const account = req.authAccount;
  if (!account) {
    res.status(401).json({ error: 'Требуется авторизация.' });
    return;
  }

  const phoneNumberId = String(req.params.phoneNumberId || '').trim();
  if (!phoneNumberId) {
    res.status(400).json({ error: 'Некорректный phoneNumberId.' });
    return;
  }

  try {
    const existing = await prisma.phoneNumber.findUnique({
      where: { id: phoneNumberId },
      include: { dealership: { select: { id: true, holdingId: true } } },
    });
    if (!existing || !existing.dealership) {
      res.status(404).json({ error: 'Номер телефона не найден.' });
      return;
    }
    if (!canManageDealershipForAccount(account, { dealershipId: existing.dealership.id, holdingId: existing.dealership.holdingId })) {
      res.status(403).json({ error: 'Нет доступа к этому автосалону.' });
      return;
    }

    await prisma.phoneNumber.delete({ where: { id: phoneNumberId } });
    res.json({ success: true });
  } catch (error) {
    console.error('Delete dealership phone number error:', error);
    res.status(500).json({ error: 'Не удалось удалить номер телефона.' });
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
