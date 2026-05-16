import { useEffect, useRef, useState } from 'preact/hooks';
import { useT } from '../i18n/index.js';
import { apiPost } from '../lib/api';
import {
  Card,
  SectionHeading,
  Badge,
  Tabs,
  EmptyState,
  JsonViewer
} from '../components/UI';
import { IconPlay, IconBolt, IconFile, IconArrowRight } from '../components/Icons';
import { SIGMA_CATEGORIES, rulesForCategory } from '../lib/sigma-catalog';

/**
 * Detection-Impact page — drives the Sigma engine end-to-end from the UI.
 *
 * Two modes (tab-switched):
 *   • Impact: replay a corpus through the live config, count how many
 *     messages each Sigma rule would fire on.
 *   • Diff: replay through both the live config and an overlay variant,
 *     report per-rule firing deltas — the SOC-coverage equivalent of the
 *     Routing-Diff page. A negative delta means PR-introduced detection
 *     blindness; a positive delta means new coverage.
 *
 * Sigma rules can be pasted inline or loaded from the upcoming Sigmahq
 * auto-loader (next sprint item). For now: paste-or-upload is the path.
 */

interface DetectionFireSample {
  index: number;
  programname?: string;
  hostname?: string;
  msg?: string;
}
interface DetectionRuleReport {
  id?: string;
  title: string;
  level?: string;
  tags?: string[];
  fires: number;
  samples: DetectionFireSample[];
}
interface DetectionImpactReport {
  rules: DetectionRuleReport[];
  processed: number;
  durationMs: number;
}
interface DetectionImpactResponse {
  dialect: string;
  rulesLoaded: number;
  ruleDiagnostics: { file?: string; severity: string; message: string }[];
  report: DetectionImpactReport;
}
interface DetectionDiffEntry {
  id?: string;
  title: string;
  level?: string;
  baseline: number;
  overlay: number;
  delta: number;
  pctChange: number;
  baselineSamples: DetectionFireSample[];
  overlaySamples: DetectionFireSample[];
}
interface DetectionDiffResponse {
  dialect: string;
  rulesLoaded: number;
  ruleDiagnostics: { file?: string; severity: string; message: string }[];
  overlayDiagnostics?: { severity: string; message: string }[];
  overlayFiles: string[];
  diff: {
    baseline: DetectionImpactReport;
    overlay: DetectionImpactReport;
    entries: DetectionDiffEntry[];
    regressionsCount: number;
  };
}

const SAMPLE_SIGMA = `title: Linux SSH authentication failure
id: 11111111-aaaa-aaaa-aaaa-111111111111
logsource:
  product: linux
  service: auth
detection:
  selection:
    programname:
      - sshd
      - 'sshd(pam_unix)'
    msg|contains:
      - 'Failed password'
      - 'authentication failure'
  condition: selection
level: high
tags:
  - attack.credential_access
  - attack.t1110
`;

const SAMPLE_LINES = [
  'Jun  9 06:06:20 host01 sshd: Failed password for root from 1.2.3.4 port 22',
  'Jun  9 06:06:21 host01 sshd: Accepted publickey for root',
  'Jun  9 06:06:22 host01 sshd(pam_unix): authentication failure; user=root',
  'Jun  9 06:06:23 host01 kernel: usb 1-1 disconnect',
  'Jun  9 06:06:24 host01 cron: pam_unix(cron:session): session opened'
].join('\n');

