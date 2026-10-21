import { createHash, timingSafeEqual } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import type { Request, Response } from 'express';
import { loadDiagnosticCase } from './loadDiagnosticCase';
import type { DiagnosticCaseRequest } from './request';

const MAX_COMPRESSED_BYTES = 48 * 1024 * 1024;

export function isDiagnosticBearerAuthorized(authorization: string | undefined, configuredToken: string | undefined): boolean {
  if (!configuredToken || configuredToken.length < 32 || !authorization?.startsWith('Bearer ')) return false;
  const supplied = authorization.slice(7);
  if (!supplied || supplied.includes(' ')) return false;
  const expectedHash = createHash('sha256').update(configuredToken).digest();
  const suppliedHash = createHash('sha256').update(supplied).digest();
  return timingSafeEqual(expectedHash, suppliedHash);
}

function parseRequest(req: Request): DiagnosticCaseRequest {
  const kind = req.params.kind;
  const id = req.params.id;
  const allowedQueryKeys = new Set(['audio', 'turn']);
  if (Object.keys(req.query).some((key) => !allowedQueryKeys.has(key))) throw new Error('Unsupported query parameter');
  const audio = req.query.audio;
  if (audio !== undefined && audio !== '1') throw new Error('audio must be 1');
  const turn = req.query.turn;
  if (turn !== undefined && (typeof turn !== 'string' || !/^[1-9]\d{0,4}$/.test(turn))) {
    throw new Error('Invalid turn number');
  }
  return {
    kind: kind as DiagnosticCaseRequest['kind'],
    id,
    includeAudio: audio === '1',
    turnNumber: turn === undefined ? undefined : Number(turn),
  };
}

export async function handleGetDiagnosticCase(req: Request, res: Response): Promise<void> {
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const configuredToken = process.env.DIAGNOSTIC_EXPORT_TOKEN;
  if (!configuredToken || configuredToken.length < 32) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  if (!isDiagnosticBearerAuthorized(req.header('authorization'), configuredToken)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  let request: DiagnosticCaseRequest;
  try {
    request = parseRequest(req);
    const bundle = await loadDiagnosticCase(request);
    const bytes = gzipSync(Buffer.from(JSON.stringify(bundle)), { level: 6 });
    if (bytes.length > MAX_COMPRESSED_BYTES) {
      res.status(413).json({ error: 'Diagnostic package is too large; try without audio or use turn=N' });
      return;
    }
    res.status(200);
    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', `attachment; filename="diagnostic-${request.kind}-${request.id}.json.gz"`);
    res.setHeader('Content-Length', bytes.length);
    res.end(bytes);
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (message.startsWith('Training not found') || message.startsWith('Call not found')) {
      res.status(404).json({ error: 'Not found' });
    } else if (message.includes('exceeds 32 MiB')) {
      res.status(413).json({ error: 'Audio is too large; try without audio or request one training turn' });
    } else if (message.startsWith('Invalid') || message.startsWith('Unsupported') || message.startsWith('audio must') || message.startsWith('Turn number') || message.startsWith('Call database ID')) {
      res.status(400).json({ error: 'Invalid diagnostic request' });
    } else {
      console.error('[diagnostics] Case retrieval failed:', error);
      res.status(500).json({ error: 'Diagnostic retrieval failed' });
    }
  }
}
