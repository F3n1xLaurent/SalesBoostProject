/**
 * In-memory call history for admin: started calls + transcript per call.
 * Persists only for process lifetime.
 */

export interface TranscriptTurn {
  role: 'manager' | 'client';
  text: string;
}

export interface VoiceCallRecord {
  callId: string;
  to: string;
  startedAt: string; // ISO
  transcript: TranscriptTurn[];
  /** Voximplant call session history id (used to fetch logs/transcripts). */
  voxSessionId?: number | null;
}

const MAX_HISTORY = 100;
const calls: VoiceCallRecord[] = [];
const byCallId = new Map<string, VoiceCallRecord>();

function normalizePhone(v: string): string {
  const digits = String(v).replace(/\D/g, '');
  return digits ? '+' + digits : v;
}

export function addCall(callId: string, to: string): void {
  const record: VoiceCallRecord = {
    callId,
    to: normalizePhone(to),
    startedAt: new Date().toISOString(),
    transcript: [],
    voxSessionId: null,
  };
  byCallId.set(callId, record);
  calls.unshift(record);
  if (calls.length > MAX_HISTORY) {
    const removed = calls.pop();
    if (removed) byCallId.delete(removed.callId);
  }
}

export function setVoxSessionId(callId: string, voxSessionId: number): void {
  const record = byCallId.get(callId);
  if (!record) return;
  if (!Number.isFinite(voxSessionId) || voxSessionId <= 0) return;
  // Keep the first known ID (preferably from StartScenarios.call_session_history_id).
  if (record.voxSessionId && record.voxSessionId > 0) return;
  record.voxSessionId = voxSessionId;
}

export function appendTranscript(callId: string, role: 'manager' | 'client', text: string): void {
  if (!text || !text.trim()) return;
  const record = byCallId.get(callId);
  if (!record) return;
  record.transcript.push({ role, text: text.trim() });
}

export function getCallHistory(limit: number = 50): VoiceCallRecord[] {
  return calls.slice(0, Math.min(limit, calls.length));
}

/** Get one call by callId (for webhook to finalize and persist). */
export function getRecordByCallId(callId: string): VoiceCallRecord | undefined {
  return byCallId.get(callId);
}

export function getTestNumbers(): string[] {
  const to = process.env.VOX_TEST_TO?.trim();
  const list = process.env.VOX_TEST_NUMBERS || '';
  const fromList = list
    .split(',')
    .map((s) => s.trim().replace(/\D/g, ''))
    .filter((s) => s.length > 0)
    .map((s) => '+' + s);
  const combined = to ? [normalizePhone(to), ...fromList] : fromList;
  return [...new Set(combined)];
}

export function getDefaultTo(): string | null {
  const nums = getTestNumbers();
  return nums.length > 0 ? nums[0] : null;
}
