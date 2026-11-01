import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { combineTrainerVoiceMessages, transcribeTrainerVoice } from '../trainer/trainerVoicePipeline';
import { TrainerSimulationStore, type TrainerSimulationRow } from '../trainer/trainerSimulationStore';

const { transcribe } = vi.hoisted(() => ({ transcribe: vi.fn() }));
vi.mock('../voice/stt', () => ({ transcribeVoiceFast: transcribe }));

describe('shared production trainer voice pipeline', () => {
  it('transcribes the complete voice and removes temporary files afterwards', async () => {
    let filename = ''; const audio = Buffer.alloc(3000, 7);
    transcribe.mockImplementationOnce(async (file: string) => { filename = file; expect(await fs.readFile(file)).toEqual(audio); return 'Вся длинная реплика с паузой и последним вопросом'; });
    expect(await transcribeTrainerVoice(audio.toString('base64'), 'audio/wav')).toContain('последним вопросом');
    await expect(fs.stat(filename)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('cleans up temporary files even when STT fails and rejects empty voices', async () => {
    let filename = '';
    transcribe.mockImplementationOnce(async (file: string) => { filename = file; throw new Error('STT unavailable'); });
    await expect(transcribeTrainerVoice(Buffer.alloc(1000).toString('base64'), 'audio/ogg')).rejects.toThrow('STT unavailable');
    await expect(fs.stat(filename)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(transcribeTrainerVoice('', 'audio/ogg')).rejects.toThrow('короткое');
  });
  it('keeps a single input unchanged without audio transcoding and rejects empty collections', async () => {
    const message = { audioBase64: 'whole-message', mimeType: 'audio/ogg' };
    expect(await combineTrainerVoiceMessages([message])).toBe(message);
    await expect(combineTrainerVoiceMessages([])).rejects.toThrow('Недопустимое число');
  });
  it('isolated persistence cannot modify the original session and honors cancellation/closure', async () => {
    const original = { id: 'original', status: 'in_progress', transcriptJson: '[]' } as TrainerSimulationRow;
    const controller = new AbortController(); const store = new TrainerSimulationStore(original, controller.signal);
    await store.update({ status: 'completed' }); expect(original.status).toBe('in_progress'); expect(store.row.status).toBe('completed');
    store.closed = true; await expect(store.update({ status: 'failed' })).rejects.toThrow('закрыта');
    controller.abort(); await expect(store.load()).rejects.toBeDefined();
  });
  it('the isolated adapter invokes the same initialization, STT, turn, and audio functions as normal training', () => {
    const source = readFileSync('src/server.ts', 'utf8');
    const adapter = source.slice(source.indexOf('const trainerAutoTesting ='), source.indexOf("app.get('/api/admin/auto-testing/trainer/sources'"));
    for (const name of ['initializeTrainerDialog(', 'processTrainerVoiceMessage(', 'TrainerSimulationStore(']) expect(adapter).toContain(name);
    const shared = source.slice(source.indexOf('async function processTrainerVoiceMessage('), source.indexOf('async function updateTrainerStreakOnCompletion('));
    for (const name of ['trainerVoiceTurns.submit(', 'transcribeTrainerVoice(', 'runTrainerSessionTurn(', 'combineTrainerVoiceMessages(', 'turnControl']) expect(shared).toContain(name);
    const endpoint = source.slice(source.indexOf("app.post('/api/trainer/session/:id/voice-message'"), source.indexOf("app.get('/api/trainer/session/:id/report'"));
    expect(endpoint).toContain('processTrainerVoiceMessage('); expect(endpoint).not.toContain('claimTrainerTurn(');
    expect(source).toContain("if (!params.simulation) scheduleTrainerSessionFinalization(updated.id)");
    expect(adapter).not.toContain('prisma.trainerSession.create'); expect(adapter).not.toContain('prisma.trainerSession.update');
    expect(source.match(/const session = params\.simulation \? await params\.simulation\.load\(\)/g)).toHaveLength(2);
  });
});
