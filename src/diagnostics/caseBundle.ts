/** A read-only snapshot for investigating one production call or training locally. */
export type DiagnosticCaseKind = 'trainer' | 'call';

export type DiagnosticBundle = {
  format: 'salesboost-diagnostic-case';
  version: 1;
  kind: DiagnosticCaseKind;
  id: string;
  exportedAt: string;
  release: string | null;
  audioIncluded: boolean;
  session: Record<string, unknown>;
  context: unknown;
  transcript: unknown;
  evaluation: unknown;
  related: Record<string, unknown>;
  audio: unknown;
};

const SECRET_KEYS = ['apikey', 'password', 'secret', 'token', 'authorization', 'cookie', 'credential', 'privatekey'];
const IDENTITY_KEYS = new Set(['phone', 'phonenumber', 'destinationphone', 'email', 'ipaddress', 'to', 'from']);
const MAX_TRAINER_AUDIO_BYTES = 32 * 1024 * 1024;

function isSecretKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
  return SECRET_KEYS.some((secret) => normalized.includes(secret)) || IDENTITY_KEYS.has(normalized);
}

export function redactDiagnosticSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactDiagnosticSecrets);
  if (value instanceof Date) return value.toISOString();
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, nested]) => [
    key,
    isSecretKey(key) || key.toLowerCase() === 'audiobase64'
      ? '[redacted]'
      : redactDiagnosticSecrets(nested),
  ]));
}

export function parseDiagnosticJson(value: string | null): unknown {
  if (!value) return null;
  try {
    return redactDiagnosticSecrets(JSON.parse(value));
  } catch {
    return { parseError: 'Stored JSON could not be parsed' };
  }
}

type TrainerTurn = {
  role?: unknown;
  text?: unknown;
  createdAt?: unknown;
  durationSec?: unknown;
  audioBase64?: unknown;
  audioMimeType?: unknown;
};

type TrainerCaseInput = {
  id: string;
  session: Record<string, unknown>;
  caseContextJson: string;
  transcriptJson: string;
  evaluationJson: string | null;
  dimensionsJson: string | null;
  checklistResultsJson: string | null;
  objectionsAnalysisJson: string | null;
  topRecommendationsJson: string | null;
};

export function buildTrainerDiagnosticBundle(
  input: TrainerCaseInput,
  options: { includeAudio: boolean; turnNumber?: number; exportedAt?: string; release?: string | null },
): DiagnosticBundle {
  const rawTranscript = parseDiagnosticJson(input.transcriptJson);
  // Parse the audio-bearing source separately; the regular JSON parser redacts
  // embedded audio so that it cannot leak through an unrelated field.
  let audioTurns: TrainerTurn[] = [];
  try {
    const parsed = JSON.parse(input.transcriptJson) as unknown;
    if (Array.isArray(parsed)) audioTurns = parsed as TrainerTurn[];
  } catch { /* expose the parse error in transcript, not the raw payload */ }
  const transcript = Array.isArray(rawTranscript)
    ? rawTranscript.map((raw, index) => {
      const turn = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
      return {
        turnNumber: index + 1,
        role: turn.role ?? null,
        text: turn.text ?? null,
        createdAt: turn.createdAt ?? null,
        durationSec: turn.durationSec ?? null,
        audioAvailable: typeof audioTurns[index]?.audioBase64 === 'string' && Boolean(audioTurns[index]?.audioBase64),
        audioMimeType: turn.audioMimeType ?? null,
      };
    })
    : rawTranscript;

  let totalAudioBytes = 0;
  const audio = options.includeAudio ? audioTurns.flatMap((turn, index) => {
    if (turn.role !== 'manager' || (options.turnNumber && options.turnNumber !== index + 1)) return [];
    const base64 = typeof turn.audioBase64 === 'string' ? turn.audioBase64 : '';
    if (!base64) return [];
    const bytes = Buffer.byteLength(base64, 'base64');
    totalAudioBytes += bytes;
    if (totalAudioBytes > MAX_TRAINER_AUDIO_BYTES) {
      throw new Error('Trainer audio exceeds 32 MiB; export one turn with --turn N');
    }
    return [{ turnNumber: index + 1, mimeType: String(turn.audioMimeType || 'application/octet-stream'), bytes, base64 }];
  }) : [];

  return {
    format: 'salesboost-diagnostic-case',
    version: 1,
    kind: 'trainer',
    id: input.id,
    exportedAt: options.exportedAt ?? new Date().toISOString(),
    release: options.release ?? null,
    audioIncluded: audio.length > 0,
    session: redactDiagnosticSecrets(input.session) as Record<string, unknown>,
    context: parseDiagnosticJson(input.caseContextJson),
    transcript,
    evaluation: parseDiagnosticJson(input.evaluationJson),
    related: {
      dimensions: parseDiagnosticJson(input.dimensionsJson),
      checklistResults: parseDiagnosticJson(input.checklistResultsJson),
      objectionsAnalysis: parseDiagnosticJson(input.objectionsAnalysisJson),
      topRecommendations: parseDiagnosticJson(input.topRecommendationsJson),
    },
    audio: { managerTurns: audio },
  };
}

type CallCaseInput = {
  id: number;
  callId: string;
  session: Record<string, unknown>;
  caseContextJson: string | null;
  transcriptJson: string | null;
  originalTranscriptJson: string | null;
  retranscriptionJson: string | null;
  evaluationJson: string | null;
  dimensionsJson: string | null;
  checklistResultsJson: string | null;
  ivrPathJson: string | null;
  planCall: Record<string, unknown> | null;
};

export function buildCallDiagnosticBundle(
  input: CallCaseInput,
  options: { recording?: Buffer | null; recordingStatus?: string | null; exportedAt?: string; release?: string | null },
): DiagnosticBundle {
  const recording = options.recording ?? null;
  return {
    format: 'salesboost-diagnostic-case',
    version: 1,
    kind: 'call',
    id: input.callId,
    exportedAt: options.exportedAt ?? new Date().toISOString(),
    release: options.release ?? null,
    audioIncluded: Boolean(recording),
    session: redactDiagnosticSecrets({ ...input.session, dbId: input.id, callId: input.callId }) as Record<string, unknown>,
    context: parseDiagnosticJson(input.caseContextJson),
    transcript: parseDiagnosticJson(input.transcriptJson),
    evaluation: parseDiagnosticJson(input.evaluationJson),
    related: {
      originalTranscript: parseDiagnosticJson(input.originalTranscriptJson),
      retranscription: parseDiagnosticJson(input.retranscriptionJson),
      dimensions: parseDiagnosticJson(input.dimensionsJson),
      checklistResults: parseDiagnosticJson(input.checklistResultsJson),
      ivrPath: parseDiagnosticJson(input.ivrPathJson),
      planCall: redactDiagnosticSecrets(input.planCall),
    },
    audio: {
      recordingStatus: options.recordingStatus ?? null,
      recording: recording ? { mimeType: 'audio/mpeg', bytes: recording.length, base64: recording.toString('base64') } : null,
    },
  };
}
