/**
 * Start a voice dialog call via Voximplant StartScenarios API.
 * Used by the admin panel; all config from env (same as call-test server).
 * scenario: 'dialog' = our LLM (voice_dialog), 'realtime' = OpenAI Realtime (hybrid), 'realtime_pure' = OpenAI Realtime (prompt-only).
 * In dev, prefers live tunnel URL from getTunnelUrl() so dialog_url is always current.
 */

import { request } from 'undici';
import { randomUUID } from 'node:crypto';
import { getTunnelUrl } from '../tunnel';

const VOX_API_BASE = 'https://api.voximplant.com/platform_api';

function normalizePhone(v: string): string {
  const digits = String(v).replace(/\D/g, '');
  return digits ? '+' + digits : v;
}

function isPublicHttpUrl(value: string): boolean {
  const v = String(value || '').trim();
  if (!/^https?:\/\//i.test(v)) return false;
  try {
    const u = new URL(v);
    const host = u.hostname.toLowerCase();
    if (!host) return false;
    if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host === '::1') return false;
    return true;
  } catch {
    return false;
  }
}

export type VoiceCallScenario = 'dialog' | 'realtime' | 'realtime_pure';

export interface StartVoiceCallOptions {
  /** 'dialog' = our LLM (voice_dialog), 'realtime' = OpenAI Realtime. Default: 'dialog'. */
  scenario?: VoiceCallScenario;
}

export interface StartVoiceCallResult {
  callId: string;
  startedAt: string;
  scenario?: VoiceCallScenario;
  /** Vox call_session_history_id from StartScenarios (used by GetCallHistory). */
  callSessionHistoryId?: number | null;
}

export interface StartVoiceCallError {
  error: string;
}

export interface VoiceCallResolvedUrls {
  tunnelUrl: string;
  baseUrl: string;
  eventUrlBase: string;
  eventUrl: string;
}

