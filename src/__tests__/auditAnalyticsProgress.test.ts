import { afterEach, describe, expect, it, vi } from 'vitest';
import { auditAnalyticsProgress, scheduleAuditReportBackfill, updateAuditAnalyticsStage, withAuditAnalyticsProgress } from '../logic/auditAnalyticsProgress';

let counter = 0;
const input = () => ({ key: `progress-test-${++counter}`, transcriptReady: false, evaluationReady: false, reportReady: false });
afterEach(() => vi.restoreAllMocks());

describe('real audit analytics progress', () => {
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
