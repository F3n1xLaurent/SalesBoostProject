import { spawn } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import staticFfmpeg from 'ffmpeg-static';
import { prisma } from '../db';
import { callRecordingStorage, type CallRecordingStorage } from '../storage/callRecordingStorage';

export type TrainerRecordingInfo = {
  recordingStatus: 'pending' | 'processing' | 'ready' | 'failed' | null;
  recordingUrl: string | null;
  recordingError: string | null;
  recordingDurationSec?: number;
};
type RecordingTurn = { role?: string; audioBase64?: string; audioMimeType?: string };
type Session = { status: string; transcriptJson: string | null };
type State = { status: 'processing' | 'ready' | 'failed'; error?: string; durationSec?: number; turnCount?: number };
const MAX_INPUT_BYTES = 100 * 1024 * 1024;
const MAX_TURNS = 200;
export const TRAINER_RECORDING_GAP_SECONDS = 0.3;

export function trainerRecordingKey(id: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error('Invalid trainer recording id');
  return `trainers/${id}/recording.mp3`;
}
export function trainerRecordingUrl(id: string): string {
  trainerRecordingKey(id);
  return `/api/admin/trainer-recordings/${encodeURIComponent(id)}`;
}
function stateKey(id: string) { return trainerRecordingKey(id).replace(/recording\.mp3$/, 'state.json'); }

export function resolveTrainerFfmpeg(): string {
  if (process.env.FFMPEG_PATH?.trim()) return process.env.FFMPEG_PATH.trim();
  // Production installs FFmpeg with apt; npm ci --ignore-scripts deliberately
  // does not download the optional platform binary during the Docker build.
  if (existsSync('/usr/bin/ffmpeg')) return '/usr/bin/ffmpeg';
  return staticFfmpeg && existsSync(staticFfmpeg) ? staticFfmpeg : 'ffmpeg';
}

export function decodeTrainerRecordingTurns(transcriptJson: string | null) {
  const turns: RecordingTurn[] = JSON.parse(transcriptJson || '[]');
  if (!Array.isArray(turns) || turns.length === 0 || turns.length > MAX_TURNS) {
    throw new Error('В тренировке нет аудиореплик либо превышен лимит 200 реплик.');
  }
  let bytes = 0;
  return turns.map((turn, index) => {
    if (!turn || !['manager', 'client'].includes(turn.role || '') || !turn.audioBase64) {
      throw new Error(`У реплики ${index + 1} нет сохранённого аудио. Запись нельзя собрать полностью.`);
    }
    if (typeof turn.audioBase64 !== 'string' || turn.audioBase64.length > MAX_INPUT_BYTES * 1.4) {
      throw new Error('Превышен допустимый размер аудио тренировки.');
    }
    const audio = Buffer.from(turn.audioBase64, 'base64');
    bytes += audio.length;
    if (bytes > MAX_INPUT_BYTES) throw new Error('Превышен допустимый размер аудио тренировки.');
    let extension: string;
    if (audio.toString('ascii', 0, 4) === 'RIFF' && audio.toString('ascii', 8, 12) === 'WAVE') extension = 'wav';
    else if (audio.toString('ascii', 0, 4) === 'OggS') extension = 'ogg';
    else if (audio.toString('ascii', 4, 8) === 'ftyp') extension = 'm4a';
    else if (audio.toString('ascii', 0, 3) === 'ID3' || (audio[0] === 0xff && (audio[1] & 0xe0) === 0xe0)) extension = 'mp3';
    else throw new Error(`Неподдерживаемое аудио в реплике ${index + 1}.`);
    return { audio, extension };
  });
}

export function trainerConcatFilter(count: number): string {
  const filters = Array.from({ length: count }, (_, index) =>
    `[${index}:a]aresample=24000,aformat=sample_fmts=fltp:channel_layouts=mono,asetpts=PTS-STARTPTS`
      + (index < count - 1 ? `,apad=pad_dur=${TRAINER_RECORDING_GAP_SECONDS}` : '') + `[a${index}]`);
  return [...filters, Array.from({ length: count }, (_, index) => `[a${index}]`).join('') + `concat=n=${count}:v=0:a=1[joined]`].join(';');
}

async function runFfmpeg(args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(resolveTrainerFfmpeg(), args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    let stderr = '';
    let progress = '';
    let durationSec = 0;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 120_000);
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-2000); });
    child.stdout.on('data', (chunk: Buffer) => {
      progress += chunk.toString();
      const lines = progress.split('\n');
      progress = lines.pop() || '';
      for (const line of lines) if (line.startsWith('out_time_us=')) {
        const value = Number(line.slice('out_time_us='.length));
        if (Number.isFinite(value)) durationSec = Math.max(durationSec, value / 1_000_000);
      }
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(new Error(error.code === 'ENOENT' ? 'FFmpeg не установлен. Установите FFmpeg или задайте FFMPEG_PATH.' : 'Не удалось запустить FFmpeg.'));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Math.round(durationSec * 100) / 100);
      else {
        console.warn(`[trainer-recording] FFmpeg failed code=${code} timeout=${timedOut} details=${stderr}`);
        reject(new Error(timedOut ? 'Превышено время сборки записи тренировки.' : 'Не удалось преобразовать аудио тренировки.'));
      }
    });
  });
}

