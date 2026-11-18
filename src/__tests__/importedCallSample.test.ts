import { afterEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../db';
import { pickImportedSampleForScript } from '../voice/callSettingsManagement';

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
  it('falls back to the need instead of unrelated inventory when nothing matches', async () => {
    vi.spyOn(prisma.importedItem, 'findMany').mockResolvedValue([{ title: 'Other car', tagsJson: '["other"]' }] as any);
    expect(await pickImportedSampleForScript(script(['selected']))).toBeNull();
  });
});
