import { request } from 'undici';
import { prisma } from '../db';
import { config } from '../config';
import {
  callRecordingKey,
  callRecordingStorage,
  callRecordingUrl,
} from '../storage/callRecordingStorage';
import { createVoxJwt } from './voxLogTranscript';
import { findRecording, type VoxCallHistoryResponse, type VoximplantRecord } from './voximplantRecording';

export { findRecording } from './voximplantRecording';

const VOX_API_BASE = 'https://api.voximplant.com/platform_api';
const RECORDING_RETRY_DELAYS_MS = [2_000, 5_000, 10_000, 20_000] as const;
const MAX_RECORDING_BYTES = 512 * 1024 * 1024;
const activeRecordingTasks = new Set<string>();
const activeRecordingSessions = new Set<string>();

export type RecordingStatus = 'pending' | 'processing' | 'ready' | 'failed';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

export async function getCallHistory(voxSessionId: string): Promise<VoxCallHistoryResponse> {
  if (!config.voxAccountId || !config.voxApiKey) {
    throw new Error('VOX_ACCOUNT_ID or VOX_API_KEY is not configured');
  }
  const form = new URLSearchParams({
    account_id: config.voxAccountId,
    api_key: config.voxApiKey,
    call_session_history_id: voxSessionId,
    with_records: 'true',
    with_calls: 'true',
    count: '1',
    output: 'json',
  });
  const response = await request(`${VOX_API_BASE}/GetCallHistory`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.body.text();
  if (response.statusCode >= 400) {
    throw new Error(`GetCallHistory HTTP ${response.statusCode}`);
  }
  let result: VoxCallHistoryResponse;
  try {
    result = JSON.parse(text) as VoxCallHistoryResponse;
  } catch {
    throw new Error('GetCallHistory returned invalid JSON');
  }
  if (result.error) {
    const message = typeof result.error === 'string' ? result.error : result.error.msg;
    throw new Error(`GetCallHistory error${message ? `: ${message}` : ''}`);
  }
  return result;
}

function isVoximplantHost(hostname: string): boolean {
  const value = hostname.toLowerCase();
  return value === 'voximplant.com' || value.endsWith('.voximplant.com')
    || value === 'voximplant.ru' || value.endsWith('.voximplant.ru');
}

export async function downloadRecording(record: VoximplantRecord): Promise<AsyncIterable<Uint8Array>> {
  let url = new URL(record.recordUrl);
  for (let redirectCount = 0; redirectCount <= 3; redirectCount += 1) {
    if (url.protocol !== 'https:') throw new Error('Voximplant record URL must use HTTPS');
    const headers: Record<string, string> = {};
    const jwt = createVoxJwt();
    if (jwt && isVoximplantHost(url.hostname)) {
      headers.Authorization = `Bearer ${jwt}`;
    } else if (isVoximplantHost(url.hostname) && config.voxAccountId && config.voxApiKey) {
      url.searchParams.set('account_id', config.voxAccountId);
      url.searchParams.set('api_key', config.voxApiKey);
      url.searchParams.set('record_id', record.recordId);
    }
    const response = await request(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(120_000),
    });
    if (response.statusCode >= 300 && response.statusCode < 400) {
      const location = response.headers.location;
      await response.body.dump().catch(() => undefined);
      if (!location || redirectCount === 3) throw new Error(`Recording download redirect HTTP ${response.statusCode}`);
      url = new URL(location, url);
      continue;
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      await response.body.dump().catch(() => undefined);
      throw new Error(`Recording download HTTP ${response.statusCode}`);
    }
    const contentType = String(response.headers['content-type'] || '').toLowerCase();
    if (contentType.includes('text/html') || contentType.includes('application/json')) {
      await response.body.dump().catch(() => undefined);
      throw new Error(`Unexpected recording content type: ${contentType}`);
    }
    return response.body;
  }
  throw new Error('Recording download exceeded redirect limit');
}

export async function saveRecording(callId: string, source: AsyncIterable<Uint8Array>) {
  return callRecordingStorage.save({
    key: callRecordingKey(callId),
    source,
    maxBytes: MAX_RECORDING_BYTES,
  });
}

async function fetchAndSaveRecording(callId: string, voxSessionId: string): Promise<void> {
  const existing = await prisma.voiceCallSession.findUnique({
    where: { callId },
    select: { recordingStatus: true },
  });
  if (!existing || existing.recordingStatus === 'ready') return;

  await prisma.voiceCallSession.update({
    where: { callId },
    data: { voxSessionId, recordingStatus: 'processing' },
  });

  let lastError: unknown = new Error('Voximplant record is not available yet');
  for (let index = 0; index < RECORDING_RETRY_DELAYS_MS.length; index += 1) {
    await sleep(RECORDING_RETRY_DELAYS_MS[index]);
    console.info(`Voximplant recording attempt=${index + 1} session_id=${voxSessionId}`);
    try {
      const history = await getCallHistory(voxSessionId);
      const record = findRecording(history);
      if (!record) {
        lastError = new Error('records[] is empty');
        continue;
      }
      console.info(`Voximplant record found record_id=${record.recordId}`);
      await prisma.voiceCallSession.update({
        where: { callId },
        data: { voxRecordId: record.recordId },
      });
      const source = await downloadRecording(record);
      const saved = await saveRecording(callId, source);
      console.info(`Voximplant recording downloaded size=${saved.size}`);
      await prisma.voiceCallSession.update({
        where: { callId },
        data: {
          voxSessionId,
          voxRecordId: record.recordId,
          recordingStatus: 'ready',
          recordingUrl: callRecordingUrl(callId),
        },
      });
      console.info(`Voximplant recording saved call_id=${callId}`);
      return;
    } catch (error) {
      lastError = error;
    }
  }

  const latest = await prisma.voiceCallSession.findUnique({ where: { callId }, select: { recordingStatus: true } });
  if (latest?.recordingStatus !== 'ready') {
    await prisma.voiceCallSession.update({ where: { callId }, data: { recordingStatus: 'failed' } });
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  console.error(`Voximplant recording failed call_id=${callId} error=${message}`);
}

export function scheduleRecordingFetch(callId: string, voxSessionId: string): void {
  if (activeRecordingTasks.has(callId) || activeRecordingSessions.has(voxSessionId)) return;
  activeRecordingTasks.add(callId);
  activeRecordingSessions.add(voxSessionId);
  console.info(`Voximplant recording scheduled call_id=${callId}`);
  void fetchAndSaveRecording(callId, voxSessionId)
    .catch(async (error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Voximplant recording failed call_id=${callId} error=${message}`);
      const session = await prisma.voiceCallSession.findUnique({ where: { callId }, select: { recordingStatus: true } }).catch(() => null);
      if (session && session.recordingStatus !== 'ready') {
        await prisma.voiceCallSession.update({ where: { callId }, data: { recordingStatus: 'failed' } }).catch(() => undefined);
      }
    })
    .finally(() => {
      activeRecordingTasks.delete(callId);
      activeRecordingSessions.delete(voxSessionId);
    });
}

export async function resumePendingRecordingFetches(): Promise<void> {
  const sessions = await prisma.voiceCallSession.findMany({
    where: {
      recordingStatus: { in: ['pending', 'processing'] },
      voxSessionId: { not: null },
    },
    select: { callId: true, voxSessionId: true },
  });
  for (const session of sessions) {
    if (session.voxSessionId) scheduleRecordingFetch(session.callId, session.voxSessionId);
  }
}

export function getCallRecordingFilePath(callId: string): string {
  return callRecordingStorage.resolvePath(callRecordingKey(callId));
}
