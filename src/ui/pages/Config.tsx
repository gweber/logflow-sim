import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useT } from '../i18n/index.js';
import { useApi } from '../hooks/useApi';
import { apiGet, apiGetText, apiGetUnoverridden, apiPost } from '../lib/api';
import { Card, SectionHeading, Badge, EmptyState } from '../components/UI';
import { IconFile, IconFolder, IconSearch, IconX, IconArrowRight } from '../components/Icons';
import { ConvertDialog } from '../components/ConvertDialog';
import { getActiveDialect } from '../components/DialectPicker';

interface Tree {
  confRoot: string;
  entrypoint: string;
  files: { path: string; size: number; referenced: boolean }[];
}

interface Parse {
  diagnostics: { severity: string; message: string; source: any; code?: string }[];
  summary: Record<string, number>;
  defaultRuleset: string | null;
}

function readQuery(): { file?: string; line?: number } {
  const sp = new URLSearchParams(window.location.search);
  const file = sp.get('file') ?? undefined;
  const line = sp.get('line') ? parseInt(sp.get('line')!, 10) : undefined;
  return { file, line };
}

interface SearchMatch {
  file: string;
  line: number;
  col: number;
  snippet: string;
  matchStart: number;
  matchLen: number;
}
interface SearchResult {
  query: string;
  caseSensitive: boolean;
  regex: boolean;
  total: number;
  truncated: boolean;
  matches: SearchMatch[];
}