export function DetectionPage() {
  const { t } = useT();
  const [mode, setMode] = useState<'impact' | 'diff'>('impact');
  const [sigmaText, setSigmaText] = useState<string>(SAMPLE_SIGMA);
  const [corpusText, setCorpusText] = useState<string>(SAMPLE_LINES);
  const [overlayPath, setOverlayPath] = useState<string>('etc/rsyslog.d/10-catchall.conf');
  const [overlayContent, setOverlayContent] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<DetectionImpactResponse | null>(null);
  const [diffResult, setDiffResult] = useState<DetectionDiffResponse | null>(null);
  const resultRef = useRef<HTMLDivElement>(null);

  async function run(): Promise<void> {
    setBusy(true);
    setError(null);
    setResult(null);
    setDiffResult(null);
    try {
      if (mode === 'impact') {
        const r = await apiPost<DetectionImpactResponse>('/detection/impact', {
          sigmaText: [sigmaText],
          text: corpusText
        });
        setResult(r);
      } else {
        if (!overlayContent.trim()) {
          throw new Error('Provide overlay content (paste a candidate config file).');
        }
        const r = await apiPost<DetectionDiffResponse>('/detection/diff', {
          sigmaText: [sigmaText],
          text: corpusText,
          overlay: { [overlayPath]: overlayContent }
        });
        setDiffResult(r);
      }
      requestAnimationFrame(() =>
        resultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <SectionHeading
        title={t('page.detection.title')}
        description={t('page.detection.description')}
        actions={
          <button class="btn-primary" onClick={run} disabled={busy}>
            {busy ? '…' : <IconPlay size={14} />}
            <span>{mode === 'impact' ? 'Run impact' : 'Run diff'}</span>
          </button>
        }
      />

      <Card class="!p-0 overflow-hidden mb-6">
        <div class="px-4 pt-2">
          <Tabs
            active={mode}
            onChange={(id) => {
              setMode(id as 'impact' | 'diff');
              setResult(null);
              setDiffResult(null);
            }}
            tabs={[
              { id: 'impact', label: 'Impact' },
              { id: 'diff', label: 'Coverage diff' }
            ]}
          />
        </div>
      </Card>

      <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <div class="flex items-center justify-between gap-3 mb-3">
            <div class="font-semibold shrink-0">Sigma rule</div>
            <select
              class="input text-xs min-w-0 max-w-[60%]"
              onChange={(e) => {
                const v = (e.target as HTMLSelectElement).value;
                if (!v) return;
                const yaml = rulesForCategory(v);
                if (yaml) setSigmaText(yaml);
              }}
              defaultValue=""
            >
              <option value="">Load curated…</option>
              {SIGMA_CATEGORIES.map((c) => (
                <option value={c.id}>{c.label}</option>
              ))}
            </select>
          </div>
          <p class="text-xs text-fg-muted mb-2">
            Paste one or more Sigma rules (multi-document YAML), or load a curated set above.
            The matcher supports the SigmaHQ subset used by Linux/syslog rules — see{' '}
            <a class="text-accent hover:underline" href="/docs/api#detection">docs</a>.
          </p>
          <textarea
            class="input font-mono text-xs"
            rows={14}
            value={sigmaText}
            onInput={(e) => setSigmaText((e.target as HTMLTextAreaElement).value)}
          />
        </Card>

        <Card>
          <div class="flex items-center justify-between mb-3">
            <div class="font-semibold">Replay corpus</div>
            <Badge>lines</Badge>
          </div>
          <p class="text-xs text-fg-muted mb-2">
            One syslog message per line. RFC3164 wire form and post-receive lines (no PRI) both work.
          </p>
          <textarea
            class="input font-mono text-xs"
            rows={14}
            value={corpusText}
            onInput={(e) => setCorpusText((e.target as HTMLTextAreaElement).value)}
          />
        </Card>
      </div>

      {mode === 'diff' && (
        <Card class="mt-6">
          <div class="flex items-center justify-between mb-3">
            <div class="font-semibold">Overlay config</div>
            <Badge tone="warn">required for diff</Badge>
          </div>
          <p class="text-xs text-fg-muted mb-2">
            Provide a candidate replacement for ONE file in the live config tree. The Sigma engine
            re-runs the corpus through the overlaid model and reports firing deltas per rule.
          </p>
          <label class="label">Overlay file path (relative to conf-dir)</label>
          <input
            class="input font-mono text-xs"
            value={overlayPath}
            onInput={(e) => setOverlayPath((e.target as HTMLInputElement).value)}
          />
          <div class="mt-3">
            <label class="label">Overlay file content</label>
            <textarea
              class="input font-mono text-xs"
              rows={10}
              value={overlayContent}
              onInput={(e) => setOverlayContent((e.target as HTMLTextAreaElement).value)}
              placeholder="Paste the proposed file content here. Leave empty to skip the diff."
            />
          </div>
        </Card>
      )}

      {error && (
        <div class="mt-4">
          <Card class="border-danger/40 bg-danger/5 text-sm text-danger">{error}</Card>
        </div>
      )}

      <div class="mt-6" ref={resultRef}>
        {!result && !diffResult && !busy && (
          <EmptyState
            title="No detection run yet"
            description={
              mode === 'impact'
                ? 'Paste a Sigma rule, paste a corpus, click Run impact.'
                : 'Paste a Sigma rule, paste a corpus, paste your overlay candidate, click Run diff.'
            }
            action={
              <button class="btn-primary" onClick={run}>
                <IconBolt size={14} /> {mode === 'impact' ? 'Run impact' : 'Run diff'}
              </button>
            }
          />
        )}
        {result && <ImpactResultPanel result={result} />}
        {diffResult && <DiffResultPanel result={diffResult} />}
      </div>
    </div>
  );
}

function ImpactResultPanel({ result }: { result: DetectionImpactResponse }) {
  const r = result.report;
  return (
    <div class="space-y-4">
      <Card class="!p-0 overflow-hidden">
        <div class="grid grid-cols-2 sm:grid-cols-4 divide-y sm:divide-y-0 sm:divide-x divide-border">
          <Tile label="rules" value={String(result.rulesLoaded)} />
          <Tile label="processed" value={r.processed.toLocaleString()} />
          <Tile
            label="total fires"
            value={r.rules.reduce((a, x) => a + x.fires, 0).toLocaleString()}
            tone="accent"
          />
          <Tile label="duration" value={`${r.durationMs} ms`} />
        </div>
      </Card>

      <Card>
        <div class="font-semibold mb-3">Per-rule firing counts</div>
        <table class="w-full text-sm">
          <thead>
            <tr class="text-[11px] uppercase tracking-wider text-fg-subtle">
              <th class="text-left py-1.5">level</th>
              <th class="text-left py-1.5">rule</th>
              <th class="text-right py-1.5">fires</th>
              <th class="text-right py-1.5">% of corpus</th>
            </tr>
          </thead>
          <tbody>
            {r.rules.map((rule) => {
              const pct = r.processed > 0 ? ((rule.fires / r.processed) * 100).toFixed(2) : '0.00';
              return (
                <tr class="border-t border-border">
                  <td class="py-1.5">
                    {rule.level ? (
                      <Badge
                        tone={
                          rule.level === 'critical' || rule.level === 'high'
                            ? 'error'
                            : rule.level === 'medium'
                              ? 'warn'
                              : 'neutral'
                        }
                      >
                        {rule.level}
                      </Badge>
                    ) : (
                      <span class="text-fg-subtle">—</span>
                    )}
                  </td>
                  <td class="py-1.5">{rule.title}</td>
                  <td class="py-1.5 text-right tabular-nums font-semibold">
                    {rule.fires.toLocaleString()}
                  </td>
                  <td class="py-1.5 text-right tabular-nums text-fg-muted">{pct}%</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>

      {r.rules.some((x) => x.samples.length > 0) && (
        <Card>
          <div class="font-semibold mb-3">Sample fires</div>
          <ul class="space-y-3">
            {r.rules
              .filter((x) => x.samples.length > 0)
              .slice(0, 5)
              .map((rule) => (
                <li class="border border-border rounded-lg p-3 bg-bg-subtle">
                  <div class="text-sm font-medium mb-2">{rule.title}</div>
                  <ul class="space-y-1 text-xs">
                    {rule.samples.slice(0, 3).map((s) => (
                      <li class="font-mono text-fg-muted">
                        <span class="text-fg-subtle">#{s.index}</span>{' '}
                        {s.programname && (
                          <span class="text-fg">{s.programname}:</span>
                        )}{' '}
                        {s.msg?.slice(0, 120)}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
          </ul>
        </Card>
      )}

      {result.ruleDiagnostics.length > 0 && (
        <Card>
          <div class="font-semibold mb-2 text-sm">Rule-parse notes</div>
          <ul class="text-xs space-y-1">
            {result.ruleDiagnostics.map((d) => (
              <li class="text-fg-muted">
                <Badge tone={d.severity === 'error' ? 'error' : 'warn'}>{d.severity}</Badge>{' '}
                {d.message}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <details>
        <summary class="text-xs text-fg-muted cursor-pointer hover:text-fg">Raw JSON</summary>
        <div class="mt-2">
          <JsonViewer value={result} />
        </div>
      </details>
    </div>
  );
}

function DiffResultPanel({ result }: { result: DetectionDiffResponse }) {
  const d = result.diff;
  return (
    <div class="space-y-4">
      <Card class="!p-0 overflow-hidden">
        <div class="grid grid-cols-2 sm:grid-cols-4 divide-y sm:divide-y-0 sm:divide-x divide-border">
          <Tile label="rules" value={String(result.rulesLoaded)} />
          <Tile
            label="regressions"
            value={String(d.regressionsCount)}
            tone={d.regressionsCount ? 'error' : 'neutral'}
          />
          <Tile
            label="total delta"
            value={String(
              d.entries.reduce((a, e) => a + e.delta, 0)
            )}
            tone={
              d.entries.reduce((a, e) => a + e.delta, 0) < 0 ? 'error' : 'ok'
            }
          />
          <Tile label="processed" value={d.baseline.processed.toLocaleString()} />
        </div>
      </Card>

      <div class="text-xs text-fg-muted">
        Overlaying <span class="font-mono text-fg">{result.overlayFiles.join(', ')}</span>{' '}
        <IconArrowRight size={12} />
      </div>

      <Card>
        <div class="font-semibold mb-3">Per-rule coverage delta</div>
        <table class="w-full text-sm">
          <thead>
            <tr class="text-[11px] uppercase tracking-wider text-fg-subtle">
              <th class="text-left py-1.5">level</th>
              <th class="text-left py-1.5">rule</th>
              <th class="text-right py-1.5">baseline</th>
              <th class="text-right py-1.5">overlay</th>
              <th class="text-right py-1.5">delta</th>
              <th class="text-right py-1.5">%</th>
            </tr>
          </thead>
          <tbody>
            {d.entries.map((e) => (
              <tr class="border-t border-border">
                <td class="py-1.5">
                  {e.level ? (
                    <Badge
                      tone={
                        e.level === 'critical' || e.level === 'high'
                          ? 'error'
                          : e.level === 'medium'
                            ? 'warn'
                            : 'neutral'
                      }
                    >
                      {e.level}
                    </Badge>
                  ) : (
                    <span class="text-fg-subtle">—</span>
                  )}
                </td>
                <td class="py-1.5">{e.title}</td>
                <td class="py-1.5 text-right tabular-nums">{e.baseline.toLocaleString()}</td>
                <td class="py-1.5 text-right tabular-nums">{e.overlay.toLocaleString()}</td>
                <td
                  class={`py-1.5 text-right tabular-nums font-semibold ${
                    e.delta > 0 ? 'text-ok' : e.delta < 0 ? 'text-danger' : 'text-fg-muted'
                  }`}
                >
                  {e.delta > 0 ? '+' : ''}
                  {e.delta.toLocaleString()}
                </td>
                <td
                  class={`py-1.5 text-right tabular-nums text-xs ${
                    e.pctChange > 0 ? 'text-ok' : e.pctChange < 0 ? 'text-danger' : 'text-fg-muted'
                  }`}
                >
                  {e.pctChange > 0 ? '+' : ''}
                  {e.pctChange.toFixed(1)}%
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      {d.entries.some((e) => e.baselineSamples.length > 0 || e.overlaySamples.length > 0) && (
        <Card>
          <div class="font-semibold mb-3">Sample fires (baseline vs overlay)</div>
          <ul class="space-y-3">
            {d.entries
              .filter((e) => e.delta !== 0)
              .slice(0, 5)
              .map((e) => (
                <li class="border border-border rounded-lg p-3 bg-bg-subtle">
                  <div class="text-sm font-medium mb-2">{e.title}</div>
                  <div class="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                    <div>
                      <div class="text-[11px] uppercase tracking-wider text-fg-subtle mb-1">
                        baseline ({e.baseline})
                      </div>
                      <ul class="space-y-1">
                        {e.baselineSamples.slice(0, 3).map((s) => (
                          <li class="font-mono text-fg-muted truncate">
                            #{s.index} {s.programname && `${s.programname}:`} {s.msg?.slice(0, 80)}
                          </li>
                        ))}
                      </ul>
                    </div>
                    <div>
                      <div class="text-[11px] uppercase tracking-wider text-fg-subtle mb-1">
                        overlay ({e.overlay})
                      </div>
                      <ul class="space-y-1">
                        {e.overlaySamples.slice(0, 3).map((s) => (
                          <li class="font-mono text-accent truncate">
                            #{s.index} {s.programname && `${s.programname}:`} {s.msg?.slice(0, 80)}
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
                </li>
              ))}
          </ul>
        </Card>
      )}

      <details>
        <summary class="text-xs text-fg-muted cursor-pointer hover:text-fg">Raw JSON</summary>
        <div class="mt-2">
          <JsonViewer value={result} />
        </div>
      </details>
    </div>
  );
}

function Tile({
  label,
  value,
  tone = 'neutral'
}: {
  label: string;
  value: string;
  tone?: 'neutral' | 'ok' | 'warn' | 'error' | 'accent';
}) {
  const cls =
    tone === 'ok'
      ? 'text-ok'
      : tone === 'warn'
        ? 'text-warn'
        : tone === 'error'
          ? 'text-danger'
          : tone === 'accent'
            ? 'text-accent'
            : 'text-fg';
  return (
    <div class="px-4 py-4">
      <div class={`text-2xl font-semibold tabular-nums ${cls}`}>{value}</div>
      <div class="text-[11px] uppercase tracking-wider text-fg-subtle mt-1">{label}</div>
    </div>
  );
}
