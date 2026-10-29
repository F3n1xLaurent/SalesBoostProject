import { createHash, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Hypothesis2Snapshot } from './cometRealtimeTest';

export const PRODUCTION_REALTIME_ROOT = path.resolve('storage/voice-realtime');
export type ProductionRealtimeState = {
  version: 1;
  callId: string;
  webhookTokenHash: string;
  snapshot: Hypothesis2Snapshot;
};
type LiveState = { tokenHash: string; read: () => Hypothesis2Snapshot; pending: Promise<void>; lastSaved: string };
const live = new Map<string, LiveState>();
const validId = (id: string) => /^[a-z0-9-]{1,80}$/iu.test(id);
export const realtimeWebhookTokenHash = (token: string) => createHash('sha256').update(token).digest('hex');

export function registerProductionRealtimeState(callId: string, webhookToken: string, read: () => Hypothesis2Snapshot): void {
  if (!validId(callId)) throw new Error('Invalid production call id');
  live.set(callId, { tokenHash: realtimeWebhookTokenHash(webhookToken), read, pending: Promise.resolve(), lastSaved: '' });
}

export async function flushProductionRealtimeState(callId: string, root = PRODUCTION_REALTIME_ROOT): Promise<ProductionRealtimeState | null> {
  if (!validId(callId)) return null;
  const state = live.get(callId);
  if (!state) return readProductionRealtimeState(callId, root);
  // Capture now, not inside the pending write, so no later mutation changes
  // what this particular flush promises to make durable.
  const serialized = JSON.stringify({ version: 1, callId, webhookTokenHash: state.tokenHash, snapshot: state.read() });
  const write = state.pending.catch(() => undefined).then(async () => {
    if (state.lastSaved === serialized) return;
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const target = path.join(root, `${callId}.json`);
    await fs.writeFile(`${target}.tmp`, serialized, { mode: 0o600 });
    await fs.rename(`${target}.tmp`, target);
    state.lastSaved = serialized;
  });
  state.pending = write;
  await write;
  return JSON.parse(serialized) as ProductionRealtimeState;
}

export async function readProductionRealtimeState(callId: string, root = PRODUCTION_REALTIME_ROOT): Promise<ProductionRealtimeState | null> {
  if (!validId(callId)) return null;
  const state = live.get(callId);
  if (state) return { version: 1, callId, webhookTokenHash: state.tokenHash, snapshot: state.read() };
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(root, `${callId}.json`), 'utf8'));
    return parsed.version === 1 && parsed.callId === callId && parsed.snapshot?.callId === callId
      && typeof parsed.webhookTokenHash === 'string' ? parsed : null;
  } catch { return null; }
}

export function unregisterProductionRealtimeState(callId: string): void { live.delete(callId); }

export function authenticateProductionRealtimeWebhook(state: ProductionRealtimeState, token: unknown): boolean {
  if (typeof token !== 'string' || !token) return false;
  const expected = Buffer.from(state.webhookTokenHash, 'hex');
  const actual = Buffer.from(realtimeWebhookTokenHash(token), 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
