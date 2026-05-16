import { useEffect, useState } from 'preact/hooks';
import { apiGet, apiPost } from '../lib/api';
import { Card, CopyButton } from './UI';
import { IconX, IconArrowRight } from './Icons';

interface DialectInfo {
  id: string;
  displayName: string;
}

interface ConvertResponse {
  sourceDialect: string;
  targetDialect: string;
  output: string;
  diagnostics: { severity: string; message: string }[];
}

/**
 * Dialog for converting the currently loaded configuration to another
 * dialect. Talks to POST /api/convert which delegates to each Dialect's
 * `emit()` implementation. Lossy conversions surface as info-severity
 * diagnostics from the kernel and are shown above the output.
 */
export function ConvertDialog({ onClose }: { onClose: () => void }) {
  const [dialects, setDialects] = useState<DialectInfo[] | null>(null);
  const [target, setTarget] = useState<string>('');
  const [result, setResult] = useState<ConvertResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    apiGet<{ dialects: DialectInfo[] }>('/dialects')
      .then((r) => {
        setDialects(r.dialects);
        if (r.dialects.length > 0) setTarget(r.dialects[0].id);
      })
      .catch(() => setDialects([]));
  }, []);

  async function run(): Promise<void> {
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      const r = await apiPost<ConvertResponse>('/convert', { target });
      setResult(r);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="fixed inset-0 z-40 flex items-start justify-center pt-20 px-4 bg-black/50">
      <Card class="w-full max-w-3xl !p-0 overflow-hidden">
        <div class="flex items-center justify-between px-5 py-3 border-b border-border">
          <div class="font-semibold">Convert configuration</div>
          <button class="btn-ghost" onClick={onClose} aria-label="Close">
            <IconX size={16} />
          </button>
        </div>
        <div class="p-5 space-y-3">
          <div class="flex items-end gap-3">
            <div class="flex-1">
              <label class="label">Target dialect</label>
              <select
                class="input"
                value={target}
                onChange={(e) => setTarget((e.target as HTMLSelectElement).value)}
              >
                {dialects?.map((d) => (
                  <option value={d.id}>{d.displayName}</option>
                ))}
              </select>
            </div>
            <button class="btn-primary" onClick={run} disabled={busy}>
              {busy ? '…' : 'Convert'} <IconArrowRight size={14} />
            </button>
          </div>

          {error && (
            <div class="rounded-lg border border-danger/30 bg-danger/5 p-3 text-sm text-danger">
              {error}
            </div>
          )}

          {result && (
            <>
              {result.diagnostics.length > 0 && (
                <div class="rounded-lg border border-warn/30 bg-warn/5 p-3 text-xs space-y-1">
                  <div class="text-warn font-medium">Conversion notes</div>
                  {result.diagnostics.map((d) => (
                    <div class="text-fg-muted">• {d.message}</div>
                  ))}
                </div>
              )}
              <div class="relative">
                <pre class="bg-bg-subtle border border-border rounded-lg p-4 overflow-auto max-h-[55vh] text-xs leading-relaxed">
                  <code>{result.output}</code>
                </pre>
                <div class="absolute top-2 right-2">
                  <CopyButton text={result.output} />
                </div>
              </div>
              <div class="text-xs text-fg-subtle">
                Converted from <span class="font-mono text-fg">{result.sourceDialect}</span> →{' '}
                <span class="font-mono text-fg">{result.targetDialect}</span>. Always validate
                the output by parsing it back through logflow-sim before deploying.
              </div>
            </>
          )}
        </div>
      </Card>
    </div>
  );
}
