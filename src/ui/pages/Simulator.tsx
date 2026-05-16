import { useEffect, useRef, useState } from 'preact/hooks';
import { useT } from '../i18n/index.js';
import { apiPost } from '../lib/api';
import { useApi } from '../hooks/useApi';
import { Card, Tabs, SectionHeading, Badge, JsonViewer, SourceLocChip, EmptyState } from '../components/UI';
import { IconBolt, IconPlay } from '../components/Icons';

interface SimRequest {
  transport: 'udp' | 'tcp';
  port: number;
  fromhost?: string;
  fromhostIp?: string;
  hostname?: string;
  programname?: string;
  syslogtag?: string;
  rawmsg?: string;
  msg?: string;
}

interface TraceEvent {
  step: number;
  type: string;
  message: string;
  source?: { file: string; line: number; col: number };
  details?: Record<string, unknown>;
}

interface SimResult {
  selectedInput: { type: string; port: number; ruleset?: string; source: any } | null;
  selectedRuleset: string | null;
  finalState: {
    dropped: boolean;
    stopped: boolean;
    localVars: Record<string, string>;
    structured: Record<string, string>;
    outputs: any[];
  };
  trace: TraceEvent[];
  diagnostics: { severity: string; message: string; source?: any }[];
}

interface TestsList {
  tests: { name: string; file: string; input: SimRequest }[];
}

const STORAGE_KEY = 'sim:form:v1';

const DEFAULT_FORM: SimRequest = {
  transport: 'udp',
  port: 514,
  fromhost: 'fw01',
  fromhostIp: '10.1.2.3',
  hostname: 'fw01',
  programname: 'firewall',
  syslogtag: 'firewall:',
  rawmsg: '<134>May 15 12:00:00 fw01 firewall: deny tcp 10.0.0.1 -> 8.8.8.8:53',
  msg: 'deny tcp 10.0.0.1 -> 8.8.8.8:53'
};

function loadStored(): SimRequest {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...DEFAULT_FORM, ...JSON.parse(raw) };
  } catch {}
  return DEFAULT_FORM;
}

