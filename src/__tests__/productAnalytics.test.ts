import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  amplitudeTrack: vi.fn(),
}));

vi.mock('../db', () => ({
  prisma: {
    productAnalyticsEvent: { create: mocks.create },
  },
}));

vi.mock('../config', () => ({
  config: {
    amplitudeApiKey: undefined,
    amplitudeRegion: 'EU',
    sentryEnvironment: 'test',
  },
}));

vi.mock('@amplitude/analytics-node', () => ({
  init: vi.fn(),
  track: mocks.amplitudeTrack,
  flush: vi.fn(),
  Types: { ServerZone: { EU: 'EU', US: 'US' } },
}));

import { parseClientProductEvent, recordProductEvent } from '../analytics/productAnalytics';

describe('product analytics event boundary', () => {
  beforeEach(() => {
    mocks.create.mockReset();
    mocks.create.mockResolvedValue({ id: 'event-1' });
  });

  it('accepts only client events and strips unknown properties', () => {
    expect(parseClientProductEvent({ eventName: 'call_processing_failed' })).toBeNull();
    expect(parseClientProductEvent({
      eventName: 'report_viewed',
      route: '/audits/call-1?phone=secret',
      targetType: 'voice_call',
      targetId: 'call-1',
      properties: {
        report_type: 'call',
        phone: '+79990000000',
      },
    })).toEqual({
      eventName: 'report_viewed',
      route: '/audits/call-1',
      targetType: 'voice_call',
      targetId: 'call-1',
      clientSessionId: null,
      properties: { report_type: 'call' },
    });
  });

  it('does not accept free-form target fields that may contain PII', () => {
    expect(parseClientProductEvent({
      eventName: 'manager_viewed',
      targetType: 'manager',
      targetId: 'user@example.com',
    })).toMatchObject({ targetType: 'manager', targetId: null });
    expect(parseClientProductEvent({
      eventName: 'manager_viewed',
      targetType: 'unexpected_type',
      targetId: 'manager-1',
    })).toMatchObject({ targetType: null, targetId: null });
  });

  it('stores the curated event even when Amplitude is disabled', async () => {
    await expect(recordProductEvent({
      eventName: 'training_started',
      accountId: 'account-1',
      managerId: 'manager-1',
      properties: { session_type: 'free' },
    })).resolves.toBe(true);

    expect(mocks.create).toHaveBeenCalledOnce();
    expect(mocks.amplitudeTrack).not.toHaveBeenCalled();
  });
});
