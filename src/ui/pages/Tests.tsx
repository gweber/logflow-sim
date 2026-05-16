import { useState } from 'preact/hooks';
import { useT } from '../i18n/index.js';
import { useApi } from '../hooks/useApi';
import { apiPost } from '../lib/api';
import { Card, SectionHeading, Badge, EmptyState, JsonViewer } from '../components/UI';
import { IconPlay, IconCheck, IconX } from '../components/Icons';

interface TestsList {
  tests: { name: string; file: string; input: unknown; expect?: unknown }[];
}

interface RunResults {
  total: number;
  passed: number;
  failed: number;
  results: {
    name: string;
    file: string;
    passed: boolean;
    checks: { name: string; passed: boolean; want?: unknown; got?: unknown }[];
    result: { selectedRuleset: string | null; finalState: any; trace: any[] };
  }[];
}

export function TestsPage() {
  const { t } = useT();
  const tests = useApi<TestsList>('/tests');
  const [runs, setRuns] = useState<RunResults | null>(null);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  async function runAll() {
    setBusy(true);
    try {
      const r = await apiPost<RunResults>('/tests/run', {});
      setRuns(r);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <SectionHeading
        title={t('page.tests.title')}
        description={t('page.tests.description')}
        actions={
          <button class="btn-primary" onClick={runAll} disabled={busy}>
            <IconPlay size={14} />
            <span>{busy ? 'Running…' : 'Run all'}</span>
          </button>
        }
      />

      {!tests.data?.tests.length && (
        <EmptyState
          title="No tests defined"
          description="Add JSON files under conf/tests/ to define expectations."
        />
      )}

      {runs && (
        <Card class="mb-4 flex items-center justify-between">
          <div class="text-sm">
            <span class="font-semibold">{runs.passed}</span>/{runs.total} passing{' '}
            {runs.failed > 0 && (
              <Badge tone="error">
                {runs.failed} failed
              </Badge>
            )}
          </div>
          <div class="text-xs text-fg-muted">Click a row to expand details.</div>
        </Card>
      )}

      <div class="space-y-2">
        {tests.data?.tests.map((t) => {
          const r = runs?.results.find((x) => x.name === t.name && x.file === t.file);
          const open = expanded === `${t.file}::${t.name}`;
          return (
            <Card class="!p-0 overflow-hidden">
              <button
                class="w-full flex items-center justify-between px-4 py-3 hover:bg-bg-subtle/50 text-left"
                onClick={() => setExpanded(open ? null : `${t.file}::${t.name}`)}
              >
                <div class="flex items-center gap-3">
                  {r ? (
                    r.passed ? (
                      <span class="w-6 h-6 rounded-full bg-ok/15 text-ok flex items-center justify-center">
                        <IconCheck size={14} />
                      </span>
                    ) : (
                      <span class="w-6 h-6 rounded-full bg-danger/15 text-danger flex items-center justify-center">
                        <IconX size={14} />
                      </span>
                    )
                  ) : (
                    <span class="w-6 h-6 rounded-full bg-bg-subtle border border-border" />
                  )}
                  <div>
                    <div class="font-medium text-sm">{t.name}</div>
                    <div class="text-xs text-fg-subtle font-mono">{t.file}</div>
                  </div>
                </div>
                {r && (
                  <Badge tone={r.passed ? 'ok' : 'error'}>
                    {r.checks.filter((c) => c.passed).length}/{r.checks.length} checks
                  </Badge>
                )}
              </button>
              {open && (
                <div class="border-t border-border p-4 space-y-3">
                  <div>
                    <div class="text-xs uppercase tracking-wider text-fg-subtle mb-2">Input</div>
                    <JsonViewer value={t.input} />
                  </div>
                  {r && (
                    <>
                      <div>
                        <div class="text-xs uppercase tracking-wider text-fg-subtle mb-2">
                          Checks
                        </div>
                        <ul class="space-y-1">
                          {r.checks.map((c) => (
                            <li class="text-sm flex items-start gap-2">
                              {c.passed ? (
                                <IconCheck size={14} class="text-ok mt-1" />
                              ) : (
                                <IconX size={14} class="text-danger mt-1" />
                              )}
                              <div>
                                <div class="font-mono text-xs">{c.name}</div>
                                {!c.passed && (
                                  <div class="text-xs text-fg-muted">
                                    expected <code>{JSON.stringify(c.want)}</code>, got{' '}
                                    <code>{JSON.stringify(c.got)}</code>
                                  </div>
                                )}
                              </div>
                            </li>
                          ))}
                        </ul>
                      </div>
                      <div>
                        <div class="text-xs uppercase tracking-wider text-fg-subtle mb-2">
                          Result
                        </div>
                        <JsonViewer value={r.result} />
                      </div>
                    </>
                  )}
                </div>
              )}
            </Card>
          );
        })}
      </div>
    </div>
  );
}
