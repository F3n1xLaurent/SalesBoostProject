import { mkdtemp, readFile, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { callRecordingKey, LocalCallRecordingStorage } from '../storage/callRecordingStorage';
import { findRecording } from '../voice/voximplantRecording';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('Voximplant recording response', () => {
  it('extracts record_id and record_url from records[]', () => {
    expect(findRecording({
      result: [{ records: [{ record_id: 12345, record_url: 'https://records.voximplant.com/example.mp3' }] }],
    })).toEqual({ recordId: '12345', recordUrl: 'https://records.voximplant.com/example.mp3' });
  });

  it('returns null while the recording is not finalized', () => {
    expect(findRecording({ result: [{ records: [] }] })).toBeNull();
  });
});

describe('local call recording storage', () => {
  it('stores an audio stream under a call-specific key', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'salesboost-recording-'));
    temporaryDirectories.push(directory);
    const storage = new LocalCallRecordingStorage(directory);
    const key = callRecordingKey('call-123');
    const saved = await storage.save({
      key,
      source: (async function* () { yield Buffer.from('audio-data'); })(),
      maxBytes: 1024,
    });

    expect(saved.size).toBe(10);
    expect(await readFile(storage.resolvePath(key), 'utf8')).toBe('audio-data');
  });

  it('rejects a recording larger than the configured limit', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'salesboost-recording-'));
    temporaryDirectories.push(directory);
    const storage = new LocalCallRecordingStorage(directory);
    await expect(storage.save({
      key: callRecordingKey('call-too-large'),
      source: (async function* () { yield Buffer.from('too-large'); })(),
      maxBytes: 3,
    })).rejects.toThrow('exceeds');
  });
});
