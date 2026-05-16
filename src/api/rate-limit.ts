/**
 * Tiny in-memory sliding-window rate limiter.
 *
 * Why hand-rolled: keeps the dependency surface flat (no
 * `express-rate-limit` + its peers) and we don't need clustered state
 * — a single-process server with a small `Map<ip, timestamps[]>` is
 * sufficient for a dev-tool deployment. For production-grade
 * multi-instance rate-limiting, put a Redis-backed limiter in nginx
 * or your reverse proxy of choice in front of this.
 *
 * Two tiers shipped:
 *
 *   • a permissive global limiter for cheap GETs (parse summary,
 *     dialect list, file viewer) — meant to keep one shouty crawler
 *     from hot-looping our cache invalidation
 *   • a strict limiter for expensive POSTs (replay, diff, detection)
 *     — these touch O(messages × rules) work and can wedge the CPU
 *     for tens of seconds if shotgunned
 *
 * Limits are picked for an internet-facing hosted demo where we expect
 * "a curious developer reading the docs" traffic. Operators behind an
 * internal proxy can disable both by setting `LOGFLOW_RATE_LIMIT_OFF=1`.
 */

import type { Request, Response, NextFunction } from 'express';

const DISABLED = process.env.LOGFLOW_RATE_LIMIT_OFF === '1';

interface Bucket {
  /** Sliding window of recent hit timestamps, ms since epoch. */
  hits: number[];
}

/**
 * Sliding-window limiter: at most `max` requests per `windowMs` per
 * source IP. Returns 429 with a Retry-After header when exceeded.
 */
export function rateLimit(opts: { windowMs: number; max: number; label: string }) {
  const buckets = new Map<string, Bucket>();

  // Background sweep so the Map doesn't grow without bound — every
  // five minutes we drop buckets whose last hit is older than the
  // window. unref()'d so the timer doesn't keep the process alive
  // past graceful shutdown.
  const sweep = setInterval(() => {
    const cutoff = Date.now() - opts.windowMs;
    for (const [ip, b] of buckets) {
      if (b.hits.length === 0 || b.hits[b.hits.length - 1] < cutoff) {
        buckets.delete(ip);
      }
    }
  }, 5 * 60_000);
  sweep.unref?.();

  return function rateLimiter(req: Request, res: Response, next: NextFunction): void {
    if (DISABLED) {
      next();
      return;
    }
    // Express's `req.ip` honors `trust proxy` — set in server.ts.
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const cutoff = now - opts.windowMs;
    let bucket = buckets.get(ip);
    if (!bucket) {
      bucket = { hits: [] };
      buckets.set(ip, bucket);
    }
    // Drop hits older than the window.
    while (bucket.hits.length > 0 && bucket.hits[0] < cutoff) bucket.hits.shift();
    if (bucket.hits.length >= opts.max) {
      const oldest = bucket.hits[0];
      const retryAfter = Math.ceil((oldest + opts.windowMs - now) / 1000);
      res.set('Retry-After', String(Math.max(retryAfter, 1)));
      res.status(429).json({
        error: {
          code: 'RATE_LIMITED',
          message: `Too many ${opts.label} requests — try again in a moment.`,
          context: { limit: opts.max, windowMs: opts.windowMs }
        }
      });
      return;
    }
    bucket.hits.push(now);
    next();
  };
}

/** Defaults sized for an internet-facing hosted demo. */
export const cheapReadLimiter = rateLimit({
  windowMs: 60_000,
  max: 240,
  label: 'read'
});
export const expensivePostLimiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  label: 'compute'
});
