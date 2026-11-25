import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterEach, expect, it, vi } from 'vitest';
import { prisma } from '../db';
import { runImport } from '../imports/importManagement';
import { pickImportedSampleForScript } from '../voice/callSettingsManagement';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function fixture(run: (db: PrismaClient, feed: (items: unknown) => void) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'salesboost-import-presence-'));
  const db = new PrismaClient({ datasources: { db: { url: `file:${join(directory, 'test.db')}` } } });
  try {
    for (const name of ['20260604120000_add_import_sources', '20261125150000_import_item_presence']) {
      const sql = await readFile(join(process.cwd(), 'prisma/migrations', name, 'migration.sql'), 'utf8');
      for (const statement of sql.split(';').filter(value => value.trim())) await db.$executeRawUnsafe(statement);
    }
    await db.$executeRawUnsafe('ALTER TABLE import_sources ADD COLUMN holdingId TEXT');
    await db.importSource.create({ data: { id: 'source', holdingId: 'company', name: 'Test feed', url: 'https://example.test/feed',
      format: 'json', itemsPath: 'items', entityType: 'vehicle', aiConfigJson: JSON.stringify({
        entityType: 'vehicle', externalIdField: 'id', titleFields: ['name'], descriptionFields: [], importantFields: [], ignoredFields: [], fieldLabels: {},
      }) } });
    for (const name of ['importSource', 'importedItem', 'importRun'] as const) {
      for (const method of ['findUnique', 'findFirst', 'findMany', 'create', 'update', 'updateMany'] as const) {
        vi.spyOn(prisma[name] as any, method).mockImplementation((db[name][method] as any).bind(db[name]));
      }
    }
    vi.spyOn(prisma, '$transaction').mockImplementation(db.$transaction.bind(db) as any);
    let payload: unknown = [];
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: payload }))));
    await run(db, items => { payload = items; });
  } finally {
    await db.$disconnect();
    await rm(directory, { recursive: true, force: true });
  }
}

it('archives disappeared inventory, preserves its ID, excludes it from calls, and restores returning items', async () => {
  await fixture(async (db, feed) => {
    feed([{ id: 'old', name: 'Old car' }, { id: 'current', name: 'Current car' }]);
    expect((await runImport('source')).status).toBe('success');
    const old = await db.importedItem.findFirstOrThrow({ where: { externalId: 'old' } });
    feed([{ id: 'current', name: 'Current car' }]);
    expect((await runImport('source')).status).toBe('success');
    expect(await db.importedItem.findUnique({ where: { id: old.id } })).toMatchObject({ isActive: false, title: 'Old car' });
    await db.importedItem.updateMany({ data: { tagsJson: '["selected"]' } });
    expect(await pickImportedSampleForScript({ holdingId: 'company', dataConditionJson: '{"tags":["selected"]}' } as any))
      .toMatchObject({ externalId: 'current', isActive: true });
    feed([{ id: 'old', name: 'Returned car' }, { id: 'current', name: 'Current car' }]);
    expect((await runImport('source')).status).toBe('success');
    expect(await db.importedItem.findUnique({ where: { id: old.id } })).toMatchObject({ isActive: true, title: 'Returned car' });
    expect(await db.importedItem.count()).toBe(2);
  });
});

it('never archives unseen rows after a truncated or invalid snapshot or a failed download', async () => {
  await fixture(async (db, feed) => {
    feed([{ id: 'old', name: 'Existing car' }]); await runImport('source');
    feed(Array.from({ length: 501 }, (_, id) => ({ id: `new-${id}`, name: `Car ${id}` })));
    expect(await runImport('source')).toMatchObject({ status: 'success', skippedItems: 1 });
    expect(await db.importedItem.findFirst({ where: { externalId: 'old' } })).toMatchObject({ isActive: true });
    feed({ wrongPath: true });
    expect((await runImport('source')).status).toBe('error');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network unavailable')));
    expect((await runImport('source')).status).toBe('error');
    expect(await db.importedItem.count({ where: { isActive: true } })).toBe(501);
  });
}, 15000);

it('accepts an explicit empty snapshot without deleting historical rows', async () => {
  await fixture(async (db, feed) => {
    feed([{ id: 'old', name: 'Existing car' }]); await runImport('source');
    feed([]); expect((await runImport('source')).status).toBe('success');
    expect(await db.importedItem.count()).toBe(1);
    expect(await db.importedItem.count({ where: { isActive: true } })).toBe(0);
  });
});

it('reconciles an XML car feed by external ID without mixing up model names', async () => {
  await fixture(async (db) => {
    await db.importSource.update({ where: { id: 'source' }, data: { format: 'xml', itemsPath: 'data.cars.car',
      aiConfigJson: JSON.stringify({ entityType: 'vehicle', externalIdField: 'unique_id', titleFields: ['mark_id', 'folder_id'],
        descriptionFields: [], importantFields: [], ignoredFields: [], fieldLabels: {} }) } });
    let cars = '<car><unique_id>old</unique_id><mark_id>Toyota</mark_id><folder_id>Land Cruiser Prado</folder_id></car>';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(`<data><cars>${cars}</cars></data>`)));
    expect((await runImport('source')).status).toBe('success');
    cars = '<car><unique_id>current</unique_id><mark_id>Toyota</mark_id><folder_id>Land Cruiser</folder_id></car>';
    expect((await runImport('source')).status).toBe('success');
    expect(await db.importedItem.findMany({ where: { isActive: true }, select: { title: true } })).toEqual([{ title: 'Toyota Land Cruiser' }]);
    expect(await db.importedItem.findFirst({ where: { externalId: 'old' } })).toMatchObject({ isActive: false });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<data><cars><car><unique_id>prefix-only</unique_id></car>')));
    expect((await runImport('source')).status).toBe('error');
    expect(await db.importedItem.findMany({ where: { isActive: true }, select: { externalId: true } })).toEqual([{ externalId: 'current' }]);
  });
});

it('preserves the previous selection when an import is cancelled', async () => {
  await fixture(async (db, feed) => {
    feed([{ id: 'old', name: 'Existing car' }]); await runImport('source');
    feed([{ id: 'new', name: 'Another car' }]);
    vi.spyOn(prisma.importRun, 'findUnique').mockResolvedValue({ status: 'cancelled' } as any);
    expect((await runImport('source')).status).toBe('cancelled');
    expect(await db.importedItem.findFirst({ where: { externalId: 'old' } })).toMatchObject({ isActive: true });
  });
});
