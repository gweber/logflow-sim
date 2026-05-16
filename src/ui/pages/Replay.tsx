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
import { IconPlay, IconBolt, IconFile } from '../components/Icons';

/**
 * Replay — drop a batch of real syslog through the current config and see
 * where the traffic lands. Two ingress paths: paste/upload text lines, or
 * upload a pcap. Both hit the `/api/replay/*` endpoints which share the
 * aggregation engine.
 */

interface BucketCount {
  key: string;
  count: number;
  pct: number;
}
interface OutputBucket {
  kind: string;
  target: string;
  count: number;
}
interface ReplaySample {
  index: number;
  programname?: string;
  hostname?: string;
  msg?: string;
  reason?: string;
}
interface ReplayReport {
  total: number;
  processed: number;
  delivered: number;
  noInputMatch: number;
  errors: number;
  noOutput: number;
  durationMs: number;
  topPrograms: BucketCount[];
  topHostnames: BucketCount[];
  perRuleset: BucketCount[];
  perOutput: OutputBucket[];
  unmatchedSamples: ReplaySample[];
  noOutputSamples: ReplaySample[];
  errorSamples: ReplaySample[];
}
interface ReplayResponse {
  source: 'lines' | 'pcap';
  dialect: string;
  report: ReplayReport;
  pcap?: { packetsTotal: number; packetsOnSyslogPorts: number; diagnostics: string[] };
}

const SAMPLE_LINES = [
  'Jun  9 06:06:20 host01 sshd: Accepted publickey for root',
  'Jun  9 06:06:21 host01 kernel: usb 1-1 connect',
  '<86>Mar 18 15:00:03 fw01 firewall: deny tcp 10.0.0.1 -> 8.8.8.8:53',
  'Jun  9 06:06:23 host01 ftpd: connection from 1.2.3.4',
  'Jun  9 06:06:24 host01 named: query 8.8.8.8',
  '<14>1 2026-05-16T14:00:00Z host01 app - - - structured payload'
].join('\n');

