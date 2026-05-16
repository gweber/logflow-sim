import express from 'express';
import type { AppPaths } from '../context.js';
import type { HealthDTO } from '../dto.js';

export function healthRouter(paths: AppPaths): express.Router {
  const r = express.Router();
  r.get('/health', (_req, res) => {
    const body: HealthDTO = { ok: true, version: paths.version };
    res.json(body);
  });
  return r;
}
