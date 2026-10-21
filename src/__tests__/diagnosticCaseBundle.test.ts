import { describe, expect, it } from 'vitest';
import {
  buildCallDiagnosticBundle,
  buildTrainerDiagnosticBundle,
  parseDiagnosticJson,
} from '../diagnostics/caseBundle';

const trainerInput = {
  id: 'training-1',
  session: { id: 'training-1', status: 'completed', startedAt: new Date('2026-10-21T00:00:00.000Z'), apiKey: 'must-not-export' },
  caseContextJson: JSON.stringify({ scenario: { name: 'Сервис' }, runtime: { accessToken: 'secret' } }),
  transcriptJson: JSON.stringify([
    { role: 'client', text: 'Что вас интересует?', audioBase64: 'Y2xpZW50', audioMimeType: 'audio/ogg' },
    { role: 'manager', text: 'Что входит в проверку?', audioBase64: 'bWFuYWdlcg==', audioMimeType: 'audio/wav' },
    { role: 'manager', text: 'А сколько стоит?', audioBase64: 'c2Vjb25k', audioMimeType: 'audio/wav' },
  ]),
  evaluationJson: JSON.stringify({ checklist: [{ status: 'NO', comment: 'Нет ответа' }], password: 'hidden' }),
  dimensionsJson: '{}',
  checklistResultsJson: '[]',
  objectionsAnalysisJson: '[]',
  topRecommendationsJson: '[]',
};

describe('production diagnostic case bundle', () => {
  it('exports one training without embedded audio or secrets by default', () => {
    const bundle = buildTrainerDiagnosticBundle(trainerInput, {
      includeAudio: false,
      exportedAt: '2026-10-21T00:00:00.000Z',
    });
    expect(bundle.kind).toBe('trainer');
    expect(bundle.audioIncluded).toBe(false);
    expect(bundle.session.startedAt).toBe('2026-10-21T00:00:00.000Z');
    expect(bundle.transcript).toMatchObject([
      { turnNumber: 1, text: 'Что вас интересует?', audioAvailable: true },
      { turnNumber: 2, text: 'Что входит в проверку?', audioAvailable: true },
      { turnNumber: 3, text: 'А сколько стоит?', audioAvailable: true },
    ]);
    const output = JSON.stringify(bundle);
    expect(output).not.toContain('bWFuYWdlcg==');
    expect(output).not.toContain('must-not-export');
    expect(output).not.toContain('secret');
    expect(output).not.toContain('Y2xpZW50');
  });

  it('includes only the requested manager turn audio, never client audio', () => {
    const bundle = buildTrainerDiagnosticBundle(trainerInput, { includeAudio: true, turnNumber: 2 });
    expect(bundle.audioIncluded).toBe(true);
    expect(bundle.audio).toEqual({ managerTurns: [{
      turnNumber: 2,
      mimeType: 'audio/wav',
      bytes: 7,
      base64: 'bWFuYWdlcg==',
    }] });
    expect(JSON.stringify(bundle)).not.toContain('Y2xpZW50');
    expect(JSON.stringify(bundle)).not.toContain('c2Vjb25k');
  });

  it('exports call transcript, evaluation and local recording without phone or credentials', () => {
    const bundle = buildCallDiagnosticBundle({
      id: 199,
      callId: 'call-uuid',
      session: { outcome: 'completed', authorization: 'Bearer hidden' },
      caseContextJson: '{"scenario":"test"}',
      transcriptJson: '[{"role":"manager","text":"Здравствуйте"}]',
      originalTranscriptJson: null,
      retranscriptionJson: null,
      evaluationJson: '{"overall_score_0_100":75}',
      dimensionsJson: '{}',
      checklistResultsJson: '[]',
      ivrPathJson: null,
      planCall: { promptText: 'Вопрос о сервисе', phone: '+79999999999' },
    }, {
      recording: Buffer.from('audio'),
      recordingStatus: 'ready',
    });
    expect(bundle.id).toBe('call-uuid');
    expect(bundle.audioIncluded).toBe(true);
    expect(bundle.audio).toMatchObject({ recording: { bytes: 5, base64: 'YXVkaW8=' } });
    expect(JSON.stringify(bundle)).not.toContain('Bearer hidden');
    expect(JSON.stringify(bundle)).not.toContain('+79999999999');
  });

  it('marks malformed stored JSON instead of exposing the raw value', () => {
    expect(parseDiagnosticJson('{broken token=secret')).toEqual({ parseError: 'Stored JSON could not be parsed' });
  });
});
