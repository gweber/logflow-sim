import { useEffect, useRef, useState } from 'preact/hooks';
import { useT } from '../i18n/index.js';
import { apiPost, apiGetText } from '../lib/api';
import { useApi } from '../hooks/useApi';
import {
  Card,
  SectionHeading,
  Badge,
  Tabs,
  EmptyState,
  JsonViewer
} from '../components/UI';
import { IconPlay, IconBolt, IconFile, IconArrowRight } from '../components/Icons';

/**
 * Diff Mode — replay the same message batch through the live config and an
 * overlay variant, and surface what would change. Operator question this
 * answers: "if I merge this PR, which logs change routing?".
 */

interface BucketCount { key: string; count: number; pct: number }
interface OutputBucket { kind: string; target: string; count: number }
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
}
interface DiffBucketDelta { key: string; baseline: number; overlay: number; delta: number }
interface DiffOutputDelta { kind: string; target: string; baseline: number; overlay: number; delta: number }
interface DiffSample {
  index: number;
  programname?: string;
  hostname?: string;
  msg?: string;
  baselineOutputs: string[];
  overlayOutputs: string[];
}
interface DiffReport {
  baseline: ReplayReport;
  overlay: ReplayReport;
  outputDeltas: DiffOutputDelta[];
  rulesetDeltas: DiffBucketDelta[];
  routeChanges: number;
  movedToDelivered: number;
  movedToUnmatched: number;
  routeChangeSamples: DiffSample[];
}
interface DiffResponse {
  dialect: string;
  overlayFiles: string[];
  diff: DiffReport;
}

interface ConfigTreeFile { path: string; size: number; referenced: boolean }
interface ConfigTreeResp { files: ConfigTreeFile[] }

const SAMPLE_LINES = [
  'Jun  9 06:06:20 host01 sshd: opened',
  'Jun  9 06:06:21 host01 kernel: usb 1-1 connect',
  '<86>Mar 18 15:00:03 fw01 firewall: deny tcp 10.0.0.1 -> 8.8.8.8:53',
  'Jun  9 06:06:23 host01 ftpd: connection from 1.2.3.4',
  'Jun  9 06:06:24 host01 named: query 8.8.8.8'
].join('\n');

