import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  voiceFind: vi.fn(), voiceUpdate: vi.fn(), voiceUpsert: vi.fn(), planFind: vi.fn(), planUpdate: vi.fn(),
  scriptFind: vi.fn(), evaluate: vi.fn(), bundle: vi.fn(), criteria: vi.fn(), recording: vi.fn(), retranscribe: vi.fn(),
  durable: vi.fn(), finish: vi.fn(), attribution: vi.fn(),
}));
vi.mock('../db', () => ({ prisma: {
  voiceCallSession: { findUnique: mocks.voiceFind, update: mocks.voiceUpdate, upsert: mocks.voiceUpsert },
  callPlanCall: { findUnique: mocks.planFind, update: mocks.planUpdate },
  callPlan: { findUnique: async () => ({ scriptId: 'script' }) }, callScript: { findUnique: mocks.scriptFind },
} }));
vi.mock('../lib/openaiClient', () => ({ openai: { chat: { completions: { create: mocks.criteria } } }, compatibleChatTemperature: () => ({}) }));
vi.mock('../config', () => ({ config: { openaiChatModel: 'test' } }));
vi.mock('../voice/callHistory', () => ({ getRecordByCallId: () => null, markCallConnected: vi.fn() }));
vi.mock('../data/carLoader', () => ({ loadCar: () => ({}) }));
vi.mock('../state/defaultState', () => ({ getDefaultState: () => ({}) }));
vi.mock('../llm/evaluatorV2', () => ({ evaluateSessionV2: mocks.evaluate }));
vi.mock('../voice/voxLogTranscript', () => ({ getTranscriptFromVoxLog: vi.fn() }));
vi.mock('../voice/callAnalyticsBundle', () => ({ generateCallAnalyticsBundle: mocks.bundle }));
vi.mock('../voice/phoneNumberStats', () => ({ resolvePhoneNumberSourceSnapshot: async () => ({}) }));
vi.mock('../voice/voximplantRecordingService', () => ({ getCallRecordingFilePath: () => '/private/recording.mp3', scheduleRecordingFetch: mocks.recording }));
vi.mock('../voice/callRetranscription', () => ({ CALL_RETRANSCRIPTION_MODEL: 'test-asr', retranscribeCallRecording: mocks.retranscribe }));
vi.mock('../voice/callManagerAttribution', () => ({ attributeCallToIntroducedManager: mocks.attribution }));
vi.mock('@sentry/node', () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));
vi.mock('../analytics/productAnalytics', () => ({ recordProductEvent: vi.fn() }));
vi.mock('../voice/productionRealtimeState', () => ({ flushProductionRealtimeState: mocks.durable }));
vi.mock('../voice/callPlanTelephony', () => ({ finishProductionCallPlanTelephony: mocks.finish }));
import { finalizeVoiceCallSession } from '../voice/voiceCallSession';

const transcript = [
  { role: 'manager', text: 'Здравствуйте, менеджер Анна, слушаю вас.' },
  { role: 'client', text: 'Здравствуйте. Какая цена автомобиля?' },
  { role: 'manager', text: 'Цена два миллиона двести пятьдесят тысяч рублей.' },
  { role: 'client', text: 'Спасибо за информацию, до свидания.' },
];
const reviewed = transcript.map(turn => turn.role === 'manager' && turn.text.startsWith('Цена')
  ? { ...turn, text: 'Цена 2 250 000 рублей.' } : turn);
