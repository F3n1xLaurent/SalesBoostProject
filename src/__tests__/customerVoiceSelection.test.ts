import { beforeEach, describe, expect, it, vi } from 'vitest';
const find = vi.hoisted(() => vi.fn());
vi.mock('../db', () => ({ prisma: { callCustomerVoice: { findFirst: find } } }));
import { resolveCustomerVoiceForProfile } from '../voice/customerVoiceSelection';
beforeEach(() => vi.resetAllMocks());
describe('shared hypothesis/production voice selection', () => {
  it('preserves the explicit profile voice, without fallback', async () => {
    const voice = { id: 'woman', name: 'Женский', elevenLabsCode: 'voice-id' };
    find.mockResolvedValue(voice);
    expect(await resolveCustomerVoiceForProfile({ voiceId: 'woman' }, true)).toBe(voice);
    expect(find).toHaveBeenCalledTimes(1);
  });
  it('selects the same enabled streaming fallback before prompt gender is determined', async () => {
    const fallback = { id: 'woman', name: 'Женский', elevenLabsCode: 'eleven-voice' };
    find.mockResolvedValueOnce({ id: 'old', name: 'Мужской', elevenLabsCode: null }).mockResolvedValueOnce(fallback);
    expect(await resolveCustomerVoiceForProfile({ voiceId: 'old' }, true)).toBe(fallback);
    expect(find).toHaveBeenLastCalledWith(expect.objectContaining({ orderBy: { createdAt: 'asc' }, where: expect.objectContaining({ isEnabled: true, isDeleted: false }) }));
  });
  it('uses the same fallback even when the plan has no profile voice', async () => {
    find.mockResolvedValue({ id: 'fallback', name: 'Женский', elevenLabsCode: 'eleven-voice' });
    expect((await resolveCustomerVoiceForProfile(null, true))?.id).toBe('fallback');
  });
  it('leaves legacy Agent voice resolution unchanged', async () => {
    const legacy = { id: 'old', name: 'Мужской', elevenLabsCode: null };
    find.mockResolvedValue(legacy);
    expect(await resolveCustomerVoiceForProfile({ voiceId: 'old' })).toBe(legacy);
    expect(find).toHaveBeenCalledTimes(1);
    expect(await resolveCustomerVoiceForProfile(null)).toBeNull();
  });
});
