import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertAuditAnalyticsCurrent, auditAnalyticsProgress, scheduleAuditReportBackfill, updateAuditAnalyticsStage, withAuditAnalyticsProgress } from '../logic/auditAnalyticsProgress';
import { withReportGenerationBudget } from '../voice/reportExecution';

let counter = 0;
const input = () => ({ key: `progress-test-${++counter}`, transcriptReady: false, evaluationReady: false, reportReady: false });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('real audit analytics progress', () => {
  it('fails a hung report at its deadline, releases its queue slot and allows an explicit retry', async () => {
    vi.useFakeTimers(); vi.spyOn(console, 'warn').mockImplementation(() => {});
    const data = input();
    expect(scheduleAuditReportBackfill(data.key, () => withReportGenerationBudget(() => new Promise<void>(() => {}), 25))).toBe(true);
    expect(auditAnalyticsProgress(data).status).toBe('processing');
    await vi.advanceTimersByTimeAsync(25);
    expect(auditAnalyticsProgress(data).status).toBe('failed');
    const retry = vi.fn(async () => { assertAuditAnalyticsCurrent(); });
    expect(scheduleAuditReportBackfill(data.key, retry)).toBe(false);
    expect(scheduleAuditReportBackfill(data.key, retry, { retry: true })).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(retry).toHaveBeenCalledOnce();
    expect(auditAnalyticsProgress({ ...data, reportReady: true }).status).toBe('ready');
  });
  it('1147: a retry after two minutes preserves an active report worker and its right to publish', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-03T12:00:00Z'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const data = input();
    let releaseOld!: () => void;
    const publishOld = vi.fn();
    const old = withAuditAnalyticsProgress(data.key, 'report', async () => {
      await new Promise<void>((resolve) => { releaseOld = resolve; });
      assertAuditAnalyticsCurrent();
      publishOld();
    });
    const retry = vi.fn(async () => {});
    expect(auditAnalyticsProgress(data).startedAt).toBe('2026-11-03T12:00:00.000Z');
    vi.setSystemTime(new Date('2026-11-03T12:01:59.999Z'));
    expect(scheduleAuditReportBackfill(data.key, retry, { retry: true })).toBe(false);
    vi.setSystemTime(new Date('2026-11-03T12:02:00Z'));
    expect(scheduleAuditReportBackfill(data.key, retry)).toBe(false);
    expect(scheduleAuditReportBackfill(data.key, retry, { retry: true })).toBe(false);
    expect(auditAnalyticsProgress(data).startedAt).toBe('2026-11-03T12:00:00.000Z');
    vi.setSystemTime(new Date('2026-11-03T12:04:00Z'));
    expect(scheduleAuditReportBackfill(data.key, retry, { retry: true })).toBe(false);
    expect(auditAnalyticsProgress(data).status).toBe('processing');
    releaseOld();
    await old;
    expect(publishOld).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
  });
  it('tracks actual stages without persisting an intermediate evaluation as a final report', async () => {
    const data = input();
    expect(auditAnalyticsProgress(data)).toMatchObject({ status: 'waiting', stage: 'transcription' });
    await withAuditAnalyticsProgress(data.key, 'transcription', async () => {
      expect(auditAnalyticsProgress({ ...data, transcriptReady: true })).toMatchObject({ status: 'processing', transcriptReady: false });
      updateAuditAnalyticsStage('evaluation');
      expect(auditAnalyticsProgress(data)).toMatchObject({ stage: 'evaluation', transcriptReady: true, evaluationReady: false });
      updateAuditAnalyticsStage('report');
      expect(auditAnalyticsProgress(data)).toMatchObject({ stage: 'report', transcriptReady: true, evaluationReady: true });
    });
    expect(auditAnalyticsProgress(data).status).toBe('waiting');
    expect(auditAnalyticsProgress({ ...data, reportReady: true })).toMatchObject({ status: 'ready', transcriptReady: true, evaluationReady: true });
  });

  it('does not confuse a failed analysis, an unanswered call and a zero score', () => {
    const data = input();
    expect(auditAnalyticsProgress({ ...data, failureReason: 'API failed' }).status).toBe('failed');
    expect(auditAnalyticsProgress({ ...data, failureReason: 'API failed' }).message).not.toContain('API failed');
    expect(auditAnalyticsProgress({ ...data, unavailable: true }).status).toBe('unavailable');
    expect(auditAnalyticsProgress({ ...data, evaluationReady: true, transcriptReady: true })).toMatchObject({ status: 'waiting', stage: 'report' });
    expect(auditAnalyticsProgress({ ...data, reportReady: true, failureReason: 'old error' }).status).toBe('ready');
  });

  it('does not start a paid repair while the original pipeline is still working', async () => {
    const data = input(), generate = vi.fn();
    await withAuditAnalyticsProgress(data.key, 'evaluation', async () => {
      expect(scheduleAuditReportBackfill(data.key, generate)).toBe(false);
      expect(auditAnalyticsProgress({ ...data, failureReason: 'old error' }).status).toBe('processing');
    });
    expect(generate).not.toHaveBeenCalled();
  });

  it('remembers the failing stage even if the worker has no intermediate database evaluation', async () => {
    const data = input();
    await expect(withAuditAnalyticsProgress(data.key, 'evaluation', async () => {
      updateAuditAnalyticsStage('report'); throw new Error('private provider details');
    })).rejects.toThrow('private provider details');
    expect(auditAnalyticsProgress(data)).toMatchObject({ status: 'failed', stage: 'report' });
    expect(auditAnalyticsProgress(data).message).not.toContain('private provider details');
    await withAuditAnalyticsProgress(data.key, 'evaluation', async () => {
      expect(auditAnalyticsProgress(data).status).toBe('processing');
    });
    expect(auditAnalyticsProgress(data).status).toBe('waiting');
  });

  it('deduplicates repeated reads and keeps a failed repair from becoming a paid polling loop', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const data = input();
    let fail!: (error: Error) => void;
    const generate = vi.fn(() => new Promise<void>((_, reject) => { fail = reject; }));
    expect(scheduleAuditReportBackfill(data.key, generate)).toBe(true);
    for (let i = 0; i < 20; i++) expect(scheduleAuditReportBackfill(data.key, generate)).toBe(false);
    expect(auditAnalyticsProgress(data)).toMatchObject({ status: 'processing', stage: 'report' });
    fail(new Error('provider unavailable'));
    await vi.waitFor(() => expect(auditAnalyticsProgress(data).status).toBe('failed'));
    expect(scheduleAuditReportBackfill(data.key, generate)).toBe(false);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('keeps async stages isolated between concurrent calls', async () => {
    const a = input(), b = input();
    await Promise.all([
      withAuditAnalyticsProgress(a.key, 'transcription', async () => {
        await Promise.resolve(); updateAuditAnalyticsStage('evaluation');
        expect(auditAnalyticsProgress(a).stage).toBe('evaluation');
      }),
      withAuditAnalyticsProgress(b.key, 'transcription', async () => {
        updateAuditAnalyticsStage('report'); await Promise.resolve();
        expect(auditAnalyticsProgress(b).stage).toBe('report');
      }),
    ]);
    updateAuditAnalyticsStage('report');
    expect(auditAnalyticsProgress(a).stage).toBe('transcription');
  });

  it('keeps the retry job active when it calls a nested original pipeline', async () => {
    const data = input();
    await expect(withAuditAnalyticsProgress(data.key, 'transcription', async () => {
      await withAuditAnalyticsProgress(data.key, 'evaluation', async () => {
        updateAuditAnalyticsStage('report');
      });
      expect(auditAnalyticsProgress(data)).toMatchObject({ status: 'processing', stage: 'report' });
      expect(scheduleAuditReportBackfill(data.key, async () => {}, { retry: true })).toBe(false);
      throw new Error('nested report failed');
    })).rejects.toThrow('nested report failed');
    expect(auditAnalyticsProgress(data)).toMatchObject({ status: 'failed', stage: 'report' });
  });

  it('does not let an older task clear or advance a newer task for the same call', async () => {
    const data = input();
    let releaseOld!: () => void, releaseNew!: () => void;
    const oldTask = withAuditAnalyticsProgress(data.key, 'transcription', async () => {
      await new Promise<void>((resolve) => { releaseOld = resolve; }); updateAuditAnalyticsStage('report');
    });
    const newTask = withAuditAnalyticsProgress(data.key, 'evaluation', () => new Promise<void>((resolve) => { releaseNew = resolve; }));
    releaseOld(); await oldTask;
    expect(auditAnalyticsProgress(data)).toMatchObject({ status: 'processing', stage: 'evaluation' });
    releaseNew(); await newTask;
  });
});
