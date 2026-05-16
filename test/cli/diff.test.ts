import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

/**
 * End-to-end CLI smoke tests for `replay` and `diff`. Builds the CLI from
 * source once (via the already-compiled dist/) and executes it as a real
 * subprocess so we exercise the same code GH Action users will run.
 *
 * These tests require `npm run build:server` to have been run beforehand —
 * the suite skips itself with a clear message if dist/cli/main.js is absent.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const CLI = path.join(ROOT, 'dist/cli/main.js');
const CONF = path.join(ROOT, 'conf-demo');

const SAMPLE_LINES =
  'Jun  9 06:06:20 host1 sshd: opened\n' +
  'Jun  9 06:06:21 host1 kernel: x\n' +
  'Jun  9 06:06:22 fw01 firewall: deny\n';

const OVERLAY_CONF = `ruleset(name="catchall") {
  action(type="omfile" file="/var/log/everything")
}
`;

function run(args: string[]): { stdout: string; status: number } {
  try {
    const stdout = execFileSync('node', [CLI, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    return { stdout, status: 0 };
  } catch (e) {
    const err = e as { stdout?: Buffer; status?: number };
    return { stdout: err.stdout?.toString('utf8') ?? '', status: err.status ?? 1 };
  }
}

describe('cli/diff', () => {
  let tmpDir: string;
  let overlayDir: string;
  let linesFile: string;

  beforeAll(() => {
    if (!fs.existsSync(CLI)) {
      throw new Error(
        `CLI not built at ${CLI} — run \`npm run build:server\` before this suite`
      );
    }
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'logflow-cli-'));
    linesFile = path.join(tmpDir, 'lines.txt');
    fs.writeFileSync(linesFile, SAMPLE_LINES);
    overlayDir = path.join(tmpDir, 'overlay');
    // Mirror conf-demo, then replace the catchall ruleset.
    fs.cpSync(CONF, overlayDir, { recursive: true });
    fs.writeFileSync(path.join(overlayDir, 'etc/rsyslog.d/10-catchall.conf'), OVERLAY_CONF);
  });

  it('replay prints aggregate verdict and exits 0', () => {
    const r = run(['replay', CONF, `--lines=${linesFile}`]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Replayed');
    expect(r.stdout).toContain('processed=3');
    expect(r.stdout).toContain('per-ruleset');
  });

  it('diff detects route changes via --overlay-dir', () => {
    const r = run(['diff', CONF, `--lines=${linesFile}`, `--overlay-dir=${overlayDir}`]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Diff verdict');
    expect(r.stdout).toContain('routeChanges=3');
    expect(r.stdout).toContain('/var/log/everything');
  });

  it('diff fails when --max-route-change-pct is exceeded', () => {
    const r = run([
      'diff',
      CONF,
      `--lines=${linesFile}`,
      `--overlay-dir=${overlayDir}`,
      '--max-route-change-pct=10'
    ]);
    expect(r.status).toBe(1);
  });

  it('rejects invalid --format with exit 3 and a helpful message', () => {
    const r = run(['parse', CONF, '--format=banana']);
    expect(r.status).toBe(3);
  });

  it('rejects invalid --fail-on with exit 3', () => {
    const r = run(['parse', CONF, '--fail-on=panic']);
    expect(r.status).toBe(3);
  });

  it('diff emits github-format annotations', () => {
    const r = run([
      'diff',
      CONF,
      `--lines=${linesFile}`,
      `--overlay-dir=${overlayDir}`,
      '--format=github'
    ]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^::warning|::notice/m);
    expect(r.stdout).toContain('logflow-sim diff');
  });
});
