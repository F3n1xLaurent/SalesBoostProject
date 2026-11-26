import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { PrismaClient } from '@prisma/client';
import { expect, it, vi } from 'vitest';
import { prisma } from '../db';
import { buildRealtimeCallPrompt, pickImportedSampleForScript } from '../voice/callSettingsManagement';

const { repairUsedTags } = createRequire(import.meta.url)('../../scripts/repair-import-used-tags.cjs');
const sourceId = 'cmwt4co6q04hazmyt960jxk30';
const scriptId = 'cmwue171a00karwkb3b7dqq46';
const selected = ['Автомат', 'В наличии', 'Кредит', 'Отличное состояние', 'С пробегом'];

async function fixture(run: (db: PrismaClient, backupRoot: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'salesboost-used-tag-test-'));
  const db = new PrismaClient({ datasources: { db: { url: `file:${join(directory, 'test.db')}` } } });
  try {
    const migration = await readFile('prisma/migrations/20260604120000_add_import_sources/migration.sql', 'utf8');
    for (const sql of migration.split(';').filter(value => value.trim())) await db.$executeRawUnsafe(sql);
    await db.$executeRawUnsafe('ALTER TABLE import_sources ADD COLUMN holdingId TEXT');
    await db.$executeRawUnsafe('ALTER TABLE imported_items ADD COLUMN isActive BOOLEAN NOT NULL DEFAULT true');
    await db.$executeRawUnsafe('CREATE TABLE call_scripts (id TEXT PRIMARY KEY, holdingId TEXT, dataConditionJson TEXT)');
    await db.$executeRawUnsafe('INSERT INTO call_scripts VALUES (?, ?, ?)', scriptId, 'company', JSON.stringify({ tags: selected }));
    await db.importSource.create({ data: { id: sourceId, holdingId: 'company', name: 'Cars', url: 'https://example.test',
      format: 'json', entityType: 'vehicle', itemsPath: 'items', aiConfigJson: '{}',
      tagRulesJson: '[{"id":"available","name":"В наличии","enabled":true,"condition":{"field":"availability","operator":"exists"}}]',
    } });
    for (const [id, mileage, tags, isActive] of [
      ['used', 60005, selected.slice(0, -1), true],
      ['new', 0, selected, true],
      ['archived', 10, [], false],
    ] as const) {
      await db.importedItem.create({ data: { id, importSourceId: sourceId, title: id, description: '', rawDataJson: '{}',
        normalizedDataJson: JSON.stringify({ run: mileage }), tagsJson: JSON.stringify(tags), contentHash: id, isActive } });
    }
    await run(db, join(directory, 'backups'));
  } finally { await db.$disconnect(); await rm(directory, { recursive: true, force: true }); }
}

it('previews without writing, then repairs atomically with a backup and is safe to repeat', async () => {
  await fixture(async (db, backupRoot) => {
    const before = await db.importedItem.findMany({ orderBy: { id: 'asc' } });
    const source = await db.importSource.findUniqueOrThrow({ where: { id: sourceId } });
    expect(await repairUsedTags(db, { backupRoot })).toMatchObject({ applied: false, total: 2, changedItems: 2,
      matchingBefore: 1, matchingAfterRepair: 1, backupPath: null });
    expect(await db.importedItem.findMany({ orderBy: { id: 'asc' } })).toEqual(before);

    const result = await repairUsedTags(db, { apply: true, backupRoot });
    expect(result).toMatchObject({ applied: true, ruleAdded: true, changedItems: 2, matchingAfterRepair: 1 });
    const backup = JSON.parse(await readFile(result.backupPath, 'utf8'));
    expect(backup.tagRulesJson).toBe(source.tagRulesJson);
    expect(backup.items).toEqual(expect.arrayContaining(before.filter(row => row.isActive).map(row => ({ id: row.id, tagsJson: row.tagsJson }))));
    expect((await stat(result.backupPath)).mode & 0o777).toBe(0o600);
    const rows = await db.importedItem.findMany({ orderBy: { id: 'asc' } });
    expect(rows.find(row => row.id === 'used')?.tagsJson).toBe(JSON.stringify(selected));
    expect(rows.find(row => row.id === 'new')?.tagsJson).toBe(JSON.stringify(selected.slice(0, -1)));
    expect(rows.find(row => row.id === 'archived')).toEqual(before.find(row => row.id === 'archived'));
    const rules = JSON.parse((await db.importSource.findUniqueOrThrow({ where: { id: sourceId } })).tagRulesJson);
    expect(rules).toContainEqual(JSON.parse(source.tagRulesJson)[0]);
    expect(rules).toContainEqual(expect.objectContaining({ name: 'С пробегом', enabled: true,
      condition: { field: 'run', operator: 'greaterThan', value: 0 } }));
    expect(await repairUsedTags(db, { apply: true, backupRoot })).toMatchObject({ ruleAdded: false, changedItems: 0, backupPath: null });
  });
});