export function ReplayPage() {
  const { t } = useT();
  const [source, setSource] = useState<'lines' | 'pcap'>('lines');
  const [text, setText] = useState<string>('');
  const [pcap, setPcap] = useState<{ name: string; base64: string; size: number } | null>(null);
  const [maxMessages, setMaxMessages] = useState<number>(50000);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ReplayResponse | null>(null);
  const [drill, setDrill] = useState<'unmatched' | 'noOutput' | 'errors'>('unmatched');
  const resultRef = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!text) setText(SAMPLE_LINES);
  }, []);

  async function onFile(ev: Event): Promise<void> {
    const f = (ev.target as HTMLInputElement).files?.[0];
    if (!f) return;
    const buf = new Uint8Array(await f.arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
    setPcap({ name: f.name, base64: btoa(bin), size: f.size });
  }

  async function run(): Promise<void> {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r =
        source === 'lines'
          ? await apiPost<ReplayResponse>('/replay/lines', { text, maxMessages })
          : pcap
            ? await apiPost<ReplayResponse>('/replay/pcap', {
                pcapBase64: pcap.base64,
                maxMessages
              })
            : null;
      if (!r) throw new Error('Pick a pcap first.');
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

  const samplePool =
    drill === 'unmatched'
      ? result?.report.unmatchedSamples ?? []
      : drill === 'noOutput'
        ? result?.report.noOutputSamples ?? []
        : result?.report.errorSamples ?? [];

  return (
    <div>
      <SectionHeading
        title={t('page.replay.title')}
        description={t('page.replay.description')}
        actions={
          <button class="btn-primary" onClick={run} disabled={busy}>
            {busy ? '…' : <IconPlay size={14} />}
            <span>Run replay</span>
          </button>
        }
      />

      <div class="grid grid-cols-1 lg:grid-cols-5 gap-6">
        {/* Source picker */}
        <div class="lg:col-span-2 space-y-4">
          <Card class="!p-0 overflow-hidden">
            <div class="px-4 pt-2">
              <Tabs
                active={source}
                onChange={(id) => setSource(id as 'lines' | 'pcap')}
                tabs={[
                  { id: 'lines', label: 'Paste syslog lines' },
                  { id: 'pcap', label: 'Upload pcap' }
                ]}
              />
            </div>
            <div class="p-4 space-y-3">
              {source === 'lines' && (
                <>
                  <p class="text-xs text-fg-muted">
                    One message per line. Both RFC3164 wire form (<code>&lt;PRI&gt;…</code>) and
                    post-receive lines from <code>/var/log/messages</code> are accepted.
                  </p>
                  <textarea
                    class="input font-mono text-xs"
                    rows={10}
                    value={text}
                    onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
                  />
                  <div class="flex items-center justify-between text-xs text-fg-subtle">
                    <span>{text.split('\n').filter((l) => l.trim()).length} non-empty lines</span>
                    <button
                      class="btn-ghost !py-1"
                      onClick={() => setText(SAMPLE_LINES)}
                      title="Reset to a small mixed sample"
                    >
                      Reset sample
                    </button>
                  </div>
                </>
              )}
              {source === 'pcap' && (
                <>
                  <p class="text-xs text-fg-muted">
                    Classic libpcap format (UDP/IPv4 only). pcapng files need conversion:{' '}
                    <code>editcap -F pcap in.pcapng out.pcap</code>. The simulator extracts
                    payloads sent to ports 514, 601, or 6514.
                  </p>
                  <div class="flex items-center gap-3">
                    <input
                      ref={fileInput}
                      type="file"
                      accept=".pcap,application/vnd.tcpdump.pcap"
                      class="hidden"
                      onChange={onFile}
                    />
                    <button class="btn-secondary" onClick={() => fileInput.current?.click()}>
                      <IconFile size={14} /> Choose pcap…
                    </button>
                    {pcap && (
                      <div class="text-xs text-fg-muted truncate">
                        <span class="font-mono text-fg">{pcap.name}</span>
                        {' · '}
                        {(pcap.size / 1024).toFixed(1)} KB
                      </div>
                    )}
                  </div>
                  {!pcap && (
                    <div class="text-xs text-fg-subtle">
                      No file selected. The pcap is parsed and replayed entirely on the server —
                      no packets are stored.
                    </div>
                  )}
                </>
              )}
            </div>
          </Card>

          <Card>
            <div class="font-semibold mb-3">Options</div>
            <label class="label">Max messages</label>
            <input
              class="input"
              type="number"
              min={1}
              max={500000}
              value={maxMessages}
              onInput={(e) =>
                setMaxMessages(parseInt((e.target as HTMLInputElement).value, 10) || 0)
              }
            />
            <p class="text-xs text-fg-subtle mt-2">
              Hard cap on the number of messages run through the simulator. Useful when replaying
              very large pcap captures.
            </p>
          </Card>

          {error && <Card class="border-danger/40 bg-danger/5 text-sm text-danger">{error}</Card>}
        </div>

        {/* Result */}
        <div class="lg:col-span-3" ref={resultRef}>
          {!result && !busy && (
            <EmptyState
              title="No replay yet"
              description="Pick a source, then click Run replay. The aggregate verdict appears here."
              action={
                <button class="btn-primary" onClick={run}>
                  <IconBolt size={14} /> Run with sample
                </button>
              }
            />
          )}
          {result && <ReplayResultPanel result={result} drill={drill} setDrill={setDrill} samples={samplePool} />}
        </div>
      </div>
    </div>
  );
}

function ReplayResultPanel({
  result,
  drill,
  setDrill,
  samples
}: {
  result: ReplayResponse;
  drill: 'unmatched' | 'noOutput' | 'errors';
  setDrill: (d: 'unmatched' | 'noOutput' | 'errors') => void;
  samples: ReplaySample[];
}) {
  const r = result.report;
  const denom = Math.max(1, r.processed);
  return (
    <div class="space-y-4">
      {/* Headline tiles */}
      <Card class="!p-0 overflow-hidden">
        <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 divide-y sm:divide-y-0 sm:divide-x divide-border">
          <Tile label="processed" value={r.processed.toLocaleString()} accent />
          <Tile label="delivered" value={r.delivered.toLocaleString()} tone="ok" />
          <Tile label="unmatched" value={r.noInputMatch.toLocaleString()} tone={r.noInputMatch ? 'warn' : 'neutral'} />
          <Tile label="no output" value={r.noOutput.toLocaleString()} tone={r.noOutput ? 'warn' : 'neutral'} />
          <Tile label="errors" value={r.errors.toLocaleString()} tone={r.errors ? 'error' : 'neutral'} />
          <Tile label="duration" value={`${r.durationMs} ms`} />
        </div>
      </Card>

      {result.pcap && (
        <div class="flex items-center gap-2 text-xs">
          <Badge tone="accent">pcap</Badge>
          <span class="text-fg-muted">
            {result.pcap.packetsTotal} packets, {result.pcap.packetsOnSyslogPorts} on syslog ports
            {result.pcap.diagnostics.length > 0 && (
              <> · {result.pcap.diagnostics.length} parser note(s)</>
            )}
          </span>
        </div>
      )}

      {/* Routing breakdown */}
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <div class="flex items-center justify-between mb-3">
            <div class="font-semibold">Per ruleset</div>
            <Badge>{r.perRuleset.length}</Badge>
          </div>
          <BarList items={r.perRuleset.map((x) => ({ key: x.key, count: x.count }))} denom={denom} />
        </Card>
        <Card>
          <div class="flex items-center justify-between mb-3">
            <div class="font-semibold">Per output target</div>
            <Badge>{r.perOutput.length}</Badge>
          </div>
          <BarList
            items={r.perOutput.map((o) => ({
              key: `${o.kind} · ${o.target}`,
              count: o.count
            }))}
            denom={denom}
            mono
          />
        </Card>
      </div>

      <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <div class="flex items-center justify-between mb-3">
            <div class="font-semibold">Top programs</div>
            <Badge>{r.topPrograms.length}</Badge>
          </div>
          <BarList items={r.topPrograms.map((x) => ({ key: x.key, count: x.count }))} denom={denom} mono />
        </Card>
        <Card>
          <div class="flex items-center justify-between mb-3">
            <div class="font-semibold">Top hostnames</div>
            <Badge>{r.topHostnames.length}</Badge>
          </div>
          <BarList items={r.topHostnames.map((x) => ({ key: x.key, count: x.count }))} denom={denom} mono />
        </Card>
      </div>

      {/* Drill-down */}
      {(r.unmatchedSamples.length || r.noOutputSamples.length || r.errorSamples.length) > 0 && (
        <Card class="!p-0 overflow-hidden">
          <div class="px-4 pt-3">
            <Tabs
              active={drill}
              onChange={(id) => setDrill(id as typeof drill)}
              tabs={[
                { id: 'unmatched', label: 'Unmatched', badge: r.unmatchedSamples.length },
                { id: 'noOutput', label: 'Silent drop', badge: r.noOutputSamples.length },
                { id: 'errors', label: 'Errors', badge: r.errorSamples.length }
              ]}
            />
          </div>
          <div class="p-4">
            {samples.length === 0 ? (
              <div class="text-sm text-fg-muted">No samples in this bucket.</div>
            ) : (
              <ul class="space-y-2">
                {samples.map((s) => (
                  <li class="border border-border rounded-lg p-3 text-sm bg-bg-subtle">
                    <div class="flex items-center gap-2 mb-1 text-xs">
                      <span class="font-mono text-fg-subtle">#{s.index}</span>
                      {s.programname && (
                        <span class="chip font-mono">prog: {s.programname}</span>
                      )}
                      {s.hostname && <span class="chip font-mono">host: {s.hostname}</span>}
                      {s.reason && <span class="badge-warning">{s.reason}</span>}
                    </div>
                    {s.msg && (
                      <div class="font-mono text-xs text-fg-muted break-all">{s.msg}</div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
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
  tone = 'neutral',
  accent
}: {
  label: string;
  value: string;
  tone?: 'neutral' | 'ok' | 'warn' | 'error';
  accent?: boolean;
}) {
  const cls =
    tone === 'ok'
      ? 'text-ok'
      : tone === 'warn'
        ? 'text-warn'
        : tone === 'error'
          ? 'text-danger'
          : accent
            ? 'text-fg'
            : 'text-fg';
  return (
    <div class="px-4 py-4">
      <div class={`text-2xl font-semibold tabular-nums ${cls}`}>{value}</div>
      <div class="text-[11px] uppercase tracking-wider text-fg-subtle mt-1">{label}</div>
    </div>
  );
}

function BarList({
  items,
  denom,
  mono
}: {
  items: { key: string; count: number }[];
  denom: number;
  mono?: boolean;
}) {
  if (items.length === 0) {
    return <div class="text-sm text-fg-muted">—</div>;
  }
  const max = Math.max(...items.map((i) => i.count), 1);
  return (
    <ul class="space-y-2">
      {items.map((i) => {
        const pct = Math.round((i.count / denom) * 1000) / 10;
        const fill = (i.count / max) * 100;
        return (
          <li>
            <div class="flex items-baseline justify-between gap-3 text-xs mb-1">
              <span class={`truncate ${mono ? 'font-mono' : ''} text-fg`} title={i.key}>
                {i.key}
              </span>
              <span class="text-fg-subtle tabular-nums whitespace-nowrap">
                {i.count.toLocaleString()} · {pct}%
              </span>
            </div>
            <div class="h-1.5 bg-bg-subtle rounded-full overflow-hidden">
              <div class="h-full bg-accent/70" style={{ width: `${fill}%` }} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
