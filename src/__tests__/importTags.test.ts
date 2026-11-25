import { afterEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../db';
import { openai } from '../lib/openaiClient';
import { handleListImportedTags, runImport } from '../imports/importManagement';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const rule = (name: string, enabled = true) => ({ id: name, name, enabled,
  condition: { field: 'kind', operator: 'equals', value: 'car' } });
const request = (holdingId?: string) => ({ query: holdingId ? { holdingId } : {},
  authAccount: { memberships: [{ role: 'holding_admin', holdingId: 'own' }] } }) as any;
const response = () => ({ json: vi.fn() }) as any;

describe('import tag catalogue shared by data filters and call scripts', () => {
  it('includes configured enabled tags before the next import run and preserves historical item tags', async () => {
    vi.spyOn(prisma.importSource, 'findMany').mockResolvedValue([{ tagRulesJson: JSON.stringify([
      rule('  Дополнительный  '), rule('Авто'), rule('Отключённый', false),
    ]) }] as any);
    vi.spyOn(prisma.importedItem, 'findMany').mockResolvedValue([
      { id: 'one', tagsJson: '["Авто","Исторический"]' },
      { id: 'two', tagsJson: '{"invalid":true}' },
    ] as any);
    const res = response();
    await handleListImportedTags(request('own'), res);
    expect(res.json).toHaveBeenCalledWith({ tags: ['Авто', 'Дополнительный', 'Исторический'] });
    expect(prisma.importSource.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { holdingId: 'own' } }));
    expect(prisma.importedItem.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { isActive: true, importSource: { holdingId: 'own' } } }));
  });

  it('includes tags beyond the previous 5000-item limit without loading every item at once', async () => {
    vi.spyOn(prisma.importSource, 'findMany').mockResolvedValue([]);
    const find = vi.spyOn(prisma.importedItem, 'findMany');
    for (let page = 0; page < 6; page++) {
      find.mockResolvedValueOnce(Array.from({ length: 1000 }, (_, index) => ({
        id: `row-${page * 1000 + index}`, tagsJson: '["Обычный"]',
      })) as any);
    }
    find.mockResolvedValueOnce([{ id: 'row-6000', tagsJson: '["Поздний"]' }] as any);
    const res = response();
    await handleListImportedTags(request('own'), res);
    expect(res.json.mock.calls[0][0].tags).toContain('Поздний');
    expect(find).toHaveBeenCalledTimes(7);
    expect(find.mock.calls[6][0]).toMatchObject({ take: 1000, cursor: { id: 'row-5999' }, skip: 1 });
  });

  it('uses accessible companies when no company filter is selected', async () => {
    vi.spyOn(prisma.importSource, 'findMany').mockResolvedValue([{ tagRulesJson: JSON.stringify([rule('Тег своей компании')]) }] as any);
    const find = vi.spyOn(prisma.importedItem, 'findMany').mockResolvedValue([]);
    const res = response();
    await handleListImportedTags(request(), res);
    expect(res.json.mock.calls[0][0].tags).toContain('Тег своей компании');
    expect(find).toHaveBeenCalledWith(expect.objectContaining({ where: { isActive: true, importSource: { holdingId: { in: ['own'] } } } }));
  });

  it('does not read another company when its ID is supplied explicitly', async () => {
    const sources = vi.spyOn(prisma.importSource, 'findMany');
    const items = vi.spyOn(prisma.importedItem, 'findMany');
    await expect(handleListImportedTags(request('other'), response())).rejects.toThrow('Нет доступа');
    expect(sources).not.toHaveBeenCalled(); expect(items).not.toHaveBeenCalled();
  });
});

describe('import rule tags survive supplementary AI tagging', () => {
  it.each([{ aiTags: [] }, { aiTags: ['Авто'] }])('keeps deterministic tags when AI returns $aiTags', async ({ aiTags }) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ items: [{ id: 'external', name: 'Car', kind: 'car' }] }))));
    vi.spyOn(prisma.importSource, 'findUnique').mockResolvedValue({ id: 'source', url: 'https://example.test/feed.json',
      format: 'json', itemsPath: 'items', aiConfigJson: JSON.stringify({ entityType: 'car', externalIdField: 'id', titleFields: ['name'], descriptionFields: ['kind'], importantFields: [], ignoredFields: [], fieldLabels: {} }),
      tagRulesJson: JSON.stringify([rule('Авто'), rule('Дополнительный')]),
    } as any);
    vi.spyOn(prisma.importRun, 'create').mockResolvedValue({ id: 'run', status: 'running' } as any);
    vi.spyOn(prisma.importRun, 'findUnique').mockResolvedValue({ status: 'running' } as any);
    vi.spyOn(prisma.importRun, 'update').mockImplementation(async ({ data }: any) => ({ id: 'run', ...data }) as any);
    vi.spyOn(prisma.importSource, 'update').mockResolvedValue({} as any);
    vi.spyOn(prisma.importedItem, 'findFirst').mockResolvedValue(null);
    vi.spyOn(prisma, '$transaction').mockImplementation(async (fn: any) => fn(prisma));
    vi.spyOn(prisma.importedItem, 'updateMany').mockResolvedValue({ count: 0 });
    let imported: any;
    vi.spyOn(prisma.importedItem, 'create').mockImplementation(async ({ data }: any) => (imported = { id: 'item', ...data }) as any);
    vi.spyOn(prisma.importedItem, 'findMany').mockImplementation(async () => [imported] as any);
    const update = vi.spyOn(prisma.importedItem, 'update').mockResolvedValue({} as any);
    vi.spyOn(openai.chat.completions, 'create').mockResolvedValue({ choices: [{ message: {
      content: JSON.stringify({ items: [{ itemId: 'item', tags: aiTags }] }),
    } }] } as any);
    const result = await runImport('source');
    expect(result.errorMessage).toBeUndefined();
    expect(result.status).toBe('success');
    expect(update).toHaveBeenCalledWith({ where: { id: 'item' }, data: { tagsJson: JSON.stringify(['Авто', 'Дополнительный']) } });
  });
});