it('does not overwrite an existing rule with different semantics', async () => {
  await fixture(async (db, backupRoot) => {
    const tagRulesJson = JSON.stringify([{ name: 'С пробегом', enabled: true, condition: { field: 'state', operator: 'equals', value: 'used' } }]);
    await db.importSource.update({ where: { id: sourceId }, data: { tagRulesJson } });
    await expect(repairUsedTags(db, { apply: true, backupRoot })).rejects.toThrow('different used-car rule');
    expect((await db.importSource.findUniqueOrThrow({ where: { id: sourceId } })).tagRulesJson).toBe(tagRulesJson);
  });
});

it('refuses unknown mileage before writing rules or tags', async () => {
  await fixture(async (db, backupRoot) => {
    await db.importedItem.update({ where: { id: 'used' }, data: { normalizedDataJson: '{}' } });
    const source = await db.importSource.findUniqueOrThrow({ where: { id: sourceId } });
    const before = await db.importedItem.findMany({ orderBy: { id: 'asc' } });
    await expect(repairUsedTags(db, { apply: true, backupRoot })).rejects.toThrow('Invalid mileage');
    expect(await db.importSource.findUniqueOrThrow({ where: { id: sourceId } })).toEqual(source);
    expect(await db.importedItem.findMany({ orderBy: { id: 'asc' } })).toEqual(before);
  });
});

it('rolls back rule and tag updates together if an item write fails', async () => {
  await fixture(async (db, backupRoot) => {
    const before = await db.importedItem.findMany({ orderBy: { id: 'asc' } });
    const source = await db.importSource.findUniqueOrThrow({ where: { id: sourceId } });
    await db.$executeRawUnsafe("CREATE TRIGGER fail_tags BEFORE UPDATE OF tagsJson ON imported_items WHEN NEW.id = 'used' BEGIN SELECT RAISE(ABORT, 'test failure'); END");
    await expect(repairUsedTags(db, { apply: true, backupRoot })).rejects.toThrow();
    expect((await db.importSource.findUniqueOrThrow({ where: { id: sourceId } })).tagRulesJson).toBe(source.tagRulesJson);
    expect(await db.importedItem.findMany({ orderBy: { id: 'asc' } })).toEqual(before);
  });
});

it('restores an empty call selection and supplies the actual vehicle to the call prompt', async () => {
  await fixture(async (db, backupRoot) => {
    const title = 'Toyota Land Cruiser Prado, 150 Series 4.0 AT';
    await db.importedItem.updateMany({ where: { isActive: true }, data: { tagsJson: JSON.stringify(selected.slice(0, -1)) } });
    await db.importedItem.update({ where: { id: 'used' }, data: { title, description: 'Пробег: 60005 км. Цвет: белый.' } });
    const script = { holdingId: 'company', dataConditionJson: JSON.stringify({ tags: selected }),
      name: 'Покупка авто студентом', context: 'Студент, недавно получил права. Не определился с выбором.',
      questionsJson: JSON.stringify([{ text: 'На машине рыжики есть?', required: true }]),
      objectionsJson: '[]', successCriteriaJson: '[]' };
    const find = vi.spyOn(prisma.importedItem, 'findMany').mockImplementation(db.importedItem.findMany.bind(db.importedItem));
    try {
      await expect(pickImportedSampleForScript(script as any)).rejects.toThrow('Не найден активный объект');
      expect(await repairUsedTags(db, { apply: true, backupRoot })).toMatchObject({ matchingBefore: 0, matchingAfterRepair: 1 });
      const item = await pickImportedSampleForScript(script as any);
      expect(item).toMatchObject({ id: 'used', title });
      const prompt = buildRealtimeCallPrompt({ script, importedItem: item, profile: null,
        holding: { name: 'Первый километр', description: '' } });
      expect(prompt).toContain(`Предмет обращения: ${title}`);
      expect(prompt).toContain('Пробег: 60005 км. Цвет: белый.');
      expect(prompt).toContain('На машине рыжики есть?');
      expect(prompt).not.toContain('Импортированная запись отсутствует');
      expect(prompt).not.toContain('Импортированная запись не выбрана');
    } finally { find.mockRestore(); }
  });
});
