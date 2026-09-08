/**
 * Fetch call session log from Voximplant and parse transcript from WebSocket messages.
 * Used when the scenario (e.g. realtime_pure) does not send transcript in the webhook:
 * we get it from the session log in the background without affecting call speed.
 * Supports secure logs via JWT from a Voximplant service account.
 */

import { request } from 'undici';
import { createSign } from 'crypto';
import type { TranscriptTurn } from './callHistory';
import { config } from '../config';

const VOX_API_BASE = 'https://api.voximplant.com/platform_api';

interface VoxServiceAccountCredentials {
  account_id: number | string;
  key_id: string;
  private_key: string;
}

export interface GetTranscriptFromVoxLogResult {
  transcript: TranscriptTurn[];
  source: 'vox_log';
  error?: 'missing_api_keys' | 'get_call_history_failed' | 'no_log_url' | 'log_unauthorized' | 'log_fetch_failed';
}

/**
 * Call Voximplant GetCallHistory for the given session id, fetch log_file_url, parse log for transcript.
 * Returns transcript array (manager/client) or empty array on any failure.
 */
export async function getTranscriptFromVoxLog(voxSessionId: number): Promise<GetTranscriptFromVoxLogResult> {
  const accountId = process.env.VOX_ACCOUNT_ID;
  const apiKey = process.env.VOX_API_KEY;

  if (!accountId || !apiKey) {
    console.warn('[voxLogTranscript] VOX_ACCOUNT_ID or VOX_API_KEY not set, skipping log fetch');
    return { transcript: [], source: 'vox_log', error: 'missing_api_keys' };
  }

  const form = new URLSearchParams({
    account_id: accountId,
    api_key: apiKey,
    call_session_history_id: String(voxSessionId),
    count: '1',
    with_calls: 'false',
    with_records: 'false',
    output: 'json',
  });

  let res: { statusCode: number; body: { text(): Promise<string> } };
  try {
    res = await request(`${VOX_API_BASE}/GetCallHistory`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
  } catch (err) {
    console.warn('[voxLogTranscript] GetCallHistory request failed:', err instanceof Error ? err.message : err);
    return { transcript: [], source: 'vox_log', error: 'get_call_history_failed' };
  }

  const text = await res.body.text();
  if (res.statusCode >= 400) {
    console.warn('[voxLogTranscript] GetCallHistory HTTP', res.statusCode, text.slice(0, 200));
    return { transcript: [], source: 'vox_log', error: 'get_call_history_failed' };
  }

  let json: { result?: Array<{ log_file_url?: string }>; error?: { msg?: string } };
  try {
    json = JSON.parse(text) as typeof json;
  } catch {
    console.warn('[voxLogTranscript] GetCallHistory response not JSON');
    return { transcript: [], source: 'vox_log', error: 'get_call_history_failed' };
  }

  if (json.error) {
    console.warn('[voxLogTranscript] GetCallHistory error:', json.error.msg ?? json.error);
    return { transcript: [], source: 'vox_log', error: 'get_call_history_failed' };
  }

  const logUrl = json.result?.[0]?.log_file_url;
  if (!logUrl || typeof logUrl !== 'string') {
    console.warn('[voxLogTranscript] No log_file_url in GetCallHistory result');
    return { transcript: [], source: 'vox_log', error: 'no_log_url' };
  }

  let logBody: string;
  try {
    const jwt = createVoxJwt();
    const headers: Record<string, string> = {};
    if (jwt) {
      headers['Authorization'] = `Bearer ${jwt}`;
    }
    const logRes = await request(logUrl, { method: 'GET', headers });
    logBody = await logRes.body.text();
    if (logRes.statusCode >= 400) {
      if (logRes.statusCode === 401 && !jwt) {
        console.warn(
          '[voxLogTranscript] Log fetch HTTP 401 (secure logs). Set VOX_SERVICE_ACCOUNT_CREDENTIALS to enable JWT.'
        );
        return { transcript: [], source: 'vox_log', error: 'log_unauthorized' };
      }
      console.warn('[voxLogTranscript] Log fetch HTTP', logRes.statusCode);
      return { transcript: [], source: 'vox_log', error: 'log_fetch_failed' };
    }
  } catch (err) {
    console.warn('[voxLogTranscript] Log fetch failed:', err instanceof Error ? err.message : err);
    return { transcript: [], source: 'vox_log', error: 'log_fetch_failed' };
  }

  const transcript = parseTranscriptFromLogText(logBody);
  console.log('[voxLogTranscript] Parsed from log', { voxSessionId, turns: transcript.length });
  return { transcript, source: 'vox_log' };
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

/**
 * Create JWT for Voximplant secure objects using service account credentials JSON from
 * VOX_SERVICE_ACCOUNT_CREDENTIALS env (same format as credentials.json from control panel).
 */
export function createVoxJwt(): string | null {
  const raw = config.voxServiceAccountCredentials;
  if (!raw) return null;
  try {
    const creds = JSON.parse(raw) as VoxServiceAccountCredentials;
    const accountId = Number((creds as any).account_id);
    const keyId = (creds as any).key_id;
    const privateKey = (creds as any).private_key;
    if (!accountId || !keyId || !privateKey) {
      throw new Error('Missing account_id/key_id/private_key');
    }
    const header = { typ: 'JWT', alg: 'RS256', kid: keyId };
    const now = Math.floor(Date.now() / 1000);
    const payload = { iss: accountId, iat: now, exp: now + 3600 };
    const encodedHeader = base64url(JSON.stringify(header));
    const encodedPayload = base64url(JSON.stringify(payload));
    const data = `${encodedHeader}.${encodedPayload}`;
    const signer = createSign('RSA-SHA256');
    signer.update(data);
    signer.end();
    const signature = signer.sign(privateKey);
    const encodedSig = base64url(signature);
    return `${data}.${encodedSig}`;
  } catch (err) {
    console.warn(
      '[voxLogTranscript] Failed to create JWT for secure log fetch:',
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

/**
 * Parse Voximplant session log text: find WebSocket.Message lines with
 * ConversationItemDone (assistant/user) and ResponseOutputAudioTranscriptDone (assistant),
 * build ordered transcript (manager = user, client = assistant).
 */
function parseTranscriptFromLogText(logText: string): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  const seen = new Set<string>();

  const lines = logText.split(/\r?\n/);
  for (const line of lines) {
    if (!line.includes('customEvent')) continue;

    // Vox logs format: ... text = {JSON} ; } ; ]
    // Extract JSON that follows "text =" to avoid picking up other braces on the line.
    const textIdx = line.indexOf('text =');
    if (textIdx === -1) continue;
    const jsonStart = line.indexOf('{', textIdx);
    if (jsonStart === -1) continue;
    const jsonEnd = line.indexOf('} ;', jsonStart);
    if (jsonEnd === -1) continue;

    let obj: any = null;
    try {
      const jsonStr = line.slice(jsonStart, jsonEnd + 1);
      obj = JSON.parse(jsonStr);
    } catch {
      continue;
    }

    if (!obj || !obj.customEvent) continue;

    const customEvent = obj.customEvent || '';

    // Assistant (bot) phrases from output transcript "done" events
    if (customEvent === 'ResponseOutputAudioTranscriptDone' && obj.payload?.transcript != null) {
      const text = String(obj.payload.transcript).trim();
      if (text) {
        const key = `client:${text.slice(0, 50)}`;
        if (!seen.has(key)) {
          seen.add(key);
          turns.push({ role: 'client', text });
        }
      }
      continue;
    }

    // Manager (user) phrases from input audio transcription completed events
    if (customEvent === 'ConversationItemInputAudioTranscriptionCompleted' && obj.payload?.transcript != null) {
      const text = String(obj.payload.transcript).trim();
      if (text) {
        const key = `manager:${text.slice(0, 50)}`;
        if (!seen.has(key)) {
          seen.add(key);
          turns.push({ role: 'manager', text });
        }
      }
      continue;
    }

    // Fallback: full items with role + content[].transcript
    if (customEvent === 'ConversationItemDone' && obj.payload?.item) {
      const item = obj.payload.item;
      const role = item.role === 'user' ? 'manager' : item.role === 'assistant' ? 'client' : null;
      if (!role) continue;
      const contents = Array.isArray(item.content) ? item.content : [];
      for (const c of contents) {
        if (c?.type === 'input_audio') continue;
        const transcript = (c as { transcript?: string })?.transcript;
        if (transcript != null && typeof transcript === 'string') {
          const text = transcript.trim();
          if (text) {
            const key = `${role}:${text.slice(0, 50)}`;
            if (!seen.has(key)) {
              seen.add(key);
              turns.push({ role: role as 'manager' | 'client', text });
            }
          }
        }
      }
    }
  }

  return turns;
}
