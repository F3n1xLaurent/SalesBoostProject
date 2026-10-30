import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalCallRecordingStorage } from '../storage/callRecordingStorage';
import {
  decodeTrainerRecordingTurns, renderTrainerRecording, resolveTrainerFfmpeg,
  TrainerRecordingService, trainerConcatFilter, trainerRecordingKey,
} from '../trainer/trainerRecording';

const directories: string[] = [];
async function temporary() { const dir = await mkdtemp(path.join(os.tmpdir(), 'trainer-recording-test-')); directories.push(dir); return dir; }
afterEach(async () => { await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
const session = { status: 'completed', transcriptJson: '[]' };
async function fixture() {
  const storage = new LocalCallRecordingStorage(await temporary());
  const loadSession = vi.fn(async (_id: string) => session);
  const render = vi.fn(async (_transcript: string | null, output: string) => {
    await writeFile(output, 'complete-mp3'); return { durationSec: 2.25, turnCount: 2 };
  });
  return { storage, loadSession, render, service: new TrainerRecordingService({ storage, loadSession, render }) };
}

describe('trainer recording background jobs', () => {
  it('deduplicates jobs, publishes atomically and reuses the stored recording after restart', async () => {
    const { service, render, storage, loadSession } = await fixture();
    const first = service.schedule('session');
    expect(service.schedule('session')).toBe(first);
    expect(await first).toMatchObject({ recordingStatus: 'ready', recordingDurationSec: 2.25 });
    expect(render).toHaveBeenCalledTimes(1);
    expect(await readFile(storage.resolvePath(trainerRecordingKey('session')), 'utf8')).toBe('complete-mp3');
    const restarted = new TrainerRecordingService({ storage, loadSession, render });
    expect(await restarted.forReport('session', 'completed')).toMatchObject({ recordingStatus: 'ready' });
    await restarted.schedule('session');
    expect(render).toHaveBeenCalledTimes(1);
  });

  it('returns pending report metadata without waiting for conversion', async () => {
    const { storage, loadSession } = await fixture();
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const render = vi.fn(async (_text: string | null, output: string) => {
      await gate; await writeFile(output, 'mp3'); return { durationSec: 2, turnCount: 2 };
    });
    const service = new TrainerRecordingService({ storage, loadSession, render });
    expect(await service.forReport('session', 'completed')).toMatchObject({ recordingStatus: 'pending' });
    expect(await service.info('session')).toMatchObject({ recordingStatus: 'processing' });
    finish();
    expect(await service.schedule('session')).toMatchObject({ recordingStatus: 'ready' });
  });

  it('only runs one encoder at a time, even for different sessions', async () => {
    const { storage, loadSession } = await fixture();
    let active = 0, maximum = 0;
    const render = vi.fn(async (_text: string | null, output: string) => {
      active++; maximum = Math.max(active, maximum);
      await new Promise((resolve) => setTimeout(resolve, 5));
      await writeFile(output, 'mp3'); active--;
      return { durationSec: 1, turnCount: 1 };
    });
    const service = new TrainerRecordingService({ storage, loadSession, render });
    await Promise.all([service.schedule('one'), service.schedule('two')]);
    expect(maximum).toBe(1);
  });

  it('does not process unfinished sessions', async () => {
    const { storage, render } = await fixture();
    const service = new TrainerRecordingService({ storage, render, loadSession: async () => ({ ...session, status: 'in_progress' }) });
    expect(await service.schedule('session')).toMatchObject({ recordingStatus: null });
    expect(await service.forReport('session', 'in_progress')).toMatchObject({ recordingStatus: null });
    expect(render).not.toHaveBeenCalled();
  });

  it('waits for an in-flight final voice even if leaving the page already completed the session', async () => {
    const { service, render } = await fixture();
    service.setActivityCheck(() => true);
    expect(await service.forReport('session', 'completed')).toMatchObject({ recordingStatus: 'pending' });
    expect(await service.schedule('session')).toMatchObject({ recordingStatus: 'pending' });
    expect(render).not.toHaveBeenCalled();
    service.setActivityCheck(() => false);
    expect(await service.schedule('session')).toMatchObject({ recordingStatus: 'ready' });
  });

  it('does not make the report fail when recording storage is unavailable', async () => {
    const { service } = await fixture();
    vi.spyOn(service, 'info').mockRejectedValue(new Error('disk unavailable'));
    expect(await service.forReport('session', 'completed')).toMatchObject({ recordingStatus: 'failed' });
  });

  it('persists an error without publishing partial audio or retrying on every report view', async () => {
    const { storage, loadSession } = await fixture();
    const render = vi.fn(async () => { throw new Error('У реплики нет сохранённого аудио.'); });
    const service = new TrainerRecordingService({ storage, loadSession, render });
    expect(await service.schedule('session')).toMatchObject({ recordingStatus: 'failed', recordingError: expect.stringContaining('нет сохранённого аудио') });
    expect(existsSync(storage.resolvePath(trainerRecordingKey('session')))).toBe(false);
    await service.forReport('session', 'completed');
    expect(render).toHaveBeenCalledTimes(1);
    // A deliberate CLI retry is allowed after fixing the source/problem.
    await service.schedule('session');
    expect(render).toHaveBeenCalledTimes(2);
  });

  it('recovers a stale processing marker without regenerating the evaluation', async () => {
    const { storage, loadSession, render } = await fixture();
    await storage.save({ key: 'trainers/session/state.json', source: (async function* () { yield Buffer.from('{"status":"processing"}'); })(), maxBytes: 8192 });
    const restarted = new TrainerRecordingService({ storage, loadSession, render });
    expect(await restarted.forReport('session', 'completed')).toMatchObject({ recordingStatus: 'pending' });
    await restarted.schedule('session');
    expect(render).toHaveBeenCalledTimes(1);
  });

  it('rejects path traversal and refuses to silently omit missing audio', () => {
    expect(() => trainerRecordingKey('../private')).toThrow('Invalid');
    expect(() => decodeTrainerRecordingTurns(JSON.stringify([{ role: 'client', text: 'Здравствуйте' }]))).toThrow('нет сохранённого аудио');
    expect(() => decodeTrainerRecordingTurns('[]')).toThrow();
    expect(() => decodeTrainerRecordingTurns(JSON.stringify([{ role: 'client', audioBase64: Buffer.from('html').toString('base64') }]))).toThrow('Неподдерживаемое');
  });

  it('normalizes each input and pads only the gaps, never the final word', () => {
    const graph = trainerConcatFilter(2);
    expect(graph.match(/aresample=24000/g)).toHaveLength(2);
    expect(graph.match(/apad=pad_dur=0\.3/g)).toHaveLength(1);
    expect(graph).toContain('[a0][a1]concat=n=2:v=0:a=1[joined]');
  });
});

function oneSecondWav(): Buffer {
  const wav = Buffer.alloc(44 + 16000 * 2);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVE', 8); wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(32000, 40);
  for (let i = 0; i < 16000; i++) wav.writeInt16LE(Math.round(Math.sin(i * Math.PI * 2 * 440 / 16000) * 8000), 44 + i * 2);
  return wav;
}
const ffmpeg = resolveTrainerFfmpeg();
const hasFfmpeg = spawnSync(ffmpeg, ['-version'], { timeout: 5000 }).status === 0;
it.runIf(hasFfmpeg)('really concatenates WAV and OGG/Opus into a decodable MP3 without clipping either turn', async () => {
  const directory = await temporary();
  const wav = oneSecondWav();
  const input = path.join(directory, 'input.wav');
  await writeFile(input, wav);
  const opus = execFileSync(ffmpeg, ['-v', 'error', '-i', input, '-c:a', 'libopus', '-f', 'ogg', 'pipe:1']);
  const output = path.join(directory, 'joined.mp3');
  const result = await renderTrainerRecording(JSON.stringify([
    { role: 'client', audioBase64: opus.toString('base64') },
    { role: 'manager', audioBase64: wav.toString('base64') },
  ]), output);
  const pcm = execFileSync(ffmpeg, ['-v', 'error', '-i', output, '-ac', '1', '-ar', '24000', '-f', 's16le', 'pipe:1']);
  expect(pcm.length / 48000).toBeCloseTo(2.3, 1);
  expect(result.turnCount).toBe(2);
  expect(result.durationSec).toBeGreaterThan(2.2);
  expect(result.durationSec).toBeLessThan(2.4);
}, 15_000);
