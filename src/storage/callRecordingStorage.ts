import { createHash, randomUUID } from 'crypto';
import { createWriteStream } from 'fs';
import { mkdir, rename, rm, stat } from 'fs/promises';
import path from 'path';
import { Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';

export interface SavedCallRecording {
  key: string;
  size: number;
}

export interface CallRecordingStorage {
  save(input: { key: string; source: AsyncIterable<Uint8Array>; maxBytes: number }): Promise<SavedCallRecording>;
  resolvePath(key: string): string;
}

export function callRecordingKey(callId: string): string {
  const trimmed = callId.trim();
  const safeId = /^[A-Za-z0-9_-]{1,128}$/.test(trimmed)
    ? trimmed
    : createHash('sha256').update(trimmed).digest('hex');
  return `calls/${safeId}/recording.mp3`;
}

export function callRecordingUrl(callId: string): string {
  return `/api/admin/call-recordings/${encodeURIComponent(callId)}`;
}

export class LocalCallRecordingStorage implements CallRecordingStorage {
  private readonly rootDir: string;

  constructor(rootDir = process.env.CALL_RECORDINGS_DIR?.trim() || path.resolve(process.cwd(), 'storage', 'recordings')) {
    this.rootDir = path.resolve(rootDir);
  }

  resolvePath(key: string): string {
    const target = path.resolve(this.rootDir, key);
    if (target !== this.rootDir && !target.startsWith(`${this.rootDir}${path.sep}`)) {
      throw new Error('Invalid recording storage key');
    }
    return target;
  }

  async save(input: { key: string; source: AsyncIterable<Uint8Array>; maxBytes: number }): Promise<SavedCallRecording> {
    const target = this.resolvePath(input.key);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.${randomUUID()}.tmp`;
    let size = 0;
    const limiter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        size += chunk.length;
        if (size > input.maxBytes) {
          callback(new Error(`Recording exceeds ${input.maxBytes} bytes`));
          return;
        }
        callback(null, chunk);
      },
    });
    try {
      await pipeline(Readable.from(input.source), limiter, createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
      if (size === 0) throw new Error('Downloaded recording is empty');
      await rename(temporary, target);
      return { key: input.key, size };
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async exists(key: string): Promise<boolean> {
    return stat(this.resolvePath(key)).then((value) => value.isFile()).catch(() => false);
  }
}

export const callRecordingStorage = new LocalCallRecordingStorage();
