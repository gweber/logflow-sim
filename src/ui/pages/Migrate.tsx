import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useT } from '../i18n/index.js';
import { apiGet, apiPost } from '../lib/api';
import { useApi } from '../hooks/useApi';
import {
  Card,
  SectionHeading,
  Badge,
  EmptyState,
  CodeBlock
} from '../components/UI';
import { IconArrowRight, IconBolt, IconCopy } from '../components/Icons';

/**
 * Migration Wizard — drives the cross-dialect converter through a guided
 * UX so an operator can take their live config and produce a working
 * equivalent in another dialect, with all conversion caveats surfaced.
 *
 * Workflow:
 *   1. Source = live config (we read the parse summary to show stats)
 *   2. Pick target dialect
 *   3. Convert → side-by-side preview + emitter diagnostics
 *   4. Copy/download the generated config
 *   5. (Optional) Replay your corpus through both to verify routing parity
 *      — the result links into /diff for the full comparison.
 */

interface DialectInfo { id: string; displayName: string; fileExtensions: string[] }
interface DialectsResp { dialects: DialectInfo[] }
interface ParseResp {
  dialect: string;
  summary: {
    inputs: number;
    rulesets: number;
    templates: number;
    lookupTables: number;
    omfileActions: number;
    omfwdActions: number;
  };
}
interface ConvertResp {
  sourceDialect: string;
  targetDialect: string;
  output: string;
  diagnostics: { severity: string; message: string; code?: string }[];
}

// Order matters for the picker — list "real migration" targets first so the
// user lands on the meaningful ones without scrolling.
const MIGRATION_FRIENDLY: string[] = ['otel', 'vector', 'syslog-ng', 'fluent-bit'];

export function MigratePage() {
  const { t } = useT();
  const dialects = useApi<DialectsResp>('/dialects');
  const parse = useApi<ParseResp>('/config/parse');
  const [target, setTarget] = useState<string>('');
  const [result, setResult] = useState<ConvertResp | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resultRef = useRef<HTMLDivElement>(null);

  const sourceDialect = parse.data?.dialect ?? null;

  // Auto-pick a sensible first target: OTel if it's not the source, else the
  // first migration-friendly dialect that isn't the source.
  useEffect(() => {
    if (target || !dialects.data || !sourceDialect) return;
    const ids = dialects.data.dialects.map((d) => d.id);
    const first =
      MIGRATION_FRIENDLY.find((id) => id !== sourceDialect && ids.includes(id)) ??
      ids.find((id) => id !== sourceDialect);
    if (first) setTarget(first);
  }, [dialects.data, sourceDialect, target]);

  const targets = useMemo(() => {
    if (!dialects.data) return [];
    const all = dialects.data.dialects.filter((d) => d.id !== sourceDialect);
    // Sort migration-friendly first, then alphabetically.
    return all.sort((a, b) => {
      const ai = MIGRATION_FRIENDLY.indexOf(a.id);
      const bi = MIGRATION_FRIENDLY.indexOf(b.id);
      if (ai !== -1 && bi !== -1) return ai - bi;
      if (ai !== -1) return -1;
      if (bi !== -1) return 1;
      return a.displayName.localeCompare(b.displayName);
    });
  }, [dialects.data, sourceDialect]);

  async function run(): Promise<void> {
    if (!target) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = await apiPost<ConvertResp>('/convert', { target });
      setResult(r);
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
        title={t('page.migrate.title')}
        description={t('page.migrate.description')}
        actions={
          <button class="btn-primary" onClick={run} disabled={busy || !target}>
            {busy ? '…' : <IconBolt size={14} />}
            <span>Convert</span>
          </button>
        }
      />

      <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card>
          <div class="text-[11px] uppercase tracking-wider text-fg-subtle mb-2">From</div>
          {parse.loading ? (
            <div class="h-16 bg-bg-subtle rounded animate-pulse" />
          ) : sourceDialect ? (
            <>
              <div class="text-xl font-semibold tracking-tight">{labelFor(sourceDialect, dialects.data)}</div>
              <div class="text-xs text-fg-subtle mt-1 font-mono">id: {sourceDialect}</div>
              {parse.data && (
                <ul class="mt-4 space-y-1 text-sm text-fg-muted">
                  <li>{parse.data.summary.inputs} inputs / receivers</li>
                  <li>{parse.data.summary.rulesets} rulesets</li>
                  <li>
                    {parse.data.summary.omfileActions + parse.data.summary.omfwdActions} action
                    sinks
                  </li>
                  <li>{parse.data.summary.lookupTables} lookup tables</li>
                </ul>
              )}
            </>
          ) : (
            <div class="text-sm text-fg-muted">No source dialect detected.</div>
          )}
        </Card>

        <div class="flex items-center justify-center text-fg-subtle py-2 lg:py-0">
          <span class="lg:hidden" aria-hidden>↓</span>
          <span class="hidden lg:inline-flex">
            <IconArrowRight size={28} />
          </span>
        </div>

        <Card>
          <div class="text-[11px] uppercase tracking-wider text-fg-subtle mb-2">To</div>
          <select
            class="input font-mono text-sm"
            value={target}
            onChange={(e) => setTarget((e.target as HTMLSelectElement).value)}
          >
            {targets.map((d) => (
              <option value={d.id}>
                {MIGRATION_FRIENDLY.includes(d.id) ? '★ ' : '  '}
                {d.displayName}
              </option>
            ))}
          </select>
          <p class="text-xs text-fg-muted mt-3">
            Marked targets are the ones we've put the most polish into. Other dialects emit a
            best-effort skeleton; refine by hand.
          </p>
        </Card>
      </div>

      {error && (
        <div class="mt-4">
          <Card class="border-danger/40 bg-danger/5 text-sm text-danger">{error}</Card>
        </div>
      )}

      <div class="mt-6" ref={resultRef}>
        {!result && !busy && (
          <EmptyState
            title="Nothing converted yet"
            description="Pick a target and click Convert."
          />
        )}
        {result && <ConvertResultPanel result={result} />}
      </div>

      {result && (
        <div class="mt-6">
          <Card>
            <div class="font-semibold mb-2">Next step: verify the routing parity</div>
            <p class="text-sm text-fg-muted">
              The converted config compiles, but the wire-level routing decisions need
              cross-checking against your real traffic. Save the output to a folder, mount it as
              the overlay in <a href="/diff" class="text-accent hover:underline">Diff Mode</a>{' '}
              alongside a replay corpus, and read off the per-output deltas — if any output's
              delta is non-zero, the conversion changed routing for that bucket and needs
              manual reconciliation.
            </p>
          </Card>
        </div>
      )}
    </div>
  );
}