export function resolveVoiceCallUrls(): VoiceCallResolvedUrls {
  const tunnelUrl = getTunnelUrl()?.replace(/\/$/, '') || '';
  const miniAppUrl = String(process.env.MINI_APP_URL || '').replace(/\/$/, '');
  const voiceDialogBaseUrl = String(process.env.VOICE_DIALOG_BASE_URL || '').replace(/\/$/, '');
  const publicBaseUrl = String(process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
  const miniAppPublicUrl = isPublicHttpUrl(miniAppUrl) ? miniAppUrl : '';

  // For webhook/event URL use only public URLs.
  // If env has only local MINI_APP_URL (localhost), fallback to live tunnel.
  const eventUrlBase =
    publicBaseUrl ||
    voiceDialogBaseUrl ||
    miniAppPublicUrl ||
    tunnelUrl ||
    '';

  // For dialog_url / stream_url:
  // prefer explicit VOICE_DIALOG_BASE_URL, then public MINI_APP_URL, then live tunnel.
  // As a last resort keep MINI_APP_URL (may be localhost) for local-only tests.
  const baseUrl = (voiceDialogBaseUrl || miniAppPublicUrl || tunnelUrl || miniAppUrl || '').replace(/\/$/, '');
  const eventUrl = eventUrlBase ? `${eventUrlBase}/webhooks/vox` : '';
  return { tunnelUrl, baseUrl, eventUrlBase, eventUrl };
}

export async function startVoiceCall(
  to: string,
  options: StartVoiceCallOptions = {}
): Promise<StartVoiceCallResult | StartVoiceCallError> {
  const { scenario = 'dialog' } = options;
  const accountId = process.env.VOX_ACCOUNT_ID;
  const apiKey = process.env.VOX_API_KEY;
  const appId = process.env.VOX_APP_ID;
  const { baseUrl, eventUrl } = resolveVoiceCallUrls();

  if (!accountId || !apiKey || !appId) {
    return { error: 'VOX_ACCOUNT_ID, VOX_API_KEY, VOX_APP_ID must be set in env.' };
  }
  const toNormalized = normalizePhone(to);
  if (!toNormalized || toNormalized.length < 10) {
    return { error: 'Invalid phone number.' };
  }

  const callId = randomUUID();

  let scriptName: string;
  let ruleName: string;
  let customData: Record<string, unknown>;

  if (scenario === 'realtime_pure') {
    scriptName = process.env.VOX_REALTIME_PURE_SCENARIO_NAME || 'voice_realtime_pure';
    ruleName = process.env.VOX_REALTIME_PURE_RULE_NAME || 'voice_realtime_pure_rule';
    const openaiApiKey = process.env.OPENAI_API_KEY || '';
    if (!openaiApiKey || openaiApiKey.length < 10) {
      return { error: 'OPENAI_API_KEY must be set in env for Realtime Pure scenario.' };
    }
    customData = {
      call_id: callId,
      to: toNormalized,
      event_url: eventUrl,
      caller_id: process.env.VOX_CALLER_ID ? normalizePhone(process.env.VOX_CALLER_ID) : undefined,
      openai_api_key: openaiApiKey,
    };
    // No dialog_url: full script is in the scenario prompt.
  } else if (scenario === 'realtime') {
    scriptName = process.env.VOX_REALTIME_SCENARIO_NAME || 'voice_realtime';
    ruleName = process.env.VOX_REALTIME_RULE_NAME || 'voice_realtime_rule';
    const openaiApiKey = process.env.OPENAI_API_KEY || '';
    if (!openaiApiKey || openaiApiKey.length < 10) {
      return { error: 'OPENAI_API_KEY must be set in env for Realtime scenario.' };
    }
    customData = {
      call_id: callId,
      to: toNormalized,
      event_url: eventUrl,
      caller_id: process.env.VOX_CALLER_ID ? normalizePhone(process.env.VOX_CALLER_ID) : undefined,
      openai_api_key: openaiApiKey,
    };
    // When baseUrl is set, pass dialog_url so Realtime uses our algorithm (virtual client) via function calling.
    if (baseUrl) {
      customData.dialog_url = `${baseUrl}/voice/dialog`;
    }
  } else {
    if (!baseUrl) {
      return { error: 'VOICE_DIALOG_BASE_URL or MINI_APP_URL must be set for dialog scenario.' };
    }
    const dialogUrl = `${baseUrl}/voice/dialog`;
    const useStream = process.env.VOICE_USE_STREAM === 'true' || process.env.VOICE_USE_STREAM === '1';
    const streamUrl = useStream
      ? baseUrl.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:') + '/voice/stream'
      : undefined;
    scriptName = process.env.VOX_DIALOG_SCENARIO_NAME || 'voice_dialog';
    ruleName = process.env.VOX_DIALOG_RULE_NAME || 'voice_dialog_rule';
    customData = {
      call_id: callId,
      to: toNormalized,
      event_url: eventUrl,
      caller_id: process.env.VOX_CALLER_ID ? normalizePhone(process.env.VOX_CALLER_ID) : undefined,
      tag: null,
      dialog_url: dialogUrl,
    };
    if (streamUrl) customData.stream_url = streamUrl;
  }

  const formParams: Record<string, string> = {
    account_id: accountId,
    api_key: apiKey,
    application_id: appId,
    script_name: scriptName,
    script_custom_data: JSON.stringify(customData),
    phone: toNormalized,
    output: 'json',
    rule_name: ruleName,
  };

  const form = new URLSearchParams(formParams);

  try {
    const { statusCode, body } = await request(`${VOX_API_BASE}/StartScenarios`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    const text = await body.text();
    if (statusCode >= 400) {
      console.warn('[vox] StartScenarios HTTP error', {
        statusCode,
        scriptName,
        ruleName,
        to: toNormalized,
        eventUrlPresent: Boolean(eventUrl),
        callerIdPresent: Boolean(customData?.caller_id),
        response: text.slice(0, 500),
      });
      return { error: `Vox API HTTP ${statusCode}: ${text.slice(0, 200)}` };
    }
    let callSessionHistoryId: number | null = null;
    try {
      const parsed = JSON.parse(text);
      const parsedHistoryId =
        typeof parsed?.call_session_history_id === 'number'
          ? parsed.call_session_history_id
          : typeof parsed?.call_session_history_id === 'string'
            ? Number.parseInt(parsed.call_session_history_id, 10)
            : null;
      if (parsedHistoryId && Number.isFinite(parsedHistoryId) && parsedHistoryId > 0) {
        callSessionHistoryId = parsedHistoryId;
      }
      const debugEnabled = process.env.VOX_DEBUG === '1' || process.env.VOX_DEBUG === 'true';
      if (debugEnabled) {
        console.log('[vox] StartScenarios OK', {
          scriptName,
          ruleName,
          to: toNormalized,
          eventUrlPresent: Boolean(eventUrl),
          callerIdPresent: Boolean(customData?.caller_id),
          result: parsed?.result,
          callSessionHistoryId: parsed?.call_session_history_id,
          raw: parsed,
        });
      }
      if (parsed?.error) {
        const msg = parsed.error.msg || JSON.stringify(parsed.error);
        console.warn('[vox] StartScenarios error payload', { scriptName, ruleName, to: toNormalized, msg });
        return { error: `Vox API: ${msg}` };
      }
      // Some Vox APIs return result=0 without "error" object.
      if (parsed?.result === 0) {
        const msg = parsed?.msg || parsed?.message || 'Unknown Vox API failure (result=0).';
        console.warn('[vox] StartScenarios failed result=0', { scriptName, ruleName, to: toNormalized, msg, raw: parsed });
        return { error: `Vox API: ${String(msg)}` };
      }
    } catch (_) {
      // ignore parse
    }
    const startedAt = new Date().toISOString();
    return { callId, startedAt, scenario, callSessionHistoryId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `StartScenarios failed: ${message}` };
  }
}
