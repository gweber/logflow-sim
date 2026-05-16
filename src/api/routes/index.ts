import express from 'express';
import { healthRouter } from './health.js';
import { dialectsRouter } from './dialects.js';
import { configRouter } from './config.js';
import { simulateRouter } from './simulate.js';
import { testsRouter } from './tests.js';
import { replayRouter } from './replay.js';
import { detectionRouter } from './detection.js';
import { contentRouter } from './content.js';
import { errorHandler } from '../error-handler.js';
import { cheapReadLimiter, expensivePostLimiter } from '../rate-limit.js';
import type { AppPaths } from '../context.js';

/**
 * Compose the per-feature routers into the `/api` mount point.
 *
 * The order here matters only for shared middleware:
 *   1. JSON body parser — once at the top so every POST handler can rely on req.body
 *   2. Per-feature routers — orthogonal, internal order is irrelevant
 *   3. Error handler — last, after every route, to centralize 4xx/5xx mapping
 */
export function createRouter(paths: AppPaths): express.Router {
  const r = express.Router();
  // 32 MB to accommodate `/replay/pcap` uploads (base64 inflates ~33%).
  r.use(express.json({ limit: '32mb' }));

  // Per-method rate limits — strict for compute-heavy POSTs (replay,
  // diff, detection-impact), permissive for cheap reads. Both can be
  // disabled by `LOGFLOW_RATE_LIMIT_OFF=1` for trusted on-host runs.
  // The reverse proxy in front (nginx/Caddy) is still the right place
  // for layer-7 DDoS protection — these are belt-and-suspenders.
  r.use((req, res, next) => {
    if (req.method === 'POST') return expensivePostLimiter(req, res, next);
    return cheapReadLimiter(req, res, next);
  });

  r.use(healthRouter(paths));
  r.use(dialectsRouter(paths));
  r.use(configRouter(paths));
  r.use(simulateRouter(paths));
  r.use(testsRouter(paths));
  r.use(replayRouter(paths));
  r.use(detectionRouter(paths));
  r.use(contentRouter(paths));

  r.use(errorHandler());
  return r;
}

export type { AppPaths } from '../context.js';
