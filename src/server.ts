import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRouter } from './api/routes.js';
import { log } from './core/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// In dev (`npm run dev` / `tsx watch`), the built `dist/ui/` directory may
// not exist yet — the Vite dev server serves the UI on a separate port and
// proxies `/api` to us. In production (after `npm run build`), `dist/ui`
// sits next to `dist/server.js` and we serve it statically.
const repoRoot = path.resolve(__dirname, '..');

function resolveConfRoot(): string {
  const env = process.env.RSYSLOG_CONF_DIR;
  if (env) return path.resolve(env);
  return path.resolve(repoRoot, 'conf');
}

function resolveContentDir(): string {
  const env = process.env.CONTENT_DIR;
  if (env) return path.resolve(env);
  return path.resolve(repoRoot, 'content');
}

function resolveUiDir(): string | null {
  const candidates = [
    path.resolve(__dirname, 'ui'), // dist/ui after build
    path.resolve(repoRoot, 'dist/ui')
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'index.html'))) return c;
  }
  return null;
}

function readVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(repoRoot, 'package.json'), 'utf8'));
    return String(pkg.version ?? '0.0.0');
  } catch {
    return '0.0.0';
  }
}

const app = express();
const port = parseInt(process.env.PORT ?? '3000', 10);

// Don't advertise the framework — defense in depth against version-
// specific Express CVEs. (OWASP A05 — Security Misconfiguration.)
app.disable('x-powered-by');
// Trust the reverse proxy in front of us so req.ip reflects the real
// client. Operators put nginx/Caddy/Traefik between the world and this
// server; without `trust proxy` the rate-limiter buckets every request
// under the proxy's IP.
app.set('trust proxy', 1);

const confRoot = resolveConfRoot();
const contentDir = resolveContentDir();
const version = readVersion();
const serverLog = log.child({ component: 'server' });

// Per-request access log. Kept terse (one line per request) — full
// request/response bodies are not logged, and 4xx/5xx mapping happens
// inside the api router via the structured error handler.
app.use((req, res, next) => {
  const started = Date.now();
  res.on('finish', () => {
    serverLog.info('request', {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs: Date.now() - started
    });
  });
  next();
});

app.use('/api', createRouter({ confRoot, contentDir, version }));

const uiDir = resolveUiDir();
if (uiDir) {
  app.use(express.static(uiDir, { index: false }));
  app.get(/^(?!\/api).*/, (_req, res) => {
    res.sendFile(path.join(uiDir, 'index.html'));
  });
} else {
  app.get('/', (_req, res) => {
    res
      .type('text/plain')
      .send(
        'UI not built. Run `npm run build:ui` or `npm run dev` (and open http://localhost:5173).\nAPI is available under /api.\n'
      );
  });
}

app.listen(port, () => {
  serverLog.info('listening', {
    port,
    confRoot,
    contentDir,
    ui: uiDir ?? '(not built)',
    version
  });
});
