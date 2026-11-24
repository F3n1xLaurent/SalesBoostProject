import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { APIConnectionError } from 'openai';
import { openai } from '../lib/openaiClient';
import { mergeCallRetranscription, retranscribeCallRecording } from '../voice/callRetranscription';

afterEach(() => vi.restoreAllMocks());

const original = [
  { role: 'manager' as const, text: 'Добрый день, меня зовут Никита. Чем могу помочь?' },
  { role: 'client' as const, text: 'Звоню по Шкоде Октавии. Она еще в продаже?' },
  { role: 'manager' as const, text: '¿Bien?' },
  { role: 'client' as const, text: 'Какой у нее пробег?' },
];

const segments = [
  { speaker: 'A', start: 1, end: 3, text: 'Добрый день, меня зовут Никита. Чем могу помочь?' },
  { speaker: 'B', start: 4, end: 6, text: 'Звоню по Шкоде Октавии. Она еще в продаже?' },
  { speaker: 'A', start: 7, end: 8, text: 'Нет.' },
  { speaker: 'B', start: 9, end: 10, text: 'Какой у нее пробег?' },
];

describe('call recording second-pass transcription', () => {
  it('reopens and replays the complete upload after a connection failure', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'asr-upload-retry-'));
    const filepath = join(directory, 'synthetic.wav');
    await writeFile(filepath, 'synthetic upload bytes');
    const uploads: string[] = [];
    const create = vi.spyOn(openai.audio.transcriptions, 'create').mockImplementation((async (request: any) => {
      const chunks = [];
      for await (const chunk of request.file) chunks.push(chunk);
      uploads.push(Buffer.concat(chunks).toString());
      if (uploads.length === 1) throw new APIConnectionError({ cause: new Error('synthetic ECONNRESET') });
      return { segments };
    }) as any);
    try {
      expect(await retranscribeCallRecording(filepath, original)).not.toBeNull();
      expect(uploads).toEqual(['synthetic upload bytes', 'synthetic upload bytes']);
      expect(create.mock.calls.every(call => call[1]?.maxRetries === 0)).toBe(true);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('does not retry invalid requests or hide an exhausted network failure', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'asr-upload-failure-'));
    const filepath = join(directory, 'synthetic.wav');
    await writeFile(filepath, 'synthetic');
    const invalid = Object.assign(new Error('synthetic invalid request'), { status: 400 });
    const create = vi.spyOn(openai.audio.transcriptions, 'create').mockRejectedValue(invalid);
    try {
      await expect(retranscribeCallRecording(filepath, original)).rejects.toBe(invalid);
      expect(create).toHaveBeenCalledTimes(1);
      const network = new APIConnectionError({ cause: new Error('synthetic disconnect') });
      create.mockClear().mockRejectedValue(network);
      await expect(retranscribeCallRecording(filepath, original)).rejects.toBe(network);
      expect(create).toHaveBeenCalledTimes(2);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('aligns consecutive manager ASR fragments with one recording utterance', () => {
    const fragmented = [original[0], original[1], { role: 'manager' as const, text: 'Не' },
      { role: 'manager' as const, text: 'распознано.' }, original[3]];
    expect(mergeCallRetranscription(fragmented, segments)).toEqual([
      original[0], original[1], { role: 'manager', text: 'Нет.' }, original[3],
    ]);
  });
  it('rejects an unrelated client answer even when speaker roles line up', () => {
    const wrong = segments.map((segment, index) => index === 3 ? { ...segment, text: 'Оставьте документы завтра вечером.' } : segment);
    expect(mergeCallRetranscription(original, wrong)).toBeNull();
  });
  it('corrects manager ASR but retains exact generated agent lines', () => {
    const corrected = mergeCallRetranscription(original, segments);
    expect(corrected).toEqual([
      original[0], original[1], { role: 'manager', text: 'Нет.' }, original[3],
    ]);
  });

  it('rejects a missing or reordered speaker turn', () => {
    expect(mergeCallRetranscription(original, segments.slice(0, 3))).toBeNull();
    expect(mergeCallRetranscription(original, segments.map((segment) => ({ ...segment, speaker: 'A' })))).toBeNull();
  });

  it('joins STT chunks from the same utterance before alignment', () => {
    const split = [
      segments[0],
      { speaker: 'B', start: 4, end: 5, text: 'Звоню по Шкоде Октавии.' },
      { speaker: 'B', start: 5.2, end: 6, text: 'Она еще в продаже?' },
      ...segments.slice(2),
    ];
    expect(mergeCallRetranscription(original, split)?.[2].text).toBe('Нет.');
  });
});
