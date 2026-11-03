import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { createRetryAuditReportHandler, type AuditReportRetryJob } from '../audits/retryAuditReport';
import { auditAnalyticsProgress, scheduleAuditReportBackfill } from '../logic/auditAnalyticsProgress';

let sequence = 0;
const job = (overrides: Partial<AuditReportRetryJob> = {}): AuditReportRetryJob => ({
  key: `retry-test-${++sequence}`, stage: 'report', finished: true, unavailable: false, reportReady: false,
  run: vi.fn(async () => {}), ...overrides,
});
async function request(load: (req: Request, id: string) => Promise<AuditReportRetryJob | null>, id = 'call-895') {
  const req = { params: { id }, authAccount: { id: 'account' } } as unknown as Request;
  const result = { status: 200, body: null as any };
  const res = { status(code: number) { result.status = code; return this; }, json(body: unknown) { result.body = body; return this; } };
  await createRetryAuditReportHandler(load)(req, res as unknown as Response, () => {});
  return result;
}

describe('manual audit report recovery', () => {
  it('passes the authenticated request into the scoped lookup and hides inaccessible audits', async () => {
    const load = vi.fn(async () => null);
    expect((await request(load)).status).toBe(404);
    expect(load).toHaveBeenCalledWith(expect.objectContaining({ authAccount: { id: 'account' } }), 'call-895');
    expect((await request(load, 'call-895junk')).status).toBe(400);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('does not process live calls, missed calls or an already ready report', async () => {
    for (const overrides of [{ finished: false }, { unavailable: true }, { reportReady: true }]) {
      const data = job(overrides);
      expect((await request(async () => data)).status).toBe(409);
      expect(data.run).not.toHaveBeenCalled();
    }
  });

  it.each(['transcription', 'evaluation', 'report'] as const)('immediately returns real progress while retrying %s in the background', async (stage) => {
    let release!: () => void;
    const data = job({ stage, run: vi.fn(() => new Promise<void>((resolve) => { release = resolve; })) });
    const first = await request(async () => data, 'trainer-session');
    expect(first.status).toBe(202);
    expect(first.body).toMatchObject({ started: true, analyticsProgress: { stage, status: 'processing' } });
    const duplicate = await request(async () => data, 'trainer-session');
    expect(duplicate.status).toBe(202);
    expect(duplicate.body.started).toBe(false);
    expect(data.run).toHaveBeenCalledTimes(1);
    release();
  });

  it('allows an explicit retry after failure but never retries on status polling', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let release!: () => void;
    const run = vi.fn().mockRejectedValueOnce(new Error('private provider error'))
      .mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    const data = job({ run });
    const progress = () => auditAnalyticsProgress({ key: data.key, transcriptReady: true, evaluationReady: true, reportReady: false });
    await request(async () => data);
    await vi.waitFor(() => expect(progress().status).toBe('failed'));
    expect(progress().message).not.toContain('private');
    expect(scheduleAuditReportBackfill(data.key, run)).toBe(false);
    expect((await request(async () => data)).body.started).toBe(true);
    expect(progress().status).toBe('processing');
    expect(run).toHaveBeenCalledTimes(2);
    release();
    warn.mockRestore();
  });
});
