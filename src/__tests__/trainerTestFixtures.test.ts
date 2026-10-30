import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { synthesizeTrainerFixture } from '../testing/trainerTestFixtures';
const { speech } = vi.hoisted(() => ({ speech: vi.fn() }));
vi.mock('../lib/openaiClient', () => ({ openai: { audio: { speech: { create: speech } } } }));
const directories: string[] = [];
beforeEach(() => { speech.mockReset(); speech.mockResolvedValue({ arrayBuffer: async () => Buffer.alloc(1200, 1) }); });
afterEach(async () => { for (const dir of directories.splice(0)) await fs.rm(dir, { recursive: true, force: true }); });
async function root() { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'trainer-fixture-')); directories.push(dir); return dir; }
describe('full manager voice fixtures', () => {
  it('does not truncate the long-answer fixture and caches it for targeted reruns', async () => {
    const directory = await root();
    const text = `${'Важная подробность ответа. '.repeat(30)}Последний вопрос тоже нужно услышать целиком?`;
    const audio = await synthesizeTrainerFixture(text, undefined, directory);
    expect(speech.mock.calls[0][0].input.length).toBeGreaterThan(360); expect(speech.mock.calls[0][0].input).toContain('Последний вопрос тоже нужно услышать целиком?');
    expect(audio.mimeType).toBe('audio/wav'); expect(await synthesizeTrainerFixture(text, undefined, directory)).toEqual(audio); expect(speech).toHaveBeenCalledOnce();
  });
  it('honors cancellation before generating paid audio', async () => {
    const directory = await root(); const controller = new AbortController(); controller.abort();
    await expect(synthesizeTrainerFixture('Отмена', controller.signal, directory)).rejects.toBeDefined(); expect(speech).not.toHaveBeenCalled();
  });
});
