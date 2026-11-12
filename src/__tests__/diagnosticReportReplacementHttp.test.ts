import type { Request, Response } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ bridge: vi.fn() }));
vi.mock('../db', () => ({ prisma: {} }));
vi.mock('../diagnostics/reportReplacement', () => ({ bridge: mocks.bridge }));
import { handleDiagnosticReportReplacement } from '../diagnostics/reportReplacementHttp';
import { diagnosticReportRemote } from '../../scripts/production-report';

const token = 'a'.repeat(64), operationId = '7ca493d2-b192-40b6-b289-670858723e8f', fingerprint = 'b'.repeat(64);
const originalExport = process.env.DIAGNOSTIC_EXPORT_TOKEN, originalClient = process.env.PROD_DIAGNOSTIC_TOKEN;
afterEach(() => {
  for (const [key, value] of [['DIAGNOSTIC_EXPORT_TOKEN', originalExport], ['PROD_DIAGNOSTIC_TOKEN', originalClient]]) {
    if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
  }
  vi.restoreAllMocks(); vi.unstubAllGlobals(); mocks.bridge.mockReset();
});
async function invoke(action: 'fetch' | 'publish' | 'status' | 'rollback', options: { auth?: string; params?: Record<string, string>; body?: unknown; query?: Record<string, unknown> } = {}) {
  const state = { code: 200, body: undefined as any, headers: {} as Record<string, string> };
  const req = { params: options.params ?? { kind: 'call', id: '1147', operationId }, query: options.query ?? {}, body: options.body,
    header: (name: string) => name === 'authorization' ? options.auth : undefined } as unknown as Request;
  const res = { setHeader: (name: string, value: string) => { state.headers[name] = value; },
    status: (value: number) => { state.code = value; return res; }, json: (value: unknown) => { state.body = value; return res; } } as unknown as Response;
  await handleDiagnosticReportReplacement(action, req, res);
  return state;
}

describe('diagnostic token report maintenance API', () => {
  it('is disabled without the token and rejects browser sessions or incorrect tokens for every action', async () => {
    delete process.env.DIAGNOSTIC_EXPORT_TOKEN;
    expect((await invoke('fetch', { auth: `Bearer ${token}` })).code).toBe(404);
    process.env.DIAGNOSTIC_EXPORT_TOKEN = token;
    for (const action of ['fetch', 'publish', 'status', 'rollback'] as const) {
      for (const auth of [undefined, 'Bearer incorrect', token]) expect((await invoke(action, { auth })).code).toBe(401);
    }
    expect(mocks.bridge).not.toHaveBeenCalled();
  });

  it('accepts only a narrow report request and binds replacement to the URL identity', async () => {
    process.env.DIAGNOSTIC_EXPORT_TOKEN = token;
    mocks.bridge.mockResolvedValue({ ok: true });
    const body = { operationId, fingerprint, report: { summary: 'Prepared locally' } };
    const result = await invoke('publish', { auth: `Bearer ${token}`, body });
    expect(result.code).toBe(200);
    expect(result.headers['Cache-Control']).toContain('no-store');
    expect(mocks.bridge).toHaveBeenCalledWith({}, { action: 'publish', operationId, report: body.report, snapshot: { kind: 'call', session: { id: '1147' }, fingerprint } });
    mocks.bridge.mockClear();
    for (const options of [
      { body: { ...body, evaluationJson: '{}' } }, { body: { ...body, fingerprint: 'old' } },
      { body: { ...body, operationId: '../escape' } }, { body, query: { token } }, { body, params: { kind: 'all', id: '1147' } },
    ]) expect((await invoke('publish', { auth: `Bearer ${token}`, ...options })).code).toBe(400);
    expect(mocks.bridge).not.toHaveBeenCalled();
  });

  it('serializes SQLite bigint snapshots and maps conflicts and validation errors to useful HTTP statuses', async () => {
    process.env.DIAGNOSTIC_EXPORT_TOKEN = token;
    mocks.bridge.mockResolvedValueOnce({ session: { id: 1147n } });
    expect((await invoke('fetch', { auth: `Bearer ${token}` })).body.session.id).toBe('1147');
    for (const [message, status] of [['REPORT_SOURCE_CHANGED_FETCH_AGAIN', 409], ['CALL_ANALYSIS_ALREADY_RUNNING', 409],
      ['REPLACEMENT_EXAMPLES_NOT_APPROVED', 422], ['REPORT_OWNER_NOT_FOUND', 404], ['Unexpected internal detail', 500]] as const) {
      mocks.bridge.mockRejectedValueOnce(new Error(message));
      const result = await invoke('fetch', { auth: `Bearer ${token}` });
      expect(result.code).toBe(status);
      if (status === 500) expect(JSON.stringify(result.body)).not.toContain('Unexpected internal detail');
    }
  });

  it('uses the existing bearer token through HTTPS for download, replacement, status and rollback', async () => {
    process.env.PROD_DIAGNOSTIC_TOKEN = token;
    const fetch = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const destination = { baseUrl: 'https://app.example.test' };
    await diagnosticReportRemote(destination, { action: 'fetch', kind: 'call', id: '1147' });
    await diagnosticReportRemote(destination, { action: 'publish', operationId, snapshot: { kind: 'call', session: { id: '1147' }, fingerprint, privateOriginal: 'not uploaded' }, report: { summary: 'New report' } });
    await diagnosticReportRemote(destination, { action: 'status', operationId });
    await diagnosticReportRemote(destination, { action: 'rollback', operationId });
    expect(fetch.mock.calls.map(([url, options]) => [String(url), options.method])).toEqual([
      ['https://app.example.test/api/internal/diagnostics/reports/call/1147', 'GET'],
      ['https://app.example.test/api/internal/diagnostics/reports/call/1147', 'POST'],
      [`https://app.example.test/api/internal/diagnostics/report-operations/${operationId}`, 'GET'],
      [`https://app.example.test/api/internal/diagnostics/report-operations/${operationId}/rollback`, 'POST'],
    ]);
    for (const [url, options] of fetch.mock.calls) {
      expect(String(url)).not.toContain(token);
      expect(options).toMatchObject({ headers: { Authorization: `Bearer ${token}` }, redirect: 'error' });
      expect(options.body || '').not.toContain('privateOriginal');
      expect(options.body || '').not.toContain(token);
    }
  });

  it('refuses insecure or credential-bearing URLs and does not send unauthenticated requests', async () => {
    process.env.PROD_DIAGNOSTIC_TOKEN = token;
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    for (const baseUrl of ['http://app.example.test', 'https://user:secret@app.example.test', 'https://app.example.test?token=secret', 'https://app.example.test#secret']) {
      await expect(diagnosticReportRemote({ baseUrl }, { action: 'fetch', kind: 'call', id: '1147' })).rejects.toThrow('HTTPS origin');
    }
    delete process.env.PROD_DIAGNOSTIC_TOKEN;
    await expect(diagnosticReportRemote({ baseUrl: 'https://app.example.test' }, { action: 'fetch', kind: 'call', id: '1147' })).rejects.toThrow('PROD_DIAGNOSTIC_TOKEN');
    expect(fetch).not.toHaveBeenCalled();
  });
});
