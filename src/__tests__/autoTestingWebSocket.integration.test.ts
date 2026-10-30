import { createServer } from 'node:http';
import WebSocket from 'ws';
import { expect, it } from 'vitest';
import type { RegressionRun } from '../voice/realtimeRegression';
import type { TrainerTestRun } from '../testing/trainerAutoTesting';
import { createAutoTestingUpgradeHandler, issueAutoTestingTicket, publishAutoTestingRun } from '../testing/autoTestingLive';

// Explicit opt-in because the default filesystem sandbox forbids loopback binds.
it.runIf(process.env.RUN_LOCAL_WS_INTEGRATION === '1').each(['call_plan', 'trainer'] as const)('streams %s snapshots over a real local WebSocket without any provider calls', async (target) => {
  const run = { id: 'socket-integration', ownerId: 'test-owner', planId: 'test-plan', planName: 'Тест',
    model: 'mock', target, status: 'running', createdAt: new Date().toISOString(), cases: [], checklist: [], progress: 'Подготовка' } as RegressionRun | TrainerTestRun;
  const upgrade = createAutoTestingUpgradeHandler(async (id, owner) => id === run.id && owner === run.ownerId ? run : null);
  const server = createServer();
  server.on('upgrade', (request, socket, head) => { if (!upgrade(request, socket, head)) socket.destroy(); });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  let client: WebSocket | undefined;
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No local port');
    const token = issueAutoTestingTicket(run.id, run.ownerId, target);
    const snapshots: Array<RegressionRun | TrainerTestRun> = [];
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WebSocket integration timeout')), 5000);
      client = new WebSocket(`ws://127.0.0.1:${address.port}/api/admin/auto-testing/${target === 'trainer' ? 'trainer' : 'call-plan'}/runs/${run.id}/live?ticket=${token}`);
      client.on('error', (error) => { clearTimeout(timer); reject(error); });
      client.on('message', (data) => {
        const event = JSON.parse(data.toString());
        snapshots.push(event.run);
        if (event.run.progress === 'Подготовка') publishAutoTestingRun({ ...run, progress: 'IVR пройден' });
        else if (event.run.progress === 'IVR пройден') publishAutoTestingRun({ ...run, status: 'completed', progress: 'Завершено' });
      });
      client.on('close', () => { clearTimeout(timer); resolve(); });
    });
    expect(snapshots.map((snapshot) => snapshot.progress)).toEqual(['Подготовка', 'IVR пройден', 'Завершено']);
    expect(snapshots.at(-1)?.status).toBe('completed');
  } finally {
    client?.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 10_000);