export function SimulatorPage() {
  const { t } = useT();
  const [form, setForm] = useState<SimRequest>(loadStored);
  const [result, setResult] = useState<SimResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState('summary');
  const tests = useApi<TestsList>('/tests');
  const resultRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(form));
    } catch {}
  }, [form]);

  function update<K extends keyof SimRequest>(k: K, v: SimRequest[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const r = await apiPost<SimResult>('/simulate', form);
      setResult(r);
      // Pull the result into view — on narrow viewports the result column
      // sits below the form and is easy to miss without scrolling.
      requestAnimationFrame(() => {
        resultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function applyPreset(name: string) {
    if (!tests.data) return;
    const tc = tests.data.tests.find((t) => t.name === name || t.file === name);
    if (tc) setForm({ ...DEFAULT_FORM, ...tc.input });
  }

  return (
    <div>
      <SectionHeading
        title={t('page.simulator.title')}
        description={t('page.simulator.description')}
        actions={
          <button class="btn-primary" onClick={run} disabled={busy}>
            {busy ? '…' : <IconPlay size={14} />}
            <span>Run simulation</span>
          </button>
        }
      />

      <div class="grid grid-cols-1 lg:grid-cols-5 gap-6">
        {/* Form */}
        <div class="lg:col-span-2 space-y-4">
          <Card>
            <div class="flex items-center justify-between gap-3 mb-3">
              <div class="font-semibold shrink-0">Message</div>
              {tests.data && tests.data.tests.length > 0 && (
                <select
                  class="input text-xs min-w-0 max-w-[60%]"
                  onChange={(e) => applyPreset((e.target as HTMLSelectElement).value)}
                  defaultValue=""
                >
                  <option value="">Presets…</option>
                  {tests.data.tests.map((t) => (
                    <option value={t.name}>{t.name}</option>
                  ))}
                </select>
              )}
            </div>
            <div class="grid grid-cols-2 gap-3">
              <div>
                <label class="label">Transport</label>
                <select
                  class="input"
                  value={form.transport}
                  onChange={(e) => update('transport', (e.target as HTMLSelectElement).value as 'udp' | 'tcp')}
                >
                  <option value="udp">UDP</option>
                  <option value="tcp">TCP</option>
                </select>
              </div>
              <div>
                <label class="label">Port</label>
                <input
                  class="input"
                  type="number"
                  value={form.port}
                  onInput={(e) => update('port', parseInt((e.target as HTMLInputElement).value, 10) || 0)}
                />
              </div>
              <div>
                <label class="label">fromhost</label>
                <input
                  class="input"
                  value={form.fromhost ?? ''}
                  onInput={(e) => update('fromhost', (e.target as HTMLInputElement).value)}
                />
              </div>
              <div>
                <label class="label">fromhost-ip</label>
                <input
                  class="input"
                  value={form.fromhostIp ?? ''}
                  onInput={(e) => update('fromhostIp', (e.target as HTMLInputElement).value)}
                />
              </div>
              <div>
                <label class="label">hostname</label>
                <input
                  class="input"
                  value={form.hostname ?? ''}
                  onInput={(e) => update('hostname', (e.target as HTMLInputElement).value)}
                />
              </div>
              <div>
                <label class="label">programname</label>
                <input
                  class="input"
                  value={form.programname ?? ''}
                  onInput={(e) => update('programname', (e.target as HTMLInputElement).value)}
                />
              </div>
              <div class="col-span-2">
                <label class="label">syslogtag</label>
                <input
                  class="input"
                  value={form.syslogtag ?? ''}
                  onInput={(e) => update('syslogtag', (e.target as HTMLInputElement).value)}
                />
              </div>
              <div class="col-span-2">
                <label class="label">msg</label>
                <textarea
                  class="input font-mono"
                  rows={2}
                  value={form.msg ?? ''}
                  onInput={(e) => update('msg', (e.target as HTMLTextAreaElement).value)}
                />
              </div>
              <div class="col-span-2">
                <label class="label">rawmsg</label>
                <textarea
                  class="input font-mono"
                  rows={3}
                  value={form.rawmsg ?? ''}
                  onInput={(e) => update('rawmsg', (e.target as HTMLTextAreaElement).value)}
                />
              </div>
            </div>
          </Card>
          {error && (
            <Card class="border-danger/40 bg-danger/5 text-sm text-danger">{error}</Card>
          )}
        </div>

        {/* Result */}
        <div class="lg:col-span-3" ref={resultRef}>
          {!result && !busy && (
            <EmptyState
              title="No simulation yet"
              description="Fill out the form and click Run simulation."
              action={
                <button class="btn-primary" onClick={run}>
                  <IconBolt size={14} /> Run with sample
                </button>
              }
            />
          )}
          {result && (
            <Card class="!p-0 overflow-hidden">
              <div class="px-4 pt-3">
                <Tabs
                  active={tab}
                  onChange={setTab}
                  tabs={[
                    { id: 'summary', label: 'Summary' },
                    { id: 'trace', label: 'Trace', badge: result.trace.length },
                    { id: 'outputs', label: 'Outputs', badge: result.finalState.outputs.length },
                    { id: 'vars', label: 'Variables' },
                    { id: 'raw', label: 'Raw' }
                  ]}
                />
              </div>
              <div class="p-5">
                {tab === 'summary' && <SummaryView r={result} />}
                {tab === 'trace' && <TraceView events={result.trace} />}
                {tab === 'outputs' && <OutputsView outputs={result.finalState.outputs} />}
                {tab === 'vars' && (
                  <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div>
                      <div class="text-sm font-semibold mb-2">$. local vars</div>
                      <JsonViewer value={result.finalState.localVars} />
                    </div>
                    <div>
                      <div class="text-sm font-semibold mb-2">$! structured</div>
                      <JsonViewer value={result.finalState.structured} />
                    </div>
                  </div>
                )}
                {tab === 'raw' && <JsonViewer value={result} />}
              </div>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

function SummaryView({ r }: { r: SimResult }) {
  return (
    <div class="space-y-4">
      <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Mini label="Input" value={r.selectedInput ? `${r.selectedInput.type}:${r.selectedInput.port}` : '—'} />
        <Mini label="Ruleset" value={r.selectedRuleset ?? '—'} mono />
        <Mini
          label="Stopped"
          value={r.finalState.stopped ? 'yes' : 'no'}
          tone={r.finalState.stopped ? 'ok' : 'neutral'}
        />
        <Mini
          label="Outputs"
          value={String(r.finalState.outputs.length)}
          tone={r.finalState.outputs.length ? 'accent' : 'neutral'}
        />
      </div>
      {r.diagnostics.length > 0 && (
        <div class="border border-warn/30 bg-warn/5 rounded-lg p-3 text-sm">
          <div class="font-medium text-warn mb-2">Runtime diagnostics</div>
          <ul class="space-y-1">
            {r.diagnostics.map((d) => (
              <li class="text-fg-muted">
                <Badge tone={d.severity === 'error' ? 'error' : 'warn'}>{d.severity}</Badge>{' '}
                {d.message}{' '}
                {d.source && <SourceLocChip file={d.source.file} line={d.source.line} />}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function Mini({
  label,
  value,
  mono,
  tone = 'neutral'
}: {
  label: string;
  value: string;
  mono?: boolean;
  tone?: 'neutral' | 'ok' | 'accent';
}) {
  const cls = tone === 'ok' ? 'text-ok' : tone === 'accent' ? 'text-accent' : 'text-fg';
  return (
    <div class="card !p-3">
      <div class="text-[11px] uppercase tracking-wider text-fg-subtle">{label}</div>
      <div class={`mt-1 ${mono ? 'font-mono text-sm' : 'text-base font-semibold'} ${cls}`}>{value}</div>
    </div>
  );
}

function TraceView({ events }: { events: TraceEvent[] }) {
  if (events.length === 0) return <EmptyState title="No trace events" />;
  return (
    <ol class="relative border-l border-border ml-2">
      {events.map((e) => (
        <li class="ml-4 py-2.5 relative">
          <span
            class={`absolute -left-[1.45rem] mt-1 w-3 h-3 rounded-full border-2 border-bg ${typeColor(
              e.type
            )}`}
          />
          <div class="flex items-baseline gap-2 flex-wrap">
            <span class="text-[11px] font-mono text-fg-subtle">#{e.step}</span>
            <span class={`text-[11px] font-semibold uppercase tracking-wider ${typeTextColor(e.type)}`}>
              {e.type.replace('_', ' ')}
            </span>
            <span class="text-sm">{e.message}</span>
            {e.source && <SourceLocChip file={e.source.file} line={e.source.line} col={e.source.col} />}
          </div>
          {e.details && Object.keys(e.details).length > 0 && (
            <details class="mt-1 ml-1">
              <summary class="text-xs text-fg-muted cursor-pointer hover:text-fg">details</summary>
              <pre class="mt-1 text-xs bg-bg-subtle border border-border rounded p-2 overflow-x-auto">
                {JSON.stringify(e.details, null, 2)}
              </pre>
            </details>
          )}
        </li>
      ))}
    </ol>
  );
}

function typeColor(t: string): string {
  if (t === 'action') return 'bg-accent';
  if (t === 'stop') return 'bg-danger';
  if (t === 'lookup') return 'bg-warn';
  if (t === 'condition_eval') return 'bg-fg-muted';
  if (t === 'input_selected' || t === 'ruleset_entered') return 'bg-ok';
  if (t === 'set' || t === 'reset') return 'bg-accent/70';
  if (t === 'unset') return 'bg-danger/70';
  return 'bg-fg-subtle';
}
function typeTextColor(t: string): string {
  if (t === 'action') return 'text-accent';
  if (t === 'stop') return 'text-danger';
  if (t === 'lookup') return 'text-warn';
  if (t === 'input_selected' || t === 'ruleset_entered') return 'text-ok';
  if (t === 'unset') return 'text-danger';
  return 'text-fg-muted';
}

function OutputsView({ outputs }: { outputs: any[] }) {
  if (outputs.length === 0) return <EmptyState title="No outputs" description="The simulation produced no actions." />;
  return (
    <ul class="space-y-3">
      {outputs.map((o, i) => (
        <li class="card !p-4">
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-2">
              <Badge tone={o.kind === 'omfile' ? 'accent' : o.kind === 'omfwd' ? 'ok' : 'neutral'}>
                {o.kind}
              </Badge>
              <span class="text-xs text-fg-subtle">#{i + 1}</span>
            </div>
            {o.source && <SourceLocChip file={o.source.file} line={o.source.line} />}
          </div>
          <div class="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
            {o.path && <KV k="path" v={o.path} />}
            {o.template && <KV k="template" v={o.template} />}
            {o.target && <KV k="target" v={o.target} />}
            {o.port && <KV k="port" v={String(o.port)} />}
            {o.protocol && <KV k="protocol" v={o.protocol} />}
          </div>
        </li>
      ))}
    </ul>
  );
}

function KV({ k, v }: { k: string; v: string }) {
  return (
    <div class="flex items-baseline gap-2">
      <span class="text-[11px] uppercase tracking-wider text-fg-subtle">{k}</span>
      <code class="text-xs break-all">{v}</code>
    </div>
  );
}
