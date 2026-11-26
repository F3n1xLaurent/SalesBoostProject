import { afterEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../db';
import { assertCallScriptDataSelection, pickImportedSampleForScript } from '../voice/callSettingsManagement';

afterEach(() => vi.restoreAllMocks());
const script = (tags: string[]) => ({ holdingId: 'company', dataConditionJson: JSON.stringify({ holdingId: 'company', tags }) }) as any;

describe('call script data selection', () => {
  it('does not load random company inventory when the editor selection is empty', async () => {
    const find = vi.spyOn(prisma.importedItem, 'findMany').mockResolvedValue([{ title: 'Unrelated car' }] as any);
    expect(await pickImportedSampleForScript(script([]))).toBeNull();
    expect(find).not.toHaveBeenCalled();
  });
  it('uses only an item matching every explicitly selected tag', async () => {
    const selected = { title: 'Selected car', tagsJson: '["sedan","used"]' };
    vi.spyOn(prisma.importedItem, 'findMany').mockResolvedValue([
      { title: 'Other car', tagsJson: '["sedan"]' }, selected,
    ] as any);
    expect(await pickImportedSampleForScript(script(['sedan', 'used']))).toBe(selected);
  });
  it('rejects a configured selection instead of silently switching to a need-only call', async () => {
    vi.spyOn(prisma.importedItem, 'findMany').mockResolvedValue([{ title: 'Other car', tagsJson: '["other"]' }] as any);
    await expect(pickImportedSampleForScript(script(['selected']))).rejects.toThrow('Не найден активный объект со всеми тегами: «selected»');
  });
  it('rejects an empty feed when tags are configured', async () => {
    vi.spyOn(prisma.importedItem, 'findMany').mockResolvedValue([]);
    await expect(pickImportedSampleForScript(script(['selected']))).rejects.toThrow('Звонок без выбранного объекта не запускается');
  });
  it('does not treat separate matches for each tag as a matching vehicle', async () => {
    vi.spyOn(prisma.importedItem, 'findMany').mockResolvedValue([
      { title: 'New automatic car', tagsJson: '["Автомат","В наличии","Кредит","Отличное состояние"]' },
      { title: 'Used manual car', tagsJson: '["С пробегом","В наличии"]' },
    ] as any);
    await expect(pickImportedSampleForScript(script(['Автомат', 'В наличии', 'Кредит', 'Отличное состояние', 'С пробегом'])))
      .rejects.toThrow('Не найден активный объект');
  });
  it('finds a matching item on a later page', async () => {
    const selected = { title: 'Selected car', tagsJson: '["selected"]' };
    const find = vi.spyOn(prisma.importedItem, 'findMany')
      .mockResolvedValueOnce(Array.from({ length: 500 }, () => ({ tagsJson: '["other"]' })) as any)
      .mockResolvedValueOnce([selected] as any);
    expect(await pickImportedSampleForScript(script(['selected']))).toBe(selected);
    expect(find).toHaveBeenLastCalledWith(expect.objectContaining({ skip: 500 }));
  });
  it('rejects malformed selection settings instead of treating them as no selection', async () => {
    const find = vi.spyOn(prisma.importedItem, 'findMany');
    for (const dataConditionJson of ['invalid', 'null', '{"tags":"selected"}']) {
      await expect(pickImportedSampleForScript({ ...script([]), dataConditionJson })).rejects.toThrow('Некорректные условия выборки');
    }
    expect(find).not.toHaveBeenCalled();
  });
});

describe('saved call data selection', () => {
  it('blocks a previously queued call without an item when its script requires selection', () => {
    expect(() => assertCallScriptDataSelection(script(['С пробегом']), null)).toThrow('пересоздайте задание звонка');
  });
  it('preserves a saved item and intentional need-only scenarios', () => {
    expect(() => assertCallScriptDataSelection(script(['С пробегом']), 'saved-item')).not.toThrow();
    expect(() => assertCallScriptDataSelection(script([]), null)).not.toThrow();
    expect(() => assertCallScriptDataSelection({ dataConditionJson: '{}' }, null)).not.toThrow();
  });
});