function labelFor(id: string, data: DialectsResp | null): string {
  if (!data) return id;
  return data.dialects.find((d) => d.id === id)?.displayName ?? id;
}

function ConvertResultPanel({ result }: { result: ConvertResp }) {
  const lines = result.output.split('\n').length;
  const bytes = result.output.length;
  const errors = result.diagnostics.filter((d) => d.severity === 'error').length;
  const warnings = result.diagnostics.filter((d) => d.severity === 'warning').length;
  const infos = result.diagnostics.filter((d) => d.severity === 'info').length;

  function download(): void {
    const blob = new Blob([result.output], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filenameFor(result.targetDialect);
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(result.output);
    } catch {
      /* clipboard denied — user can still hit the download button */
    }
  }

  return (
    <div class="space-y-4">
      <Card class="!p-0 overflow-hidden">
        <div class="grid grid-cols-2 sm:grid-cols-5 divide-y sm:divide-y-0 sm:divide-x divide-border">
          <Tile label="lines" value={String(lines)} />
          <Tile label="bytes" value={String(bytes)} />
          <Tile
            label="errors"
            value={String(errors)}
            tone={errors ? 'error' : 'neutral'}
          />
          <Tile
            label="warnings"
            value={String(warnings)}
            tone={warnings ? 'warn' : 'neutral'}
          />
          <Tile label="notes" value={String(infos)} />
        </div>
      </Card>

      <Card>
        <div class="flex items-center justify-between mb-3">
          <div>
            <div class="font-semibold">Generated {result.targetDialect} config</div>
            <div class="text-xs text-fg-subtle font-mono">from {result.sourceDialect}</div>
          </div>
          <div class="flex items-center gap-2">
            <button class="btn-secondary text-xs" onClick={copy}>
              <IconCopy size={14} /> Copy
            </button>
            <button class="btn-secondary text-xs" onClick={download}>
              Download
            </button>
          </div>
        </div>
        <CodeBlock code={result.output} language={langFor(result.targetDialect)} />
      </Card>

      {result.diagnostics.length > 0 && (
        <Card>
          <div class="flex items-center justify-between mb-3">
            <div class="font-semibold">Conversion notes</div>
            <Badge>{result.diagnostics.length}</Badge>
          </div>
          <ul class="space-y-2 text-sm">
            {result.diagnostics.map((d) => (
              <li class="flex items-start gap-2">
                <Badge tone={d.severity === 'error' ? 'error' : d.severity === 'warning' ? 'warn' : 'accent'}>
                  {d.severity}
                </Badge>
                <div>
                  <div>{d.message}</div>
                  {d.code && (
                    <div class="text-[11px] font-mono text-fg-subtle mt-0.5">{d.code}</div>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}
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
  tone?: 'neutral' | 'warn' | 'error';
}) {
  const cls = tone === 'warn' ? 'text-warn' : tone === 'error' ? 'text-danger' : 'text-fg';
  return (
    <div class="px-4 py-4">
      <div class={`text-2xl font-semibold tabular-nums ${cls}`}>{value}</div>
      <div class="text-[11px] uppercase tracking-wider text-fg-subtle mt-1">{label}</div>
    </div>
  );
}

function filenameFor(dialectId: string): string {
  if (dialectId === 'rsyslog') return 'rsyslog.conf';
  if (dialectId === 'syslog-ng') return 'syslog-ng.conf';
  if (dialectId === 'fluent-bit') return 'fluent-bit.conf';
  if (dialectId === 'nxlog') return 'nxlog.conf';
  if (dialectId === 'logstash') return 'logstash.conf';
  if (dialectId === 'vector') return 'vector.toml';
  if (dialectId === 'otel') return 'otel-collector.yaml';
  return `${dialectId}.conf`;
}

function langFor(dialectId: string): string {
  if (dialectId === 'vector') return 'toml';
  if (dialectId === 'otel') return 'yaml';
  if (dialectId === 'fluent-bit') return 'ini';
  return 'bash';
}