let session: Record<string, any>;
let planCall: Record<string, any>;
function patch(target: Record<string, any>, data: Record<string, any>) {
  for (const [key, value] of Object.entries(data)) if (value !== undefined) target[key] = value;
  return { ...target };
}
beforeEach(() => {
  vi.clearAllMocks();
  session = { callId: 'call-production', to: '+79507503215', scenario: 'openai_realtime', source: 'scheduled',
    startedAt: new Date('2026-10-29T10:00:00Z'), connectedAt: new Date('2026-10-29T10:00:05Z'),
    endedAt: null, voxSessionId: '789', recordingStatus: 'pending', transcriptJson: '[]', originalTranscriptJson: null,
    caseContextJson: JSON.stringify({ telephony: { provider: 'openai_realtime', voiceId: 'profile-voice' } }), planId: 'plan',
  };
  planCall = { id: 'plan-call', planId: 'plan', employeeId: null, dealershipId: 'dealership', targetKind: 'dealership',
    profileId: 'profile', scriptId: 'script', importedItemId: 'car', phone: session.to,
    criteriaJson: JSON.stringify([{ sourceType: 'question', sourceId: 'price', expectedAnswer: '2250000 рублей', score: 100 }]),
  };
  mocks.voiceFind.mockImplementation(async () => ({ ...session }));
  mocks.voiceUpdate.mockImplementation(async ({ data }) => patch(session, data));
  mocks.voiceUpsert.mockImplementation(async ({ update }) => patch(session, update));
  mocks.planFind.mockImplementation(async () => ({ ...planCall }));
  mocks.planUpdate.mockImplementation(async ({ data }) => patch(planCall, data));
  mocks.scriptFind.mockResolvedValue({ name: 'Цена', context: 'Продажа машины', questionsJson: JSON.stringify([{ id: 'price', text: 'Какая цена?' }]),
    objectionsJson: '[]', successCriteriaJson: '[]', dataConditionJson: '{}', checklist: { id: 'checklist', name: 'Продажи', itemsJson: '[]', isArchived: false } });
  mocks.durable.mockResolvedValue({ snapshot: { transcript, model: 'test-realtime', voice: { voiceId: 'profile-voice' }, metrics: { speechToFirstAudioMs: 900 },
    tools: [{ name: 'end_call' }], errors: [], ivrDetected: false, ivrPath: [], usage: [{ responseId: 'r1', usage: { total_tokens: 200 } }] } });
  mocks.recording.mockImplementation(async () => { session.recordingStatus = 'ready'; });
  mocks.attribution.mockResolvedValue(undefined);
  mocks.retranscribe.mockResolvedValue(reviewed);
  mocks.evaluate.mockResolvedValue({ evaluation: { overall_score_0_100: 88, checklist: [{ id: 'greeting', status: 'YES' }], dimension_scores: { greeting: 90 } } });
  mocks.bundle.mockResolvedValue({ callSummary: { text: 'Обсудили стоимость' }, replyImprovements: [], unifiedCallReport: { verdict: 'success' } });
  mocks.criteria.mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ items: [{ expectedAnswer: '2250000 рублей', maxScore: 100, score: 100, status: 'YES' }], totalScore: 100, maxScore: 100, percent: 100 }) } }] });
});
const finalEvent = { call_id: 'call-production', event: 'disconnected', ts: '2026-10-29T10:02:00Z' };
describe('production hypothesis 2 through the existing recording and report pipeline', () => {
  it('saves recording, reviews ASR, evaluates checklist and scenario, and mirrors the report into the plan', async () => {
    await finalizeVoiceCallSession(finalEvent);
    expect(mocks.recording).toHaveBeenCalledWith('call-production', '789');
    expect(mocks.retranscribe).toHaveBeenCalledWith('/private/recording.mp3', transcript);
    expect(JSON.parse(session.originalTranscriptJson)).toEqual(transcript);
    expect(JSON.parse(session.transcriptJson)).toEqual(reviewed);
    expect(session.recordingStatus).toBe('ready');
    expect(mocks.evaluate).toHaveBeenCalledWith(expect.objectContaining({ evaluationChecklist: expect.objectContaining({ id: 'checklist' }),
      dialogHistory: reviewed.map(turn => ({ role: turn.role, content: turn.text })) }));
    const report = JSON.parse(session.evaluationJson);
    expect(report).toMatchObject({ overall_score_0_100: 88, unified_call_report: { verdict: 'success' }, plan_criteria: { percent: 100 } });
    expect(planCall.evaluationJson).toBe(session.evaluationJson);
    expect(planCall.transcriptJson).toBe(session.transcriptJson);
    expect(planCall.totalScore).toBe(88); expect(planCall.status).toBe('completed');
    expect(session.planId).toBe('plan'); expect(session.dealershipId).toBe('dealership');
    const context = JSON.parse(session.caseContextJson);
    expect(context.telephony.voiceId).toBe('profile-voice');
    expect(context.realtime.usage[0].usage.total_tokens).toBe(200);
    expect(mocks.attribution).toHaveBeenCalled();
  });
  it('coalesces concurrent final events and does not evaluate an already finished report again', async () => {
    await Promise.all([finalizeVoiceCallSession(finalEvent), finalizeVoiceCallSession(finalEvent)]);
    await finalizeVoiceCallSession(finalEvent);
    expect(mocks.evaluate).toHaveBeenCalledTimes(1);
    expect(mocks.recording).toHaveBeenCalledTimes(1);
    expect(mocks.bundle).toHaveBeenCalledTimes(1);
  });
  it('repairs a missing plan report after successful evaluation without evaluating again', async () => {
    await finalizeVoiceCallSession(finalEvent);
    planCall.evaluationJson = null; planCall.transcriptJson = null;
    await finalizeVoiceCallSession(finalEvent);
    expect(planCall.evaluationJson).toBe(session.evaluationJson);
    expect(planCall.transcriptJson).toBe(session.transcriptJson);
    expect(mocks.evaluate).toHaveBeenCalledTimes(1);
  });
  it('does not evaluate an unanswered call', async () => {
    session.connectedAt = null; session.recordingStatus = null;
    mocks.durable.mockResolvedValue({ snapshot: { transcript: [], tools: [], errors: [], ivrDetected: false, ivrPath: [] } });
    await finalizeVoiceCallSession({ ...finalEvent, event: 'no_answer' });
    expect(mocks.evaluate).not.toHaveBeenCalled(); expect(mocks.retranscribe).not.toHaveBeenCalled();
    expect(planCall.outcome).toBe('no_answer'); expect(planCall.evaluationJson).toBeNull();
  });
  it('retains the old Agent payload path without loading production realtime state', async () => {
    session.scenario = 'realtime_pure'; session.recordingStatus = null;
    await finalizeVoiceCallSession({ ...finalEvent, transcript });
    expect(mocks.durable).not.toHaveBeenCalled(); expect(mocks.finish).not.toHaveBeenCalled();
    expect(mocks.evaluate).toHaveBeenCalledTimes(1);
    expect(planCall.totalScore).toBe(88);
  });
  it('uses the stored transcript when the live process state is gone', async () => {
    session.transcriptJson = JSON.stringify(transcript); session.recordingStatus = null;
    mocks.durable.mockResolvedValue(null);
    await finalizeVoiceCallSession(finalEvent);
    expect(mocks.evaluate).toHaveBeenCalledTimes(1);
    expect(JSON.parse(planCall.transcriptJson)).toEqual(transcript);
  });
});
