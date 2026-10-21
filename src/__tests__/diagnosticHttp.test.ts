import { afterEach, describe, expect, it, vi } from 'vitest';
import { gunzipSync } from 'node:zlib';
import type { Request, Response } from 'express';

const mocks = vi.hoisted(() => ({ loadDiagnosticCase: vi.fn() }));
vi.mock('../diagnostics/loadDiagnosticCase', () => ({ loadDiagnosticCase: mocks.loadDiagnosticCase }));

import { handleGetDiagnosticCase, isDiagnosticBearerAuthorized } from '../diagnostics/http';
import { validateDiagnosticCaseRequest } from '../diagnostics/request';

const token = 'a'.repeat(64);
const priorToken = process.env.DIAGNOSTIC_EXPORT_TOKEN;

afterEach(() => {
  if (priorToken === undefined) delete process.env.DIAGNOSTIC_EXPORT_TOKEN;
  else process.env.DIAGNOSTIC_EXPORT_TOKEN = priorToken;
  mocks.loadDiagnosticCase.mockReset();
});

function makeRequest(authorization?: string, query: Record<string, unknown> = {}) {
  const req = {
    params: { kind: 'trainer', id: 'training-1' },
    query,
    header: (name: string) => name === 'authorization' ? authorization : undefined,
  } as unknown as Request;
  const headers = new Map<string, unknown>();
  const state: { code: number; json?: unknown; bytes?: Buffer } = { code: 200 };
  const res = {
    setHeader: (name: string, value: unknown) => { headers.set(name.toLowerCase(), value); return res; },
    status: (code: number) => { state.code = code; return res; },
    json: (value: unknown) => { state.json = value; return res; },
    end: (value: Buffer) => { state.bytes = value; return res; },
  } as unknown as Response;
  return { req, res, headers, state };
}

describe('diagnostic HTTP access', () => {
  it('rejects IDs and audio options outside the narrow case API', () => {
    expect(() => validateDiagnosticCaseRequest({ kind: 'trainer', id: '../all', includeAudio: false })).toThrow();
    expect(() => validateDiagnosticCaseRequest({ kind: 'call', id: '1', includeAudio: true, turnNumber: 1 })).toThrow();
    expect(() => validateDiagnosticCaseRequest({ kind: 'trainer', id: 'cmv123', includeAudio: true, turnNumber: 2 })).not.toThrow();
  });

  it('requires a long independent bearer token', () => {
    expect(isDiagnosticBearerAuthorized(`Bearer ${token}`, token)).toBe(true);
    expect(isDiagnosticBearerAuthorized(`Bearer ${token}x`, token)).toBe(false);
    expect(isDiagnosticBearerAuthorized(`Bearer ${token}`, 'short')).toBe(false);
    expect(isDiagnosticBearerAuthorized(token, token)).toBe(false);
  });

  it('is disabled without a configured token and never reads data', async () => {
    delete process.env.DIAGNOSTIC_EXPORT_TOKEN;
    const { req, res, state } = makeRequest();
    await handleGetDiagnosticCase(req, res);
    expect(state.code).toBe(404);
    expect(mocks.loadDiagnosticCase).not.toHaveBeenCalled();
  });

  it('rejects an invalid token before parsing or reading data', async () => {
    process.env.DIAGNOSTIC_EXPORT_TOKEN = token;
    const { req, res, state, headers } = makeRequest('Bearer wrong', { audio: '1' });
    await handleGetDiagnosticCase(req, res);
    expect(state.code).toBe(401);
    expect(headers.get('cache-control')).toContain('no-store');
    expect(mocks.loadDiagnosticCase).not.toHaveBeenCalled();
  });

  it('returns a gzipped case for an authorized request with validated options', async () => {
    process.env.DIAGNOSTIC_EXPORT_TOKEN = token;
    const bundle = { format: 'salesboost-diagnostic-case', version: 1, kind: 'trainer', id: 'training-1' };
    mocks.loadDiagnosticCase.mockResolvedValue(bundle);
    const { req, res, state, headers } = makeRequest(`Bearer ${token}`, { audio: '1', turn: '2' });
    await handleGetDiagnosticCase(req, res);
    expect(state.code).toBe(200);
    expect(mocks.loadDiagnosticCase).toHaveBeenCalledWith({ kind: 'trainer', id: 'training-1', includeAudio: true, turnNumber: 2 });
    expect(headers.get('content-type')).toBe('application/gzip');
    expect(JSON.parse(gunzipSync(state.bytes!).toString('utf8'))).toEqual(bundle);
  });

  it('rejects unrecognized query parameters', async () => {
    process.env.DIAGNOSTIC_EXPORT_TOKEN = token;
    const { req, res, state } = makeRequest(`Bearer ${token}`, { surprise: '1' });
    await handleGetDiagnosticCase(req, res);
    expect(state.code).toBe(400);
    expect(mocks.loadDiagnosticCase).not.toHaveBeenCalled();
  });
});
