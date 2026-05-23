import fs from 'fs';
import path from 'path';
import type { PrismaClient } from '@prisma/client';

const CITY_DICTIONARY_PATH = path.resolve(process.cwd(), 'data', 'dictionaries', 'russian_city_names_unique_clean.txt');
const INSERT_BATCH_SIZE = 500;
const UPDATE_BATCH_SIZE = 200;

export function normalizeCitySearchName(name: string): string {
  return name.toLowerCase().replace(/ё/g, 'е');
}

function readCityNames(): string[] {
  const raw = fs.readFileSync(CITY_DICTIONARY_PATH, 'utf8');
  const unique = new Set<string>();

  for (const line of raw.split(/\r?\n/)) {
    const name = line.trim().replace(/\s+/g, ' ');
    if (name) unique.add(name);
  }

  return [...unique].sort((a, b) => a.localeCompare(b, 'ru'));
}

async function ensureCityDictionaryTable(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "city_dictionary" (
      "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      "name" TEXT NOT NULL,
      "searchName" TEXT NOT NULL,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  const columns = await prisma.$queryRawUnsafe<Array<{ name: string }>>('PRAGMA table_info("city_dictionary")');
  if (!columns.some((column) => column.name === 'searchName')) {
    await prisma.$executeRawUnsafe('ALTER TABLE "city_dictionary" ADD COLUMN "searchName" TEXT NOT NULL DEFAULT ""');
  }
  await prisma.$executeRawUnsafe('CREATE UNIQUE INDEX IF NOT EXISTS "city_dictionary_name_key" ON "city_dictionary"("name")');
  await prisma.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS "city_dictionary_searchName_idx" ON "city_dictionary"("searchName")');
}

async function getCityDictionaryCount(prisma: PrismaClient): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<Array<{ count: number | bigint }>>('SELECT COUNT(*) as count FROM "city_dictionary"');
  const count = rows[0]?.count ?? 0;
  return typeof count === 'bigint' ? Number(count) : count;
}

async function repairCitySearchNames(prisma: PrismaClient): Promise<void> {
  let lastId = 0;

  while (true) {
    const rows = await prisma.$queryRawUnsafe<Array<{ id: number; name: string; searchName: string }>>(
      'SELECT "id", "name", "searchName" FROM "city_dictionary" WHERE "id" > ? ORDER BY "id" ASC LIMIT ?',
      lastId,
      UPDATE_BATCH_SIZE,
    );
    if (rows.length === 0) return;

    for (const row of rows) {
      lastId = row.id;
      const normalized = normalizeCitySearchName(row.name);
      if (row.searchName === normalized) continue;

      await prisma.$executeRawUnsafe(
        'UPDATE "city_dictionary" SET "searchName" = ? WHERE "id" = ?',
        normalized,
        row.id,
      );
    }
  }
}

export async function seedCityDictionaryIfNeeded(prisma: PrismaClient): Promise<number> {
  await ensureCityDictionaryTable(prisma);

  let existingCount = await getCityDictionaryCount(prisma);
  if (existingCount > 0) {
    const rows = await prisma.$queryRawUnsafe<Array<{ count: number | bigint }>>('SELECT COUNT(*) as count FROM "city_dictionary" WHERE "searchName" = ""');
    const missingSearchNameCount = typeof rows[0]?.count === 'bigint' ? Number(rows[0].count) : rows[0]?.count ?? 0;
    if (missingSearchNameCount === 0) {
      await repairCitySearchNames(prisma);
      return 0;
    }

    await prisma.$executeRawUnsafe('DELETE FROM "city_dictionary"');
    existingCount = 0;
  }

  const cityNames = readCityNames();

  for (let offset = 0; offset < cityNames.length; offset += INSERT_BATCH_SIZE) {
    const batch = cityNames.slice(offset, offset + INSERT_BATCH_SIZE);
    const placeholders = batch.map(() => '(?, ?)').join(', ');
    const values = batch.flatMap((name) => [name, normalizeCitySearchName(name)]);
    await prisma.$executeRawUnsafe(
      `INSERT OR IGNORE INTO "city_dictionary" ("name", "searchName") VALUES ${placeholders}`,
      ...values,
    );
  }

  return getCityDictionaryCount(prisma);
}
