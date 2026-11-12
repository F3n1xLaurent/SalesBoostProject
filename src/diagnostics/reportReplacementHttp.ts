import type { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { isDiagnosticBearerAuthorized } from './http';
import { bridge, type ReportReplacementRequest } from './reportReplacement';

const publication = z.object({ operationId: z.string().uuid(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/), report: z.record(z.unknown()) }).strict();
const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
type Action = 'fetch' | 'publish' | 'status' | 'rollback';

/** Same independent bearer token as diagnostic downloads; browser sessions
 * and administrator cookies never authorize these maintenance endpoints. */
export async function handleDiagnosticReportReplacement(action: Action, req: Request, res: Response): Promise<void> {
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const token = process.env.DIAGNOSTIC_EXPORT_TOKEN;
  if (!token || token.length < 32) { res.status(404).json({ error: 'Not found' }); return; }
  if (!isDiagnosticBearerAuthorized(req.header('authorization'), token)) { res.status(401).json({ error: 'Unauthorized' }); return; }
  let request: ReportReplacementRequest;
  try {
    if (Object.keys(req.query).length) throw new Error('INVALID_QUERY');
    if (action === 'fetch' || action === 'publish') {
      const kind = z.enum(['call', 'trainer']).parse(req.params.kind);
      const id = identifier.parse(req.params.id);
      if (action === 'fetch') request = { action, kind, id };
      else {
        const body = publication.parse(req.body);
        request = { action, operationId: body.operationId, report: body.report, snapshot: { kind, session: { id }, fingerprint: body.fingerprint } };
      }
    } else request = { action, operationId: z.string().uuid().parse(req.params.operationId) };
  } catch { res.status(400).json({ error: 'Invalid report replacement request' }); return; }
  try {
    const result = await bridge(prisma, request);
    // Raw SQLite integer columns can be bigint; do not leak a serialization
    // exception after an otherwise successful transaction.
    res.status(200).json(JSON.parse(JSON.stringify(result, (_key, value) => typeof value === 'bigint' ? String(value) : value)));
    if (action === 'publish' || action === 'rollback') console.info('[diagnostics/report-replacement]', { action, operationId: request.operationId, kind: request.snapshot?.kind, id: request.snapshot?.session.id });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const code = (error as NodeJS.ErrnoException)?.code;
    if (message === 'REPORT_OWNER_NOT_FOUND' || code === 'ENOENT') { res.status(404).json({ error: 'Report or operation not found' }); return; }
    if (/SOURCE_CHANGED|CHANGED_SINCE|ALREADY_RUNNING|WRITE_CONFLICT/u.test(message) || code === 'EEXIST') { res.status(409).json({ error: code === 'EEXIST' ? 'OPERATION_ALREADY_EXISTS' : message }); return; }
    if (/^(?:INVALID_|INCOMPLETE_|REPLACEMENT_|REPORT_(?:OWNER_NOT_FINISHED|EVALUATION_REQUIRED|SCORE_REQUIRED))/u.test(message)) { res.status(422).json({ error: message }); return; }
    console.error('[diagnostics/report-replacement] Failed', { action, operationId: request.operationId, code: code || 'INTERNAL_ERROR' });
    res.status(500).json({ error: 'Report replacement failed; check operation status before retrying' });
  }
}
