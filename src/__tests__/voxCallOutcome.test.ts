import { describe, expect, it } from 'vitest';
import {
  isUnavailableCallOutcome,
  normalizeVoxWebhookEvent,
  resolveCallPlanStatus,
  resolveVoxCallOutcome,
} from '../voice/voxCallOutcome';

describe('Vox call outcome normalization', () => {
  it('treats a disconnect without an answered call as no_answer', () => {
    expect(resolveVoxCallOutcome('disconnected')).toBe('no_answer');
    expect(resolveVoxCallOutcome('hangup', { connected: false, transcriptTurns: 0 })).toBe('no_answer');
  });

  it('keeps disconnected for a call that was actually answered', () => {
    expect(resolveVoxCallOutcome('disconnected', { connected: true })).toBe('disconnected');
    expect(resolveVoxCallOutcome('ended', { transcriptTurns: 2 })).toBe('disconnected');
  });

  it('uses disconnect reason and SIP code when the carrier reports an unavailable number', () => {
    expect(resolveVoxCallOutcome('disconnected', {
      connected: true,
      transcriptTurns: 2,
      reason: 'Temporarily unavailable',
    })).toBe('no_answer');
    expect(resolveVoxCallOutcome('disconnected', { connected: true, code: 480 })).toBe('no_answer');
    expect(resolveVoxCallOutcome('disconnected', { connected: true, code: 486 })).toBe('busy');
  });

  it('preserves explicit unavailable outcomes', () => {
    expect(resolveVoxCallOutcome('busy', { connected: true })).toBe('busy');
    expect(resolveVoxCallOutcome('failed')).toBe('failed');
    expect(resolveVoxCallOutcome('no_answer')).toBe('no_answer');
    expect(isUnavailableCallOutcome('no_answer')).toBe(true);
    expect(isUnavailableCallOutcome('disconnected')).toBe(false);
  });

  it('normalizes Vox aliases', () => {
    expect(normalizeVoxWebhookEvent('answer')).toBe('connected');
    expect(normalizeVoxWebhookEvent('completed')).toBe('disconnected');
  });

  it('marks unavailable plan calls as failed even if an old row says completed', () => {
    expect(resolveCallPlanStatus('completed', 'no_answer')).toBe('failed');
    expect(resolveCallPlanStatus('completed', 'busy')).toBe('failed');
  });

  it('does not keep a disconnected call completed when processing failed', () => {
    expect(resolveCallPlanStatus('completed', 'disconnected', 'Не найдена транскрипция')).toBe('failed');
  });

  it('keeps a successfully disconnected plan call completed', () => {
    expect(resolveCallPlanStatus('completed', 'disconnected')).toBe('completed');
  });
});
