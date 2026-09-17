const UNAVAILABLE_CALL_OUTCOMES = new Set(['no_answer', 'busy', 'failed', 'cancelled']);

export type VoxCallOutcomeEvidence = {
  connected?: boolean;
  transcriptTurns?: number;
  reason?: unknown;
  code?: unknown;
};

function outcomeFromDisconnectDetails(evidence: VoxCallOutcomeEvidence): 'busy' | 'no_answer' | null {
  const reason = String(evidence.reason ?? '').trim().toLowerCase();
  const code = Number(evidence.code);
  if (reason.includes('busy') || code === 486 || code === 600) return 'busy';
  if (
    reason.includes('no answer')
    || reason.includes('not answered')
    || reason.includes('unavailable')
    || reason.includes('not available')
    || reason.includes('timeout')
    || reason.includes('timed out')
    || code === 408
    || code === 480
  ) return 'no_answer';
  return null;
}

export function normalizeVoxWebhookEvent(rawEvent: unknown): string {
  const event = String(rawEvent ?? '').trim().toLowerCase();
  if (!event) return '';
  if (event === 'hangup' || event === 'disconnect' || event === 'completed' || event === 'ended') {
    return 'disconnected';
  }
  if (event === 'answer') return 'connected';
  if (event === 'ringing') return 'progress';
  return event;
}

export function resolveVoxCallOutcome(
  rawEvent: unknown,
  evidence: VoxCallOutcomeEvidence = {},
): string {
  const event = normalizeVoxWebhookEvent(rawEvent);
  if (event === 'no_answer' || event === 'busy' || event === 'failed' || event === 'cancelled') {
    return event;
  }

  if (event === 'disconnected') {
    const detailedOutcome = outcomeFromDisconnectDetails(evidence);
    if (detailedOutcome) return detailedOutcome;
    const wasAnswered = evidence.connected === true || Number(evidence.transcriptTurns ?? 0) > 0;
    return wasAnswered ? 'disconnected' : 'no_answer';
  }

  return event || 'failed';
}

export function isUnavailableCallOutcome(outcome: string | null | undefined): boolean {
  return UNAVAILABLE_CALL_OUTCOMES.has(String(outcome ?? '').trim().toLowerCase());
}

export function resolveCallPlanStatus(
  currentStatus: string | null | undefined,
  outcome: string | null | undefined,
  failureReason?: string | null,
): string {
  if (isUnavailableCallOutcome(outcome) || String(failureReason ?? '').trim()) return 'failed';
  return String(currentStatus ?? '').trim() || 'running';
}
