import { afterEach, describe, expect, it, vi } from 'vitest';
import { evaluateTransport } from '../voice/realtimeRegression';
import type { Hypothesis2Snapshot } from '../voice/cometRealtimeTest';
import { decodeMuLaw, pcmWave, SimulatedVoxSocket } from '../voice/realtimeRegressionAudio';
import { hasOnlyFarewellSteps, REGRESSION_CHECKLIST, regressionScenarios } from '../voice/realtimeRegressionScenarios';

const fixture = (transcript: any[] = [], flow: any[] = []): Hypothesis2Snapshot => ({
  transcript, conversationFlow: { events: flow }, errors: [], tools: [],
} as unknown as Hypothesis2Snapshot);
afterEach(() => vi.useRealTimers());

describe('hypothesis 2 regression evidence', () => {
  it('covers every checklist requirement with an explicit scenario', () => {
    const covered = new Set(regressionScenarios('Kia Carnival').flatMap((x) => x.checks));
    expect(REGRESSION_CHECKLIST.map(([id]) => id).filter((id) => !covered.has(id))).toEqual([]);
  });
  it('never passes an empty dialogue or auditory quality by absence of errors', () => {
    const results = evaluateTransport(regressionScenarios('Kia')[1], fixture(), []);
    expect(results.every((x) => x.status !== 'pass')).toBe(true);
    expect(results.find((x) => x.id === 'audio')?.status).toBe('review');
  });
  it('fails speaking during an IVR and passing only after live output resumes', () => {
    const scenario = regressionScenarios('Kia')[0];
    const events = [
      { atMs: 0, type: 'manager_started', detail: 'Вас приветствует автосалон.' },
      { atMs: 5000, type: 'manager_started', detail: 'Алло, отдел продаж.' },
      { atMs: 8000, type: 'playback_started' },
    ];
    expect(evaluateTransport(scenario, fixture(), events).find((x) => x.id === 'automation')?.status).toBe('pass');
    events.push({ atMs: 1000, type: 'playback_started' });
    expect(evaluateTransport(scenario, fixture(), events).find((x) => x.id === 'automation')?.status).toBe('fail');
  });
  it('detects repeated phrases and technical language', () => {
    const line = 'Сейчас завершу разговор и зафиксирую информацию.';
    const session = fixture([0, 1].map(() => ({ role: 'client', text: line, metrics: {} })));
    const result = evaluateTransport(regressionScenarios('Kia')[9], session, []);
    expect(result.find((x) => x.id === 'technical')?.status).toBe('fail');
    expect(result.find((x) => x.id === 'loops')?.status).toBe('fail');
  });
  it('allows a new introduction after transfer but still detects loops within one employee segment', () => {
    const text = 'Здравствуйте, я Андрей, звоню по автомобилю.';
    const session = fixture([{ role: 'client', text, metrics: {} },
      { role: 'manager', text: 'Сейчас переведу на другого сотрудника, оставайтесь на линии.', metrics: {} },
      { role: 'client', text, metrics: {} }]);
    const scenario = regressionScenarios('Киа').find((x) => x.id === 'hold')!;
    expect(evaluateTransport(scenario, session, []).find((x) => x.id === 'loops')?.status).toBe('pass');
    session.transcript.push({ role: 'client', text, at: '', metrics: {} });
    expect(evaluateTransport(scenario, session, []).find((x) => x.id === 'loops')?.status).toBe('fail');
  });

  it('fails narrated closing intentions even when a polite goodbye follows', () => {
    const scenario = regressionScenarios('Киа').find((s) => s.id === 'callback')!;
    const result = evaluateTransport(scenario, fixture([{ role: 'client', text: 'Зафиксирую договорённость и закроем разговор. Спасибо, до свидания.', metrics: {} }]), []);
    expect(result.find((c) => c.id === 'technical')?.status).toBe('fail');
    expect(result.find((c) => c.id === 'ending')?.status).toBe('fail');
  });

  it('detects repeated goodbyes both within and across AI responses', () => {
    const scenario = regressionScenarios('Киа').find((s) => s.id === 'callback')!;
    for (const turns of [
      [{ role: 'client', text: 'До свидания. Всего доброго.', metrics: {} }],
      [{ role: 'client', text: 'До свидания.', metrics: {} }, { role: 'manager', text: 'До свидания.', metrics: {} }, { role: 'client', text: 'Всего доброго.', metrics: {} }],
    ]) expect(evaluateTransport(scenario, fixture(turns), []).find((c) => c.id === 'ending')?.status).toBe('fail');
  });

  it('allows skipping only the manager goodbye after immediate terminal hangup', () => {
    expect(hasOnlyFarewellSteps([{ text: 'Да, договорились, до свидания.', wait: 'hangup' }])).toBe(true);
    expect(hasOnlyFarewellSteps([{ text: 'Какой у вас бюджет?', wait: 'response' }])).toBe(false);
    expect(hasOnlyFarewellSteps([{ text: 'До свидания, а какой пробег?', wait: 'hangup' }])).toBe(false);
  });

  it('flags a post-playback hangup delay rather than accepting a 5-second farewell wait', () => {
    const scenario = regressionScenarios('Киа').find((s) => s.id === 'callback')!;
    const session = fixture([{ role: 'client', text: 'Спасибо, до свидания.', metrics: {} }]);
    const events = [{ type: 'playback_ended', atMs: 5000 }, { type: 'hangup', atMs: 5000 }];
    expect(evaluateTransport(scenario, session, events).find((c) => c.id === 'ending' && c.status === 'fail')).toBeUndefined();
    events[1].atMs = 10000;
    expect(evaluateTransport(scenario, session, events).find((c) => c.id === 'ending')?.status).toBe('fail');
  });
});

describe('clocked Vox media emulator', () => {
  it('decodes G.711 and writes a playable PCM WAV header', () => {
    expect(decodeMuLaw(0xff)).toBe(0);
    expect(decodeMuLaw(0x80)).toBe(32124);
    expect(decodeMuLaw(0)).toBe(-32124);
    const wav = pcmWave(Buffer.alloc(320), 8000, 2);
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.readUInt16LE(22)).toBe(2);
    expect(wav.readUInt32LE(40)).toBe(320);
  });
  it('clears queued audio and never emits a stale playback end after interruption', async () => {
    vi.useFakeTimers();
    const vox = new SimulatedVoxSocket();
    vox.send(JSON.stringify({ customEvent: 'control', action: 'set_output_enabled', enabled: true }));
    vox.send(JSON.stringify({ event: 'start' }));
    vox.send(JSON.stringify({ event: 'media', media: { payload: Buffer.alloc(8000, 0xff).toString('base64') } }));
    vox.send(JSON.stringify({ event: 'stop' }));
    await vi.advanceTimersByTimeAsync(200);
    expect(vox.playing).toBe(true);
    vox.send(JSON.stringify({ customEvent: 'control', action: 'clear_media' }));
    expect(vox.playing).toBe(false);
    await vi.advanceTimersByTimeAsync(2000);
    expect(vox.events.some((x) => x.type === 'playback_ended')).toBe(false);
    expect(vox.clips[0].pcm.length).toBeLessThan(8000 * 2);
    expect(vox.recording().readUInt16LE(22)).toBe(2);
    vox.close();
  });
});
