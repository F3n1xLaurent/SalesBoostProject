import { createHash, randomUUID } from 'crypto';
import type { Request, RequestHandler } from 'express';
import {
  Bitrix24RequestError,
  Bitrix24WebhookClient,
  parseLandingLead,
  submitLandingLeadToBitrix24,
  type Bitrix24LandingLeadResult,
  type LandingLead,
} from './bitrix24LandingLead';

type RateLimitEntry = { startedAt: number; count: number };

class FixedWindowRateLimiter {
  private readonly entries = new Map<string, RateLimitEntry>();

  constructor(private readonly maxRequests: number, private readonly windowMs: number) {}

  consume(key: string, now = Date.now()): { allowed: boolean; retryAfterSeconds: number } {
    const existing = this.entries.get(key);
    if (!existing || now - existing.startedAt >= this.windowMs) {
      this.entries.set(key, { startedAt: now, count: 1 });
      this.prune(now);
      return { allowed: true, retryAfterSeconds: 0 };
    }
    existing.count += 1;
    const retryAfterSeconds = Math.max(1, Math.ceil((existing.startedAt + this.windowMs - now) / 1_000));
    return { allowed: existing.count <= this.maxRequests, retryAfterSeconds };
  }

  private prune(now: number): void {
    if (this.entries.size < 5_000) return;
    for (const [key, entry] of this.entries) {
      if (now - entry.startedAt >= this.windowMs) this.entries.delete(key);
    }
  }
}

function normalizeIp(value: string): string {
  return value.trim().replace(/^::ffff:/, '').slice(0, 64);
}

export function getPublicRequestIp(req: Request): string {
  // The production port is published only on host loopback and nginx overwrites
  // X-Real-IP, so this header remains correct even when Docker NAT is the socket peer.
  const realIp = normalizeIp(String(req.headers['x-real-ip'] ?? ''));
  if (realIp) return realIp;
  const remoteAddress = normalizeIp(req.socket.remoteAddress ?? '');
  return remoteAddress || 'unknown';
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function createOriginId(req: Request, lead: LandingLead, now: number): string {
  const suppliedKey = String(req.get('idempotency-key') ?? '').trim();
  if (/^[a-z0-9._:-]{8,128}$/i.test(suppliedKey)) {
    return `landing-${sha256(suppliedKey).slice(0, 48)}`;
  }
  const timeBucket = Math.floor(now / (5 * 60_000));
  return `landing-${sha256(JSON.stringify({ lead, ip: getPublicRequestIp(req), timeBucket })).slice(0, 48)}`;
}

type CachedSubmission = {
  expiresAt: number;
  promise: Promise<Bitrix24LandingLeadResult>;
};

export function createLandingLeadHandler(webhookUrl: string | undefined): RequestHandler {
  const rateLimiter = new FixedWindowRateLimiter(5, 10 * 60_000);
  const submissions = new Map<string, CachedSubmission>();
  let client: Bitrix24WebhookClient | null = null;
  let configurationError = false;
  if (webhookUrl) {
    try {
      client = new Bitrix24WebhookClient(webhookUrl);
    } catch {
      configurationError = true;
    }
  }

  return async (req, res) => {
    const requestId = randomUUID();
    res.setHeader('Cache-Control', 'no-store');

    if (!req.is('application/json')) {
      return res.status(415).json({ error: 'Ожидается application/json.', requestId });
    }
    const rateLimit = rateLimiter.consume(getPublicRequestIp(req));
    if (!rateLimit.allowed) {
      res.setHeader('Retry-After', String(rateLimit.retryAfterSeconds));
      return res.status(429).json({ error: 'Слишком много попыток. Попробуйте позже.', requestId });
    }

    const parsed = parseLandingLead(req.body);
    if (!parsed.ok) {
      return res.status(400).json({ error: 'Проверьте заполнение формы.', requestId });
    }
    // Deliberately return the same response to automated submissions without touching Bitrix24.
    if (parsed.honeypotTriggered) return res.status(201).json({ ok: true, requestId });
    if (!client || configurationError) {
      console.error(`[landing-lead] Bitrix24 is not configured request_id=${requestId}`);
      return res.status(503).json({ error: 'Сервис заявок временно недоступен.', requestId });
    }

    const now = Date.now();
    const originId = createOriginId(req, parsed.value, now);
    for (const [key, cached] of submissions) {
      if (cached.expiresAt <= now) submissions.delete(key);
    }
    let cached = submissions.get(originId);
    if (!cached) {
      const promise = submitLandingLeadToBitrix24(client, parsed.value, originId);
      cached = { expiresAt: now + 15 * 60_000, promise };
      submissions.set(originId, cached);
      promise.catch(() => {
        if (submissions.get(originId)?.promise === promise) submissions.delete(originId);
      });
    }

    try {
      await cached.promise;
      console.info(`[landing-lead] Bitrix24 lead saved request_id=${requestId}`);
      return res.status(201).json({ ok: true, requestId });
    } catch (error) {
      if (error instanceof Bitrix24RequestError) {
        console.error(
          `[landing-lead] Bitrix24 request failed request_id=${requestId} method=${error.method} status=${error.upstreamStatus ?? 'network'} code=${error.upstreamCode ?? 'unknown'}`,
        );
        return res.status(502).json({ error: 'Не удалось отправить заявку. Попробуйте ещё раз.', requestId });
      }
      console.error(`[landing-lead] Unexpected integration error request_id=${requestId}`);
      return res.status(500).json({ error: 'Не удалось отправить заявку. Попробуйте ещё раз.', requestId });
    }
  };
}
