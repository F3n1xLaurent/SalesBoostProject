import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Hypothesis2Snapshot } from '../voice/cometRealtimeTest';
import { authenticateProductionRealtimeWebhook, flushProductionRealtimeState, readProductionRealtimeState,
  registerProductionRealtimeState, unregisterProductionRealtimeState } from '../voice/productionRealtimeState';

const roots: string[] = [];
const id = 'durable-call-123';
afterEach(async () => {
  unregisterProductionRealtimeState(id);
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function temporaryRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'salesboost-realtime-state-'));
  roots.push(root); return root;
}
describe('private production realtime state', () => {
  it('recovers the transcript after memory loss and stores only a token hash', async () => {
    const root = await temporaryRoot();
    const snapshot = { callId: id, transcript: [{ role: 'manager', text: 'Здравствуйте' }] } as Hypothesis2Snapshot;
    registerProductionRealtimeState(id, 'private-hook-token', () => snapshot);
    await flushProductionRealtimeState(id, root);
    unregisterProductionRealtimeState(id);
    const recovered = await readProductionRealtimeState(id, root);
    expect(recovered?.snapshot.transcript).toEqual(snapshot.transcript);
    expect(authenticateProductionRealtimeWebhook(recovered!, 'private-hook-token')).toBe(true);
    expect(authenticateProductionRealtimeWebhook(recovered!, 'wrong')).toBe(false);
    expect(authenticateProductionRealtimeWebhook(recovered!, undefined)).toBe(false);
    expect(await readFile(path.join(root, `${id}.json`), 'utf8')).not.toContain('private-hook-token');
    expect((await stat(path.join(root, `${id}.json`))).mode & 0o777).toBe(0o600);
  });
  it('serializes concurrent snapshots without losing the latest turn', async () => {
    const root = await temporaryRoot();
    let snapshot = { callId: id, transcript: [] } as unknown as Hypothesis2Snapshot;
    registerProductionRealtimeState(id, 'token', () => snapshot);
    const first = flushProductionRealtimeState(id, root);
    snapshot = { ...snapshot, transcript: [{ role: 'manager', text: 'Второй ответ', at: '2026-10-29', metrics: {} }] };
    const second = flushProductionRealtimeState(id, root);
    await Promise.all([first, second]);
    unregisterProductionRealtimeState(id);
    expect((await readProductionRealtimeState(id, root))?.snapshot.transcript).toHaveLength(1);
  });
  it('rejects path traversal and missing state', async () => {
    const root = await temporaryRoot();
    expect(() => registerProductionRealtimeState('../escape', 'token', () => ({} as Hypothesis2Snapshot))).toThrow();
    expect(await readProductionRealtimeState('../escape', root)).toBeNull();
    expect(await flushProductionRealtimeState('missing', root)).toBeNull();
  });
});