export function DiffPage() {
  const { t } = useT();
  const [source, setSource] = useState<'lines' | 'pcap'>('lines');
  const [text, setText] = useState<string>(SAMPLE_LINES);
  const [pcap, setPcap] = useState<{ name: string; base64: string; size: number } | null>(null);
  // Multi-file overlay: the user can override any number of files. The
  // textarea shows whichever one is currently selected. Originals are kept
  // for diff-vs-live detection and reset-to-live.
  const [activePath, setActivePath] = useState<string>('');
  const [overlays, setOverlays] = useState<Record<string, string>>({});
  const [originals, setOriginals] = useState<Record<string, string>>({});
  const [maxMessages, setMaxMessages] = useState<number>(50000);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<DiffResponse | null>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const tree = useApi<ConfigTreeResp>('/config/tree');

  // Pick a sensible default overlay file once the tree arrives: the first
  // .conf file (skips lookups, which need different syntax handling).
  useEffect(() => {
    if (activePath || !tree.data) return;
    const first = tree.data.files.find((f) => f.path.endsWith('.conf'));
    if (first) setActivePath(first.path);
  }, [tree.data, activePath]);

  // When the active path changes, fetch the live content if we don't have
  // it yet. We keep the user's in-progress edits across switches.
  useEffect(() => {
    if (!activePath) return;
    if (originals[activePath] !== undefined) return;
    apiGetText(`/config/file?path=${encodeURIComponent(activePath)}`)
      .then((t) => setOriginals((o) => ({ ...o, [activePath]: t })))
      .catch(() => setOriginals((o) => ({ ...o, [activePath]: '' })));
  }, [activePath, originals]);

  const liveContent = originals[activePath] ?? '';
  const draftContent = overlays[activePath] ?? liveContent;

  function editActive(newContent: string): void {
    setOverlays((o) => {
      const live = originals[activePath] ?? '';
      const next = { ...o };
      if (newContent === live) delete next[activePath];
      else next[activePath] = newContent;
      return next;
    });
  }

  function resetActive(): void {
    setOverlays((o) => {
      const next = { ...o };
      delete next[activePath];
      return next;
    });
  }

  function removeOverlay(p: string): void {
    setOverlays((o) => {
      const next = { ...o };
      delete next[p];
      return next;
    });
  }

  const editedPaths = Object.keys(overlays);
  const overlayDirty = editedPaths.length > 0;

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
      const body: Record<string, unknown> = {
        overlay: overlays,
        maxMessages
      };
      if (source === 'lines') body.text = text;
      else if (pcap) body.pcapBase64 = pcap.base64;
      else throw new Error('Pick a pcap first.');
      const r = await apiPost<DiffResponse>('/replay/diff', body);
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

  // Editable files: .conf rules plus .json lookup tables. Both flow through
  // the same overlay map on the backend.
  const editableFiles =
    tree.data?.files.filter(
      (f) => f.path.endsWith('.conf') || f.path.endsWith('.json')
    ) ?? [];

  return (
    <div>
      <SectionHeading
        title={t('page.diff.title')}
        description={t('page.diff.description')}
        actions={
          <button class="btn-primary" onClick={run} disabled={busy || !overlayDirty}>
            {busy ? '…' : <IconPlay size={14} />}
            <span>Run diff</span>
          </button>
        }
      />

      <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Source */}
        <Card class="!p-0 overflow-hidden">
          <div class="px-4 pt-2 flex items-center justify-between">
            <div class="font-semibold py-2">Replay source</div>
            <div class="text-xs text-fg-subtle">same batch on both sides</div>
          </div>
          <div class="px-4 border-t border-border">
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
              <textarea
                class="input font-mono text-xs"
                rows={9}
                value={text}
                onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
              />
            )}
            {source === 'pcap' && (
              <>
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
                  <div class="text-xs text-fg-muted">
                    <span class="font-mono text-fg">{pcap.name}</span>
                    {' · '}
                    {(pcap.size / 1024).toFixed(1)} KB
                  </div>
                )}
              </>
            )}
            <div>
              <label class="label">Max messages</label>
              <input
                class="input"
                type="number"
                value={maxMessages}
                onInput={(e) =>
                  setMaxMessages(parseInt((e.target as HTMLInputElement).value, 10) || 0)
                }
              />
            </div>
          </div>
        </Card>

        {/* Overlay */}
        <Card class="!p-0 overflow-hidden">
          <div class="px-4 py-2 flex items-center justify-between border-b border-border">
            <div class="font-semibold">Overlay</div>
            {overlayDirty ? (
              <Badge tone="warn">
                {editedPaths.length} file{editedPaths.length === 1 ? '' : 's'} edited
              </Badge>
            ) : (
              <span class="text-xs text-fg-subtle">unchanged</span>
            )}
          </div>
          <div class="p-4 space-y-3">
            <label class="label">File to override</label>
            <select
              class="input font-mono text-xs"
              value={activePath}
              onChange={(e) => setActivePath((e.target as HTMLSelectElement).value)}
            >
              {editableFiles.map((f) => (
                <option value={f.path}>
                  {overlays[f.path] !== undefined ? '● ' : '  '}
                  {f.path}
                </option>
              ))}
            </select>
            <textarea
              class="input font-mono text-xs"
              rows={9}
              value={draftContent}
              onInput={(e) => editActive((e.target as HTMLTextAreaElement).value)}
              placeholder="Edit the file content. Switch files in the dropdown — each file's draft is kept."
            />
            <div class="flex items-center justify-between gap-2">
              <div class="flex flex-wrap gap-1.5">
                {editedPaths.map((p) => (
                  <span
                    class={`chip cursor-pointer ${
                      p === activePath ? 'border-accent text-accent' : ''
                    }`}
                    onClick={() => setActivePath(p)}
                    title="Click to focus, × to remove"
                  >
                    <span class="font-mono">{p.split('/').pop()}</span>
                    <button
                      class="text-fg-subtle hover:text-danger ml-1"
                      onClick={(e) => {
                        e.stopPropagation();
                        removeOverlay(p);
                      }}
                      aria-label={`Remove overlay for ${p}`}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
              <button
                class="btn-ghost !py-1 text-xs"
                onClick={resetActive}
                disabled={overlays[activePath] === undefined}
              >
                Reset to live
              </button>
            </div>
          </div>
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
            title="No diff yet"
            description="Edit the overlay file and click Run diff. Routing deltas will show here."
            action={
              <button class="btn-primary" onClick={run} disabled={!overlayDirty}>
                <IconBolt size={14} /> Run diff
              </button>
            }
          />
        )}
        {result && <DiffResult result={result} />}
      </div>
    </div>
  );
}

