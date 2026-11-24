import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditDetailItem } from '../../../shared/api/adminPanel';
import { mergeAuditRefresh, needsAnalyticsRefresh, pollAuditAnalytics } from './analyticsPolling';

const detail = (overrides: Partial<AuditDetailItem> = {}) => ({ id: 'call-1', type: 'call', unifiedReport: null, ...overrides } as AuditDetailItem);
const cleanups: Array<() => void> = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => { cleanups.splice(0).forEach((stop) => stop()); vi.useRealTimers(); });
describe('automatic analytics refresh', () => {
  it('keeps polling a pending recording after its report is ready', async () => {
    const report = { summary: 'Готово' } as AuditDetailItem['unifiedReport'];
    const pending = detail({ unifiedReport: report, recordingStatus: 'processing' });
    const ready = detail({ unifiedReport: report, recordingStatus: 'ready', recordingUrl: '/recording.mp3' });
    expect(needsAnalyticsRefresh(pending)).toBe(true);
    const load = vi.fn().mockResolvedValueOnce(pending).mockResolvedValueOnce(ready);
    const onDetail = vi.fn();
    cleanups.push(pollAuditAnalytics({ load, onDetail, onError: vi.fn() }));
    await vi.advanceTimersByTimeAsync(60000);
    expect(load).toHaveBeenCalledTimes(2);
    expect(onDetail).toHaveBeenLastCalledWith(ready);
    expect(mergeAuditRefresh(pending, ready)).toMatchObject({ recordingUrl: '/recording.mp3', unifiedReport: report });
  });

  it('does not stop on a ready status while the report itself is still missing', () => {
    expect(needsAnalyticsRefresh(detail({ analyticsProgress: { status: 'ready' } as AuditDetailItem['analyticsProgress'] }))).toBe(true);
  });

  it('does not replace the parent report with an incomplete polling snapshot', () => {
    const provided = detail({ unifiedReport: { summary: 'Готово' } as AuditDetailItem['unifiedReport'] });
    expect(mergeAuditRefresh(provided, detail({ recordingStatus: 'ready', recordingUrl: '/recording.mp3' })))
      .toMatchObject({ unifiedReport: provided.unifiedReport, recordingUrl: '/recording.mp3' });
    expect(mergeAuditRefresh(provided, detail({ id: 'another-call' }))).toBe(provided);
  });
  it('updates the report and stops after it is ready', async () => {
    const ready = detail({ unifiedReport: { summary: 'Готово' } as AuditDetailItem['unifiedReport'] });
    const load = vi.fn().mockResolvedValueOnce(detail()).mockResolvedValueOnce(ready), onDetail = vi.fn();
    cleanups.push(pollAuditAnalytics({ load, onDetail, onError: vi.fn() }));
    await vi.advanceTimersByTimeAsync(10000);
    expect(load).toHaveBeenCalledTimes(2); expect(onDetail).toHaveBeenLastCalledWith(ready);
    await vi.advanceTimersByTimeAsync(60000); expect(load).toHaveBeenCalledTimes(2);
  });
  it('never overlaps requests and ignores late results after dismissal', async () => {
    let resolve!: (value: AuditDetailItem) => void;
    const load = vi.fn((_signal: AbortSignal) => new Promise<AuditDetailItem>((done) => { resolve = done; }));
    const onDetail = vi.fn(), stop = pollAuditAnalytics({ load, onDetail, onError: vi.fn() }); cleanups.push(stop);
    await vi.advanceTimersByTimeAsync(60000); expect(load).toHaveBeenCalledTimes(1);
    stop(); expect(load.mock.calls[0][0].aborted).toBe(true);
    resolve(detail()); await vi.advanceTimersByTimeAsync(60000); expect(onDetail).not.toHaveBeenCalled();
  });
  it('retries transient failures without marking the analysis as failed', async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(detail({ unifiedReport: {} as NonNullable<AuditDetailItem['unifiedReport']> }));
    const onError = vi.fn(); cleanups.push(pollAuditAnalytics({ load, onDetail: vi.fn(), onError }));
    await vi.advanceTimersByTimeAsync(5000); expect(onError).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10000); expect(load).toHaveBeenCalledTimes(2);
  });
  it.each(['failed', 'unavailable'] as const)('stops on the terminal status %s', async (status) => {
    const terminal = detail({ analyticsProgress: { stage: 'report', status, transcriptReady: true, evaluationReady: true, message: 'Статус' } });
    expect(needsAnalyticsRefresh(terminal)).toBe(false);
    const load = vi.fn().mockResolvedValue(terminal); cleanups.push(pollAuditAnalytics({ load, onDetail: vi.fn(), onError: vi.fn() }));
    await vi.advanceTimersByTimeAsync(60000); expect(load).toHaveBeenCalledTimes(1);
  });
});