export function ConfigPage() {
  const { t } = useT();
  const tree = useApi<Tree>('/config/tree');
  const parse = useApi<Parse>('/config/parse');
  const [selected, setSelected] = useState<string | undefined>();
  const [highlightLine, setHighlightLine] = useState<number | undefined>();
  const [highlightTerm, setHighlightTerm] = useState<string>('');
  const [content, setContent] = useState<string>('');
  const [severityFilter, setSeverityFilter] = useState<Set<string>>(
    new Set(['error', 'warning', 'info'])
  );
  const [searchInput, setSearchInput] = useState<string>('');
  const [convertOpen, setConvertOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [searchCase, setSearchCase] = useState<boolean>(false);
  const [searchRegex, setSearchRegex] = useState<boolean>(false);
  const [searchResult, setSearchResult] = useState<SearchResult | null>(null);
  const [searchBusy, setSearchBusy] = useState<boolean>(false);
  const debounceRef = useRef<number | undefined>();

  // Live-convert state — tracks the picker dialect against the live source
  // dialect. When they differ, we swap the tree + viewer to show the
  // converted-to-target multi-file output instead of the on-disk files.
  const [sourceDialect, setSourceDialect] = useState<string | null>(null);
  const [activeDialect, setActiveDialect] = useState<string | null>(getActiveDialect());
  const [convertResult, setConvertResult] = useState<{
    sourceDialect: string;
    targetDialect: string;
    files: { path: string; content: string }[];
    diagnostics: { severity: string; message: string; code?: string }[];
  } | null>(null);
  const [converting, setConverting] = useState(false);
  const [convertError, setConvertError] = useState<string | null>(null);
  // Mobile-only tab selector for the 3-pane layout. On lg+ all three panes
  // are visible at once, so this is a no-op there.
  const [mobileTab, setMobileTab] = useState<'tree' | 'viewer' | 'diag'>('tree');

  // Auto-detect the source once on mount via the dialect-override-free API
  // wrapper. We can't rely on `parse.data.dialect` because that already
  // reflects the picker's chosen parse-as override.
  useEffect(() => {
    if (sourceDialect) return;
    apiGetUnoverridden<{ dialect?: string }>('/config/parse')
      .then((d) => {
        if (d.dialect) setSourceDialect(d.dialect);
      })
      .catch(() => {
        /* parse may fail in worker mode without a bundle — silent. */
      });
  }, []);

  // Listen for picker changes so the live-convert swap reacts without reload.
  useEffect(() => {
    function onChange(e: Event): void {
      const ev = e as CustomEvent<{ id: string }>;
      setActiveDialect(ev.detail.id === 'auto' ? null : ev.detail.id);
    }
    window.addEventListener('dialectchange', onChange);
    return () => window.removeEventListener('dialectchange', onChange);
  }, []);

  const liveConvertActive =
    !!sourceDialect && !!activeDialect && activeDialect !== sourceDialect;

  // Fetch the multi-file conversion whenever the target differs from source.
  useEffect(() => {
    if (!liveConvertActive || !activeDialect) {
      setConvertResult(null);
      setConvertError(null);
      return;
    }
    setConverting(true);
    setConvertError(null);
    apiPost<{
      sourceDialect: string;
      targetDialect: string;
      files: { path: string; content: string }[];
      diagnostics: { severity: string; message: string; code?: string }[];
    }>('/convert', { target: activeDialect })
      .then((r) => {
        setConvertResult(r);
        setConvertError(null);
      })
      .catch((e: Error) => {
        // Recovery path: a failed conversion (e.g. unsupported target, parser
        // refusing the source as the picker dialect) must not leave the page
        // in a half-broken state where the tree disappears with no
        // explanation. We surface the message so the user can revert the
        // picker or pick a supported target.
        setConvertResult(null);
        setConvertError(e.message || 'Conversion failed for an unknown reason.');
      })
      .finally(() => setConverting(false));
  }, [liveConvertActive, activeDialect]);

  // Pick initial selected file from query string or first referenced file
  useEffect(() => {
    if (selected !== undefined) return;
    const q = readQuery();
    if (q.file) {
      setSelected(q.file);
      if (q.line) setHighlightLine(q.line);
    } else if (tree.data && tree.data.files.length > 0) {
      const ref = tree.data.files.find((f) => f.referenced) ?? tree.data.files[0];
      setSelected(ref.path);
    }
  }, [tree.data]);

  useEffect(() => {
    // Live-convert mode: pull file content from the in-memory convert result
    // instead of asking the server for the on-disk version. If the previously
    // selected path doesn't exist in the converted file set (stale selection
    // from before the dialect switch), snap to the first converted file so
    // the viewer always shows something coherent.
    if (convertResult && convertResult.files.length > 0) {
      const f = convertResult.files.find((x) => x.path === selected) ?? convertResult.files[0];
      setContent(f.content);
      if (f.path !== selected) setSelected(f.path);
      return;
    }
    if (!selected) return;
    apiGetText(`/config/file?path=${encodeURIComponent(selected)}`)
      .then(setContent)
      .catch(() => setContent('(failed to load file)'));
  }, [selected, convertResult]);

  // When the user reverts the picker back to source dialect (or 'auto'),
  // restore the original file selection so the viewer doesn't keep showing
  // a stale converted filename that doesn't exist on disk.
  useEffect(() => {
    if (liveConvertActive) return;
    if (!tree.data || tree.data.files.length === 0) return;
    if (selected && tree.data.files.some((f) => f.path === selected)) return;
    const ref = tree.data.files.find((f) => f.referenced) ?? tree.data.files[0];
    setSelected(ref.path);
  }, [liveConvertActive, tree.data]);

  // Scroll to highlight line
  useEffect(() => {
    if (!highlightLine) return;
    const el = document.getElementById(`line-${highlightLine}`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [highlightLine, content]);

  // Debounced search
  useEffect(() => {
    if (debounceRef.current !== undefined) window.clearTimeout(debounceRef.current);
    if (!searchInput.trim()) {
      setSearchQuery('');
      setSearchResult(null);
      return;
    }
    debounceRef.current = window.setTimeout(() => {
      setSearchQuery(searchInput.trim());
    }, 180);
    return () => {
      if (debounceRef.current !== undefined) window.clearTimeout(debounceRef.current);
    };
  }, [searchInput]);

  useEffect(() => {
    if (!searchQuery) {
      setSearchResult(null);
      return;
    }
    setSearchBusy(true);
    const params = new URLSearchParams({
      q: searchQuery,
      cs: searchCase ? '1' : '0',
      regex: searchRegex ? '1' : '0',
      limit: '500'
    });
    apiGet<SearchResult>(`/config/search?${params.toString()}`)
      .then((r) => setSearchResult(r))
      .catch(() => setSearchResult(null))
      .finally(() => setSearchBusy(false));
  }, [searchQuery, searchCase, searchRegex]);

  function jumpToMatch(m: SearchMatch) {
    setSelected(m.file);
    setHighlightLine(m.line);
    setHighlightTerm(searchQuery);
    setMobileTab('viewer');
    const url = new URL(window.location.href);
    url.searchParams.set('file', m.file);
    url.searchParams.set('line', String(m.line));
    history.replaceState(null, '', url.toString());
  }

  const matchesByFile = useMemo(() => {
    if (!searchResult) return new Map<string, SearchMatch[]>();
    const m = new Map<string, SearchMatch[]>();
    for (const x of searchResult.matches) {
      if (!m.has(x.file)) m.set(x.file, []);
      m.get(x.file)!.push(x);
    }
    return m;
  }, [searchResult]);

  const filteredDiags = useMemo(() => {
    if (!parse.data) return [];
    return parse.data.diagnostics.filter((d) => severityFilter.has(d.severity));
  }, [parse.data, severityFilter]);

  const diagsForFile = useMemo(() => {
    if (!parse.data || !selected) return [];
    return parse.data.diagnostics.filter((d) => d.source?.file === selected);
  }, [parse.data, selected]);

  return (
    <div>
      <SectionHeading
        title={t('page.config.title')}
        description={t('page.config.description')}
        actions={
          <div class="flex items-center gap-3">
            {parse.data && (
              <span class="text-sm text-fg-muted">
                <span class="font-semibold text-fg">{parse.data.summary.files}</span> files ·{' '}
                <span class="font-semibold text-fg">{parse.data.summary.rulesets}</span> rulesets ·{' '}
                <span class="font-semibold text-fg">{parse.data.summary.inputs}</span> inputs
              </span>
            )}
            <button
              class="btn-secondary text-xs"
              onClick={() => setConvertOpen(true)}
              title="Convert to another dialect"
            >
              Convert <IconArrowRight size={12} />
            </button>
          </div>
        }
      />
      {convertOpen && <ConvertDialog onClose={() => setConvertOpen(false)} />}

      {liveConvertActive && convertError && (
        <Card class="!p-3 mb-4 border-danger/40 bg-danger/5">
          <div class="flex items-start gap-3 text-sm">
            <Badge tone="error">convert failed</Badge>
            <div class="flex-1">
              <div class="text-danger">{convertError}</div>
              <div class="mt-1 text-xs text-fg-muted">
                Switch the dialect picker back to <code class="font-mono">auto</code> to return to
                the on-disk config, or pick a different target.
              </div>
            </div>
          </div>
        </Card>
      )}

      {liveConvertActive && !convertError && (
        <Card class="!p-3 mb-4 border-accent/40 bg-accent/5">
          <div class="flex items-start gap-3 text-sm">
            <Badge tone="accent">live preview</Badge>
            <div class="flex-1">
              <div>
                Showing the <span class="font-mono">{sourceDialect}</span> config converted to{' '}
                <span class="font-mono">{activeDialect}</span> on the fly.{' '}
                {converting && <span class="text-fg-muted">(converting…)</span>}
              </div>
              {convertResult && convertResult.diagnostics.length > 0 && (
                <div class="mt-1 text-xs text-fg-muted">
                  {convertResult.diagnostics.length} conversion note
                  {convertResult.diagnostics.length === 1 ? '' : 's'} — switch dialect back to{' '}
                  <code class="font-mono">auto</code> to return to the live config.
                </div>
              )}
            </div>
            {convertResult && (
              <span class="text-xs text-fg-subtle font-mono">
                {convertResult.files.length} file
                {convertResult.files.length === 1 ? '' : 's'}
              </span>
            )}
          </div>
        </Card>
      )}

      {/* Mobile-only tab strip — on lg+ all three panes show simultaneously. */}
      <div class="lg:hidden mb-3 flex items-center gap-1 bg-bg-subtle border border-border rounded-lg p-1 text-sm">
        {(['tree', 'viewer', 'diag'] as const).map((tab) => (
          <button
            key={tab}
            class={`flex-1 px-2 py-1.5 rounded-md transition-colors ${
              mobileTab === tab
                ? 'bg-bg-elev text-fg shadow-sm'
                : 'text-fg-muted hover:text-fg'
            }`}
            onClick={() => setMobileTab(tab)}
          >
            {tab === 'tree' ? 'Files' : tab === 'viewer' ? 'View' : `Diag${filteredDiags.length ? ` (${filteredDiags.length})` : ''}`}
          </button>
        ))}
      </div>

      <div class="grid grid-cols-1 lg:grid-cols-12 gap-4">
        {/* Tree + search */}
        <Card class={`lg:col-span-3 !p-0 overflow-hidden flex flex-col ${mobileTab === 'tree' ? '' : 'hidden lg:flex'}`}>
          <div class="p-2 border-b border-border space-y-1.5">
            <div class="relative">
              <IconSearch
                size={14}
                class="absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-subtle"
              />
              <input
                class="input pl-8 pr-7 text-sm"
                placeholder="Search IPs, hosts, rulesets…"
                value={searchInput}
                onInput={(e) => setSearchInput((e.target as HTMLInputElement).value)}
              />
              {searchInput && (
                <button
                  class="absolute right-1.5 top-1/2 -translate-y-1/2 text-fg-subtle hover:text-fg p-1"
                  onClick={() => setSearchInput('')}
                  title="Clear"
                  aria-label="Clear search"
                >
                  <IconX size={12} />
                </button>
              )}
            </div>
            <div class="flex items-center gap-1 text-[10px]">
              <button
                class={`px-1.5 py-0.5 rounded border ${
                  searchCase
                    ? 'border-accent text-accent bg-accent/10'
                    : 'border-border text-fg-subtle hover:text-fg'
                }`}
                onClick={() => setSearchCase((v) => !v)}
                title="Case-sensitive"
              >
                Aa
              </button>
              <button
                class={`px-1.5 py-0.5 rounded border ${
                  searchRegex
                    ? 'border-accent text-accent bg-accent/10'
                    : 'border-border text-fg-subtle hover:text-fg'
                }`}
                onClick={() => setSearchRegex((v) => !v)}
                title="Regex"
              >
                .*
              </button>
              {searchResult && (
                <span class="ml-auto text-fg-subtle">
                  {searchBusy
                    ? '…'
                    : `${searchResult.total}${searchResult.truncated ? '+' : ''} match${
                        searchResult.total === 1 ? '' : 'es'
                      }`}
                </span>
              )}
            </div>
          </div>

          <div class="flex-1 overflow-auto max-h-[70vh]">
            {searchResult ? (
              <SearchResultsPanel
                result={searchResult}
                matchesByFile={matchesByFile}
                onJump={jumpToMatch}
                selectedFile={selected}
                selectedLine={highlightLine}
              />
            ) : convertResult ? (
              <div class="p-2">
                <FileTree
                  files={convertResult.files.map((f) => ({
                    path: f.path,
                    size: f.content.length,
                    referenced: true
                  }))}
                  selected={selected}
                  onSelect={(p) => {
                    setSelected(p);
                    setHighlightLine(undefined);
                    setHighlightTerm('');
                    setMobileTab('viewer');
                  }}
                />
              </div>
            ) : tree.data ? (
              <div class="p-2">
                <FileTree
                  files={tree.data.files}
                  selected={selected}
                  onSelect={(p) => {
                    setSelected(p);
                    setHighlightLine(undefined);
                    setHighlightTerm('');
                    setMobileTab('viewer');
                    const url = new URL(window.location.href);
                    url.searchParams.set('file', p);
                    url.searchParams.delete('line');
                    history.replaceState(null, '', url.toString());
                  }}
                />
              </div>
            ) : (
              <div class="text-sm text-fg-muted p-3">Loading…</div>
            )}
          </div>
        </Card>

        {/* File viewer */}
        <Card class={`lg:col-span-6 !p-0 overflow-hidden ${mobileTab === 'viewer' ? '' : 'hidden lg:block'}`}>
          <div class="px-4 py-2 border-b border-border flex items-center justify-between">
            <code class="text-xs">{selected ?? '—'}</code>
            {diagsForFile.length > 0 && (
              <Badge tone="warn">
                {diagsForFile.length} diagnostic{diagsForFile.length === 1 ? '' : 's'} in this file
              </Badge>
            )}
          </div>
          <div class="font-mono text-xs overflow-auto max-h-[70vh]">
            {selected ? (
              selected.endsWith('.json') && looksLikeLookupTable(content) ? (
                <LookupTableView content={content} />
              ) : (
                <CodeView
                  content={content}
                  diagnostics={diagsForFile}
                  highlight={highlightLine}
                  highlightTerm={highlightTerm}
                />
              )
            ) : (
              <EmptyState title="Select a file" />
            )}
          </div>
        </Card>

        {/* Diagnostics */}
        <Card class={`lg:col-span-3 !p-0 overflow-hidden ${mobileTab === 'diag' ? '' : 'hidden lg:block'}`}>
          <div class="px-3 py-2 border-b border-border flex items-center justify-between">
            <div class="text-xs uppercase tracking-wider text-fg-subtle">Diagnostics</div>
            <div class="flex items-center gap-1">
              {(['error', 'warning', 'info'] as const).map((s) => (
                <button
                  class={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border ${
                    severityFilter.has(s)
                      ? s === 'error'
                        ? 'border-danger text-danger'
                        : s === 'warning'
                        ? 'border-warn text-warn'
                        : 'border-accent text-accent'
                      : 'border-border text-fg-subtle'
                  }`}
                  onClick={() => {
                    const next = new Set(severityFilter);
                    if (next.has(s)) next.delete(s);
                    else next.add(s);
                    setSeverityFilter(next);
                  }}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
          <div class="p-2 overflow-auto max-h-[70vh] space-y-1">
            {filteredDiags.length === 0 && (
              <div class="text-sm text-fg-muted p-2">No diagnostics.</div>
            )}
            {filteredDiags.map((d) => (
              <button
                class={`block w-full text-left rounded p-2 hover:bg-bg-subtle transition-colors ${
                  selected === d.source?.file && highlightLine === d.source?.line
                    ? 'bg-bg-subtle'
                    : ''
                }`}
                onClick={() => {
                  if (d.source?.file) {
                    setSelected(d.source.file);
                    setHighlightLine(d.source.line);
                    setMobileTab('viewer');
                  }
                }}
              >
                <div class="flex items-center gap-2">
                  <Badge tone={d.severity === 'error' ? 'error' : d.severity === 'warning' ? 'warn' : 'accent'}>
                    {d.severity}
                  </Badge>
                  {d.code && <span class="text-[10px] font-mono text-fg-subtle">{d.code}</span>}
                </div>
                <div class="text-xs mt-1 text-fg">{d.message}</div>
                {d.source && (
                  <div class="text-[10px] text-fg-subtle mt-1 font-mono">
                    {d.source.file}:{d.source.line}
                  </div>
                )}
              </button>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}

function FileTree({
  files,
  selected,
  onSelect
}: {
  files: Tree['files'];
  selected?: string;
  onSelect: (p: string) => void;
}) {
  // Group by directory
  const byDir = new Map<string, Tree['files']>();
  for (const f of files) {
    const parts = f.path.split('/');
    const dir = parts.length > 1 ? parts.slice(0, -1).join('/') : '';
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir)!.push(f);
  }
  const dirs = [...byDir.keys()].sort();
  return (
    <div class="text-sm">
      {dirs.map((d) => (
        <div class="mb-1">
          {d && (
            <div class="flex items-center gap-1.5 px-1 py-1 text-xs text-fg-muted">
              <IconFolder size={14} />
              <span class="font-mono">{d}/</span>
            </div>
          )}
          {byDir.get(d)!.map((f) => {
            const name = f.path.slice(d ? d.length + 1 : 0);
            const isSel = selected === f.path;
            return (
              <button
                class={`flex items-center gap-1.5 w-full text-left px-1 py-1 rounded text-xs ${
                  isSel ? 'bg-accent/10 text-accent' : 'hover:bg-bg-subtle text-fg'
                } ${d ? 'pl-5' : ''}`}
                onClick={() => onSelect(f.path)}
              >
                <IconFile size={13} />
                <span class="font-mono truncate flex-1">{name}</span>
                {!f.referenced && <span class="text-[10px] text-fg-subtle">unref</span>}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function highlightMatches(line: string, term: string, isRegex: boolean): preact.JSX.Element[] {
  if (!term) return [<>{line}</>];
  let re: RegExp;
  try {
    re = new RegExp(isRegex ? term : term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  } catch {
    return [<>{line}</>];
  }
  const out: preact.JSX.Element[] = [];
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    if (m[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    if (m.index > lastIndex) out.push(<>{line.slice(lastIndex, m.index)}</>);
    out.push(
      <mark class="bg-accent/30 text-fg rounded-sm px-0.5">{line.slice(m.index, m.index + m[0].length)}</mark>
    );
    lastIndex = m.index + m[0].length;
  }
  if (lastIndex < line.length) out.push(<>{line.slice(lastIndex)}</>);
  return out;
}

function SearchResultsPanel({
  result,
  matchesByFile,
  onJump,
  selectedFile,
  selectedLine
}: {
  result: SearchResult;
  matchesByFile: Map<string, SearchMatch[]>;
  onJump: (m: SearchMatch) => void;
  selectedFile?: string;
  selectedLine?: number;
}) {
  if (result.total === 0) {
    return (
      <div class="p-3 text-sm text-fg-muted">
        No matches for <code class="text-fg">{result.query}</code>.
      </div>
    );
  }
  const files = [...matchesByFile.keys()];
  return (
    <div class="p-1 text-xs">
      {files.map((f) => {
        const list = matchesByFile.get(f)!;
        return (
          <div class="mb-1">
            <div class="px-2 py-1 text-fg-muted flex items-center gap-1.5">
              <IconFile size={11} />
              <span class="font-mono truncate flex-1">{f}</span>
              <span class="chip">{list.length}</span>
            </div>
            <div>
              {list.map((m) => {
                const isSel = selectedFile === m.file && selectedLine === m.line;
                return (
                  <button
                    class={`w-full text-left rounded px-2 py-1 flex gap-2 items-baseline ${
                      isSel ? 'bg-accent/10 text-accent' : 'hover:bg-bg-subtle'
                    }`}
                    onClick={() => onJump(m)}
                  >
                    <span class="text-fg-subtle tabular-nums w-10 text-right">{m.line}</span>
                    <span class="font-mono truncate flex-1 text-fg">
                      {highlightMatches(
                        m.snippet.length > 120 ? m.snippet.slice(0, 120) + '…' : m.snippet,
                        result.query,
                        result.regex
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
      {result.truncated && (
        <div class="p-2 text-fg-subtle italic">
          More than {result.total} matches — refine the query to see the rest.
        </div>
      )}
    </div>
  );
}

function CodeView({
  content,
  diagnostics,
  highlight,
  highlightTerm = ''
}: {
  content: string;
  diagnostics: { source: any; severity: string; message: string }[];
  highlight?: number;
  highlightTerm?: string;
}) {
  const diagsByLine = new Map<number, { severity: string; message: string }[]>();
  for (const d of diagnostics) {
    const ln = d.source?.line as number | undefined;
    if (!ln) continue;
    if (!diagsByLine.has(ln)) diagsByLine.set(ln, []);
    diagsByLine.get(ln)!.push(d);
  }
  const lines = content.split(/\r?\n/);
  return (
    <div class="min-w-full">
      {lines.map((ln, i) => {
        const lineNo = i + 1;
        const ds = diagsByLine.get(lineNo);
        const isHighlight = highlight === lineNo;
        return (
          <div
            id={`line-${lineNo}`}
            class={`flex group ${isHighlight ? 'bg-accent/10' : ''}`}
          >
            <span class="select-none w-12 text-right pr-3 text-fg-subtle border-r border-border">
              {lineNo}
            </span>
            <span class="pl-3 whitespace-pre flex-1 group-hover:bg-bg-subtle/40">
              {highlightTerm ? highlightMatches(ln || ' ', highlightTerm, false) : ln || ' '}
              {ds && ds.length > 0 && (
                <span class="ml-3 inline-flex items-center gap-1">
                  {ds.map((d) => (
                    <span
                      class={`text-[10px] px-1 rounded border ${
                        d.severity === 'error'
                          ? 'border-danger text-danger'
                          : d.severity === 'warning'
                          ? 'border-warn text-warn'
                          : 'border-accent text-accent'
                      }`}
                      title={d.message}
                    >
                      {d.message.length > 60 ? d.message.slice(0, 60) + '…' : d.message}
                    </span>
                  ))}
                </span>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Lookup-table view — when a .json file in the tree looks like a lookup
// table (plain object, array-of-entries, or rsyslog native format), render
// it as a searchable key→value table rather than raw JSON.
// ---------------------------------------------------------------------------

function looksLikeLookupTable(content: string): boolean {
  // Cheap shape sniff: a JSON document whose first non-whitespace char is
  // `{` or `[` is candidate. We avoid full-parse here because the file
  // may be larger than we want to round-trip every keystroke.
  const trimmed = content.trimStart();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}

function LookupTableView({ content }: { content: string }) {
  const entries = useMemo(() => extractLookupEntries(content), [content]);
  const [filter, setFilter] = useState("");
  if (!entries) {
    return (
      <div class="p-4 text-fg-muted">
        Could not parse this JSON as a lookup table — falling back to raw view via the
        Convert/Migrate flow would be needed for editing. Switch the dialect picker to
        force a re-render.
      </div>
    );
  }
  const f = filter.trim().toLowerCase();
  const filtered = f
    ? entries.filter((e) => e.key.toLowerCase().includes(f) || e.value.toLowerCase().includes(f))
    : entries;
  return (
    <div class="p-3">
      <div class="flex items-center justify-between gap-2 mb-2 text-xs">
        <span class="text-fg-muted">
          {entries.length} entries{entries.length > 0 && entries[0].kind === "rsyslog" ? " · rsyslog-native format" : ""}
        </span>
        <input
          class="input !py-1 !text-xs !w-48"
          placeholder="Filter key or value…"
          value={filter}
          onInput={(e) => setFilter((e.target as HTMLInputElement).value)}
        />
      </div>
      <div class="overflow-auto">
        <table class="w-full text-xs">
          <thead>
            <tr class="text-[10px] uppercase tracking-wider text-fg-subtle">
              <th class="text-left py-1 px-2 border-b border-border">key</th>
              <th class="text-left py-1 px-2 border-b border-border">value</th>
            </tr>
          </thead>
          <tbody>
            {filtered.slice(0, 500).map((e) => (
              <tr class="border-b border-border/40 hover:bg-bg-subtle">
                <td class="py-1 px-2 font-mono">{e.key}</td>
                <td class="py-1 px-2 font-mono text-fg-muted">{e.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {filtered.length > 500 && (
          <div class="text-fg-subtle text-xs mt-2">
            Showing first 500 of {filtered.length} matches.
          </div>
        )}
      </div>
    </div>
  );
}

interface LookupEntry { key: string; value: string; kind: "object" | "array" | "rsyslog" }

function extractLookupEntries(content: string): LookupEntry[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  // rsyslog-native format: { version, type, nomatch, table: [{index, value}, …] }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    if (Array.isArray(obj.table)) {
      return (obj.table as Record<string, unknown>[])
        .filter((row) => row && typeof row === "object")
        .map((row) => ({
          key: String((row as Record<string, unknown>).index ?? ""),
          value: String((row as Record<string, unknown>).value ?? ""),
          kind: "rsyslog" as const
        }));
    }
    // Plain object map: { key: value, … }
    return Object.entries(obj).map(([k, v]) => ({
      key: k,
      value: typeof v === "string" ? v : JSON.stringify(v),
      kind: "object" as const
    }));
  }
  // Array of {key, value} entries
  if (Array.isArray(parsed)) {
    return (parsed as Record<string, unknown>[])
      .filter((row) => row && typeof row === "object")
      .map((row) => ({
        key: String(row.key ?? row.index ?? ""),
        value: String(row.value ?? ""),
        kind: "array" as const
      }));
  }
  return null;
}