function DiffResult({ result }: { result: DiffResponse }) {
  const d = result.diff;
  return (
    <div class="space-y-4">
      {/* Verdict tiles */}
      <Card class="!p-0 overflow-hidden">
        <div class="grid grid-cols-2 sm:grid-cols-4 divide-y sm:divide-y-0 sm:divide-x divide-border">
          <Tile
            label="route changes"
            value={d.routeChanges.toLocaleString()}
            tone={d.routeChanges ? 'accent' : 'neutral'}
          />
          <Tile
            label="moved to delivered"
            value={`+${d.movedToDelivered}`}
            tone={d.movedToDelivered ? 'ok' : 'neutral'}
          />
          <Tile
            label="moved to unmatched"
            value={`−${d.movedToUnmatched}`}
            tone={d.movedToUnmatched ? 'error' : 'neutral'}
          />
          <Tile label="processed" value={d.baseline.processed.toLocaleString()} />
        </div>
      </Card>

      <div class="text-xs text-fg-muted">
        Overlaying <span class="font-mono text-fg">{result.overlayFiles.join(', ')}</span>{' '}
        <IconArrowRight size={12} /> dialect: <span class="font-mono">{result.dialect}</span>
      </div>

      {/* Output deltas */}
      <Card>
        <div class="flex items-center justify-between mb-3">
          <div class="font-semibold">Output deltas</div>
          <Badge>{d.outputDeltas.length}</Badge>
        </div>
        {d.outputDeltas.length === 0 ? (
          <div class="text-sm text-fg-muted">No output destinations changed.</div>
        ) : (
          <table class="w-full text-sm">
            <thead>
              <tr class="text-[11px] uppercase tracking-wider text-fg-subtle">
                <th class="text-left py-1.5">kind</th>
                <th class="text-left py-1.5">target</th>
                <th class="text-right py-1.5">baseline</th>
                <th class="text-right py-1.5">overlay</th>
                <th class="text-right py-1.5">delta</th>
              </tr>
            </thead>
            <tbody>
              {d.outputDeltas.map((o) => (
                <tr class="border-t border-border">
                  <td class="py-1.5">
                    <Badge tone={o.kind === 'omfwd' ? 'ok' : 'accent'}>{o.kind}</Badge>
                  </td>
                  <td class="py-1.5 font-mono text-xs break-all">{o.target}</td>
                  <td class="py-1.5 text-right tabular-nums">{o.baseline.toLocaleString()}</td>
                  <td class="py-1.5 text-right tabular-nums">{o.overlay.toLocaleString()}</td>
                  <td
                    class={`py-1.5 text-right tabular-nums font-semibold ${
                      o.delta > 0 ? 'text-ok' : o.delta < 0 ? 'text-danger' : 'text-fg-muted'
                    }`}
                  >
                    {o.delta > 0 ? '+' : ''}
                    {o.delta.toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {/* Ruleset deltas */}
      {d.rulesetDeltas.length > 0 && (
        <Card>
          <div class="flex items-center justify-between mb-3">
            <div class="font-semibold">Ruleset deltas</div>
            <Badge>{d.rulesetDeltas.length}</Badge>
          </div>
          <table class="w-full text-sm">
            <thead>
              <tr class="text-[11px] uppercase tracking-wider text-fg-subtle">
                <th class="text-left py-1.5">ruleset</th>
                <th class="text-right py-1.5">baseline</th>
                <th class="text-right py-1.5">overlay</th>
                <th class="text-right py-1.5">delta</th>
              </tr>
            </thead>
            <tbody>
              {d.rulesetDeltas.map((rs) => (
                <tr class="border-t border-border">
                  <td class="py-1.5 font-mono">{rs.key}</td>
                  <td class="py-1.5 text-right tabular-nums">{rs.baseline.toLocaleString()}</td>
                  <td class="py-1.5 text-right tabular-nums">{rs.overlay.toLocaleString()}</td>
                  <td
                    class={`py-1.5 text-right tabular-nums font-semibold ${
                      rs.delta > 0 ? 'text-ok' : rs.delta < 0 ? 'text-danger' : 'text-fg-muted'
                    }`}
                  >
                    {rs.delta > 0 ? '+' : ''}
                    {rs.delta.toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {/* Route change samples */}
      {d.routeChangeSamples.length > 0 && (
        <Card>
          <div class="flex items-center justify-between mb-3">
            <div class="font-semibold">Route change samples</div>
            <Badge>{d.routeChangeSamples.length}</Badge>
          </div>
          <ul class="space-y-3">
            {d.routeChangeSamples.map((s) => (
              <li class="border border-border rounded-lg p-3 bg-bg-subtle">
                <div class="flex items-center gap-2 text-xs mb-2">
                  <span class="font-mono text-fg-subtle">#{s.index}</span>
                  {s.programname && <span class="chip font-mono">prog: {s.programname}</span>}
                  {s.hostname && <span class="chip font-mono">host: {s.hostname}</span>}
                </div>
                {s.msg && <div class="font-mono text-xs text-fg-muted mb-2 break-all">{s.msg}</div>}
                <div class="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                  <div>
                    <div class="text-[11px] uppercase tracking-wider text-fg-subtle mb-1">baseline</div>
                    <RouteList outputs={s.baselineOutputs} />
                  </div>
                  <div>
                    <div class="text-[11px] uppercase tracking-wider text-fg-subtle mb-1">overlay</div>
                    <RouteList outputs={s.overlayOutputs} highlight />
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

function RouteList({ outputs, highlight }: { outputs: string[]; highlight?: boolean }) {
  if (outputs.length === 0) {
    return <div class="text-fg-subtle">— dropped —</div>;
  }
  return (
    <ul class="space-y-1">
      {outputs.map((o) => (
        <li class={`font-mono break-all ${highlight ? 'text-accent' : 'text-fg-muted'}`}>{o}</li>
      ))}
    </ul>
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