export async function renderTrainerRecording(transcriptJson: string | null, output: string): Promise<{ durationSec: number; turnCount: number }> {
  const turns = decodeTrainerRecordingTurns(transcriptJson);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'trainer-recording-'));
  try {
    const inputs: string[] = [];
    for (let index = 0; index < turns.length; index += 1) {
      const input = path.join(directory, `${index}.${turns[index].extension}`);
      await writeFile(input, turns[index].audio, { mode: 0o600 });
      inputs.push('-protocol_whitelist', 'file,pipe', '-i', input);
    }
    const durationSec = await runFfmpeg([
      '-hide_banner', '-nostdin', '-loglevel', 'error', '-y', ...inputs,
      '-filter_complex_threads', '1', '-filter_complex', trainerConcatFilter(turns.length),
      '-map', '[joined]', '-map_metadata', '-1', '-ac', '1', '-ar', '24000',
      '-c:a', 'libmp3lame', '-b:a', '96k', '-threads', '1', '-progress', 'pipe:1', '-f', 'mp3', output,
    ]);
    await chmod(output, 0o600);
    return { durationSec, turnCount: turns.length };
  } finally {
    // Only this function's validated mkdtemp directory is removed, never inputs
    // from the database, source voice recordings, or the persistent storage root.
    await rm(directory, { recursive: true, force: true });
  }
}

export class TrainerRecordingService {
  private tasks = new Map<string, Promise<TrainerRecordingInfo>>();
  private queue: Promise<unknown> = Promise.resolve();
  private isSessionBusy: (id: string) => boolean = () => false;
  constructor(private options: {
    storage: CallRecordingStorage;
    loadSession: (id: string) => Promise<Session | null>;
    render?: typeof renderTrainerRecording;
  }) {}
  setActivityCheck(check: (id: string) => boolean) { this.isSessionBusy = check; }

  private async state(id: string): Promise<State | null> {
    try { return JSON.parse(await readFile(this.options.storage.resolvePath(stateKey(id)), 'utf8')); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return null;
      throw error;
    }
  }
  private async saveState(id: string, state: State) {
    await this.options.storage.save({ key: stateKey(id), source: Readable.from([JSON.stringify(state)]), maxBytes: 8192 });
  }
  async info(id: string): Promise<TrainerRecordingInfo> {
    const key = trainerRecordingKey(id);
    const file = await stat(this.options.storage.resolvePath(key)).catch(() => null);
    const state = await this.state(id);
    if (file?.isFile() && file.size > 0) return {
      recordingStatus: 'ready', recordingUrl: trainerRecordingUrl(id), recordingError: null,
      recordingDurationSec: state?.durationSec,
    };
    return {
      recordingStatus: this.tasks.has(id) ? 'processing' : state?.status === 'failed' ? 'failed' : 'pending',
      recordingUrl: null, recordingError: state?.status === 'failed' ? state.error || 'Не удалось собрать запись.' : null,
    };
  }
  schedule(id: string): Promise<TrainerRecordingInfo> {
    trainerRecordingKey(id);
    const existing = this.tasks.get(id);
    if (existing) return existing;
    const task = this.queue.catch(() => undefined).then(() => this.build(id)).finally(() => this.tasks.delete(id));
    this.queue = task;
    this.tasks.set(id, task);
    return task;
  }
  private async build(id: string): Promise<TrainerRecordingInfo> {
    if (this.isSessionBusy(id)) return { recordingStatus: 'pending', recordingUrl: null, recordingError: null };
    const current = await this.info(id);
    if (current.recordingStatus === 'ready' || current.recordingStatus === 'failed') return current;
    const session = await this.options.loadSession(id);
    if (!session || !['completed', 'failed'].includes(session.status)) {
      return { recordingStatus: null, recordingUrl: null, recordingError: null };
    }
    let directory: string | undefined;
    try {
      await this.saveState(id, { status: 'processing' });
      directory = await mkdtemp(path.join(os.tmpdir(), 'trainer-recording-output-'));
      const output = path.join(directory, 'recording.mp3');
      const result = await (this.options.render || renderTrainerRecording)(session.transcriptJson, output);
      await this.options.storage.save({ key: trainerRecordingKey(id), source: createReadStream(output), maxBytes: MAX_INPUT_BYTES });
      await this.saveState(id, { status: 'ready', ...result });
      console.info(`[trainer-recording] ready session=${id} turns=${result.turnCount} duration_sec=${result.durationSec}`);
      return this.info(id);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Не удалось собрать запись тренировки.';
      await this.saveState(id, { status: 'failed', error: message });
      console.warn(`[trainer-recording] failed session=${id}: ${message}`);
      return { recordingStatus: 'failed', recordingUrl: null, recordingError: message };
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  }
  async forReport(id: string, status: string): Promise<TrainerRecordingInfo> {
    if (!['completed', 'failed'].includes(status)) return { recordingStatus: null, recordingUrl: null, recordingError: null };
    try {
      const info = await this.info(id);
      if (info.recordingStatus === 'pending' && !this.isSessionBusy(id)) void this.schedule(id).catch((error) => {
        console.warn('[trainer-recording] background task failed:', error instanceof Error ? error.message : error);
      });
      return info;
    } catch (error) {
      console.warn('[trainer-recording] storage unavailable:', error instanceof Error ? error.message : error);
      return { recordingStatus: 'failed', recordingUrl: null, recordingError: 'Хранилище записи недоступно. Отчёт тренировки доступен независимо от записи.' };
    }
  }
}

export const trainerRecordingService = new TrainerRecordingService({
  storage: callRecordingStorage,
  loadSession: (id) => prisma.trainerSession.findUnique({ where: { id }, select: { status: true, transcriptJson: true } }),
});
export function trainerRecordingPath(id: string) { return callRecordingStorage.resolvePath(trainerRecordingKey(id)); }
