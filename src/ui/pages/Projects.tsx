import { useEffect, useRef, useState } from 'preact/hooks';
import { useT } from '../i18n/index.js';
import { apiGet } from '../lib/api';
import { getMode, setMode } from '../components/ModeToggle';
import { getWorker } from '../lib/worker-client';
import { Card, SectionHeading, Badge, EmptyState } from '../components/UI';
import { IconBolt, IconFile, IconFolder, IconArrowRight } from '../components/Icons';

/**
 * Projects page — manage the local-mode bundle(s) the worker uses.
 *
 * Four ways to seed a project:
 *
 *   1. Clone the live server config.
 *   2. Upload a folder (browser directory picker, recursive).
 *   3. Upload individual files.
 *   4. Upload a .zip archive — unpacked in-browser via fflate.
 *
 * Drag-and-drop is bound on the page-level container so the user can drop
 * any of the above anywhere on the page, not just on a specific card.
 *
 * After files arrive, the UI parks them in a "pending review" state. The
 * review card runs `detectDialect()` against the file contents, lets the
 * user rename the project, override the dialect, and inspect entrypoint +
 * size before committing. This avoids the previous flow's three-prompt
 * cascade (name → dialect-guess-was-wrong → reload).
 *
 * Projects persist in `localStorage` under `logflow.projects`. The browser
 * cap is ~5 MB total across the origin, so we warn at 4 MB. Bigger
 * bundles belong in a mounted server volume.
 */

interface ProjectBundle {
  name: string;
  entrypoint: string;
  dialect?: string;
  files: { path: string; content: string }[];
  savedAt: number;
  size: number;
}

interface PendingImport {
  files: { path: string; content: string }[];
  suggestedName: string;
  detectedDialect: string | null;
  detectedConfidence: number;
  selectedDialect: string;
  entrypoint: string;
  size: number;
}

const STORAGE_KEY = 'logflow.projects';
const SIZE_WARN_BYTES = 4 * 1024 * 1024;
const CONFIG_EXTENSIONS = ['.conf', '.json', '.yaml', '.yml', '.toml'];

function loadProjects(): ProjectBundle[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveProjects(list: ProjectBundle[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
}

function looksLikeConfigFile(path: string): boolean {
  const lower = path.toLowerCase();
  return CONFIG_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function commonPrefix(paths: string[]): string {
  if (paths.length < 2) return '';
  const segments = paths.map((p) => p.split('/'));
  const first = segments[0];
  let prefix = '';
  for (let i = 0; i < first.length - 1; i++) {
    const seg = first[i];
    if (segments.every((s) => s[i] === seg)) prefix += seg + '/';
    else break;
  }
  return prefix;
}

function pickEntrypoint(files: { path: string; content: string }[]): string {
  return (
    files.find((e) => e.path === 'rsyslog.conf')?.path ??
    files.find((e) => e.path === 'fluent-bit.conf')?.path ??
    files.find((e) => e.path === 'syslog-ng.conf')?.path ??
    files.find((e) => e.path === 'vector.toml' || e.path === 'vector.yaml')?.path ??
    files.find((e) => !e.path.includes('/') && e.path.endsWith('.conf'))?.path ??
    files.find((e) => !e.path.includes('/'))?.path ??
    files[0]?.path ??
    'rsyslog.conf'
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

async function entriesFromFileList(files: FileList): Promise<{ path: string; content: string }[]> {
  const entries: { path: string; content: string }[] = [];
  for (const file of Array.from(files)) {
    const rel =
      (file as File & { webkitRelativePath?: string }).webkitRelativePath ?? file.name;
    if (!looksLikeConfigFile(rel)) continue;
    entries.push({ path: rel, content: await file.text() });
  }
  const common = commonPrefix(entries.map((e) => e.path));
  return entries.map((e) => ({
    path: common ? e.path.slice(common.length) : e.path,
    content: e.content
  }));
}

async function entriesFromZip(file: File): Promise<{ path: string; content: string }[]> {
  // fflate is lazy-loaded so users who never touch a ZIP — the majority —
  // don't pay the ~8 KB gzipped cost in the main bundle.
  const { unzipSync, strFromU8 } = await import('fflate');
  const buf = new Uint8Array(await file.arrayBuffer());
  const unpacked = unzipSync(buf, {
    filter: (f) => !f.name.endsWith('/') && looksLikeConfigFile(f.name)
  });
  const entries = Object.entries(unpacked).map(([path, data]) => ({
    path,
    content: strFromU8(data)
  }));
  const common = commonPrefix(entries.map((e) => e.path));
  return entries.map((e) => ({
    path: common ? e.path.slice(common.length) : e.path,
    content: e.content
  }));
}

async function entriesFromDataTransfer(
  dt: DataTransfer
): Promise<{ path: string; content: string }[]> {
  // Prefer webkitGetAsEntry to descend dropped folders. Fall back to
  // dt.files when entries API is unavailable (older Safari).
  const items = Array.from(dt.items ?? []);
  if (items.length > 0 && typeof items[0].webkitGetAsEntry === 'function') {
    const collected: { path: string; content: string }[] = [];
    for (const item of items) {
      const entry = item.webkitGetAsEntry();
      if (entry) await walkEntry(entry, '', collected);
    }
    // If the user dropped a single .zip, expand it.
    if (collected.length === 0 && dt.files.length === 1 && dt.files[0].name.endsWith('.zip')) {
      return entriesFromZip(dt.files[0]);
    }
    const common = commonPrefix(collected.map((e) => e.path));
    return collected.map((e) => ({
      path: common ? e.path.slice(common.length) : e.path,
      content: e.content
    }));
  }
  if (dt.files.length === 1 && dt.files[0].name.endsWith('.zip')) {
    return entriesFromZip(dt.files[0]);
  }
  return entriesFromFileList(dt.files);
}

// Recursively walk a `FileSystemEntry` produced by webkitGetAsEntry. The
// API is callback-based, so we wrap each leaf-read in a Promise.
async function walkEntry(
  entry: FileSystemEntry,
  prefix: string,
  out: { path: string; content: string }[]
): Promise<void> {
  if (entry.isFile) {
    const fileEntry = entry as FileSystemFileEntry;
    const file = await new Promise<File>((resolve, reject) =>
      fileEntry.file(resolve, reject)
    );
    const path = prefix + file.name;
    if (!looksLikeConfigFile(path)) return;
    out.push({ path, content: await file.text() });
    return;
  }
  if (entry.isDirectory) {
    const dirEntry = entry as FileSystemDirectoryEntry;
    const reader = dirEntry.createReader();
    // readEntries returns at most ~100 per call; loop until empty.
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
        reader.readEntries(resolve, reject)
      );
      if (batch.length === 0) break;
      for (const child of batch) {
        await walkEntry(child, prefix + entry.name + '/', out);
      }
    }
  }
}

async function loadBundleIntoWorker(bundle: ProjectBundle): Promise<void> {
  const filesMap: Record<string, string> = {};
  for (const f of bundle.files) {
    filesMap[f.path.startsWith('/') ? f.path : '/' + f.path] = f.content;
  }
  await getWorker().loadBundle(filesMap, bundle.entrypoint, bundle.dialect ?? 'rsyslog');
  setMode('local');
}

async function downloadProjectZip(p: ProjectBundle): Promise<void> {
  const { zipSync, strToU8 } = await import('fflate');
  const tree: Record<string, Uint8Array> = {};
  for (const f of p.files) {
    const path = f.path.replace(/^\/+/, '');
    tree[path] = strToU8(f.content);
  }
  const zipped = zipSync(tree, { level: 6 });
  // Wrap in a fresh ArrayBuffer to avoid passing a SharedArrayBuffer-typed
  // view to Blob (TS lib defaults are conservative on this).
  const ab = new ArrayBuffer(zipped.byteLength);
  new Uint8Array(ab).set(zipped);
  const blob = new Blob([ab], { type: 'application/zip' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${p.name}.zip`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function ProjectsPage() {
  const { t } = useT();
  const [mode, setLocalMode] = useState(getMode());
  const [projects, setProjects] = useState<ProjectBundle[]>(loadProjects);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingImport | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [dialects, setDialects] = useState<{ id: string; displayName: string }[]>([]);
  const dragCounter = useRef(0);

  useEffect(() => {
    function onMode(e: Event): void {
      setLocalMode((e as CustomEvent<{ mode: 'server' | 'local' }>).detail.mode);
    }
    window.addEventListener('modechange', onMode);
    return () => window.removeEventListener('modechange', onMode);
  }, []);

  useEffect(() => {
    void getWorker()
      .listDialects()
      .then((r) => setDialects(r.dialects))
      .catch(() => {
        /* dialect dropdown will fall back to a single hardcoded option */
      });
  }, []);

  async function stageEntries(
    entries: { path: string; content: string }[],
    suggestedName: string
  ): Promise<void> {
    if (entries.length === 0) {
      setError(t('projects.review.empty'));
      return;
    }
    const samples = entries.slice(0, 10);
    let detected: string | null = null;
    let confidence = 0;
    try {
      const r = await getWorker().detectDialect(samples);
      if ('displayName' in r && r.dialect) {
        detected = r.dialect;
        confidence = r.confidence;
      }
    } catch {
      /* detection is best-effort; user can pick manually */
    }
    const entrypoint = pickEntrypoint(entries);
    setPending({
      files: entries,
      suggestedName,
      detectedDialect: detected,
      detectedConfidence: confidence,
      selectedDialect: detected ?? 'rsyslog',
      entrypoint,
      size: entries.reduce((a, e) => a + e.content.length, 0)
    });
    setError(null);
    setInfo(null);
  }

  async function commitPending(name: string, dialect: string, entrypoint: string): Promise<void> {
    if (!pending) return;
    setBusy(true);
    try {
      const bundle: ProjectBundle = {
        name,
        entrypoint: '/' + entrypoint.replace(/^\/+/, ''),
        dialect,
        files: pending.files,
        savedAt: Date.now(),
        size: pending.size
      };
      const next = [bundle, ...projects.filter((p) => p.name !== name)];
      saveProjects(next);
      setProjects(next);
      await loadBundleIntoWorker(bundle);
      setPending(null);
      setInfo(t('projects.uploadOk', { count: String(bundle.files.length), name }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function cloneLive(): Promise<void> {
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      const bundle = await apiGet<{
        dialect: string;
        entrypoint: string;
        files: Record<string, string>;
      }>('/config/bundle');
      const projectName = window.prompt(
        t('projects.cloneNamePrompt'),
        `live-${new Date().toISOString().slice(0, 10)}`
      );
      if (!projectName) return;
      const entries = Object.entries(bundle.files).map(([path, content]) => ({
        path: path.replace(/^\/+/, ''),
        content
      }));
      const project: ProjectBundle = {
        name: projectName,
        entrypoint: bundle.entrypoint,
        dialect: bundle.dialect,
        files: entries,
        savedAt: Date.now(),
        size: entries.reduce((a, e) => a + e.content.length, 0)
      };
      const next = [project, ...projects.filter((p) => p.name !== projectName)];
      saveProjects(next);
      setProjects(next);
      await loadBundleIntoWorker(project);
      setInfo(t('projects.cloneOk', { name: projectName }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function onFolderInput(ev: Event): Promise<void> {
    const input = ev.target as HTMLInputElement;
    if (!input.files || input.files.length === 0) return;
    try {
      const entries = await entriesFromFileList(input.files);
      await stageEntries(entries, `folder-${new Date().toISOString().slice(0, 10)}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      input.value = '';
    }
  }

  async function onFilesInput(ev: Event): Promise<void> {
    const input = ev.target as HTMLInputElement;
    if (!input.files || input.files.length === 0) return;
    try {
      const entries = await entriesFromFileList(input.files);
      await stageEntries(entries, `files-${new Date().toISOString().slice(0, 10)}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      input.value = '';
    }
  }

  async function onZipInput(ev: Event): Promise<void> {
    const input = ev.target as HTMLInputElement;
    if (!input.files || input.files.length === 0) return;
    const f = input.files[0];
    try {
      const entries = await entriesFromZip(f);
      await stageEntries(entries, f.name.replace(/\.zip$/i, ''));
    } catch (e) {
      setError(t('projects.zip.unpackError', { message: (e as Error).message }));
    } finally {
      input.value = '';
    }
  }

  // Page-wide drag-and-drop. The counter trick is the standard browser
  // workaround for the dragenter/dragleave bubble noise that fires on
  // every child element transition.
  function onDragEnter(ev: DragEvent): void {
    ev.preventDefault();
    dragCounter.current += 1;
    if (ev.dataTransfer && Array.from(ev.dataTransfer.types).includes('Files')) {
      setDragActive(true);
    }
  }
  function onDragLeave(ev: DragEvent): void {
    ev.preventDefault();
    dragCounter.current = Math.max(0, dragCounter.current - 1);
    if (dragCounter.current === 0) setDragActive(false);
  }
  function onDragOver(ev: DragEvent): void {
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'copy';
  }
  async function onDrop(ev: DragEvent): Promise<void> {
    ev.preventDefault();
    dragCounter.current = 0;
    setDragActive(false);
    if (!ev.dataTransfer) return;
    try {
      const entries = await entriesFromDataTransfer(ev.dataTransfer);
      const seed =
        ev.dataTransfer.files[0]?.name?.replace(/\.zip$/i, '') ??
        `drop-${new Date().toISOString().slice(0, 10)}`;
      await stageEntries(entries, seed);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function useProject(p: ProjectBundle): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await loadBundleIntoWorker(p);
      setInfo(t('projects.activated', { name: p.name }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function deleteProject(name: string): void {
    if (!window.confirm(t('projects.deletePrompt', { name }))) return;
    const next = projects.filter((p) => p.name !== name);
    saveProjects(next);
    setProjects(next);
  }

  function renameProject(p: ProjectBundle): void {
    const newName = window.prompt(t('projects.saved.renamePrompt', { name: p.name }), p.name);
    if (!newName || newName === p.name) return;
    const next = projects.map((x) =>
      x.name === p.name ? { ...x, name: newName, savedAt: Date.now() } : x
    );
    saveProjects(next);
    setProjects(next);
  }

  async function exportProject(p: ProjectBundle): Promise<void> {
    if (p.files.length === 0) {
      setError(t('projects.export.empty'));
      return;
    }
    try {
      await downloadProjectZip(p);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
      class="relative"
    >
      {dragActive && (
        <div class="fixed inset-0 z-40 pointer-events-none border-4 border-dashed border-accent bg-accent/10 flex items-center justify-center">
          <div class="bg-bg/90 backdrop-blur px-6 py-3 rounded-lg border border-accent text-accent font-semibold">
            {t('projects.dropzone.active')}
          </div>
        </div>
      )}

      <SectionHeading
        title={t('page.projects.title')}
        description={t('page.projects.description')}
      />

      {(error || info) && (
        <div class="mb-4 space-y-2">
          {error && (
            <Card class="border-danger/40 bg-danger/5 text-sm text-danger">{error}</Card>
          )}
          {info && <Card class="border-ok/40 bg-ok/5 text-sm text-ok">{info}</Card>}
        </div>
      )}

      {pending && (
        <ReviewCard
          pending={pending}
          dialects={dialects}
          busy={busy}
          onCancel={() => setPending(null)}
          onSave={(name, dialect, entrypoint) => void commitPending(name, dialect, entrypoint)}
        />
      )}

      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <div class="flex items-center justify-between mb-3">
            <div class="font-semibold">{t('projects.cloneLive.title')}</div>
            {mode === 'server' ? (
              <Badge tone="accent">{t('projects.mode.server')}</Badge>
            ) : (
              <Badge>{t('projects.mode.local')}</Badge>
            )}
          </div>
          <p class="text-sm text-fg-muted mb-4">{t('projects.cloneLive.description')}</p>
          <button class="btn-primary w-full" onClick={cloneLive} disabled={busy}>
            <IconBolt size={14} /> {t('projects.cloneLive.button')}
          </button>
        </Card>

        <Card>
          <div class="flex items-center justify-between mb-3">
            <div class="font-semibold">{t('projects.uploadFolder.title')}</div>
            <Badge>{t('projects.uploadFolder.badge')}</Badge>
          </div>
          <p class="text-sm text-fg-muted mb-4">{t('projects.uploadFolder.description')}</p>
          <label class="btn-secondary w-full cursor-pointer">
            <IconFolder size={14} /> {t('projects.uploadFolder.button')}
            <input
              type="file"
              class="hidden"
              {...({ webkitdirectory: '', directory: '' } as Record<string, unknown>)}
              multiple
              onChange={(e) => void onFolderInput(e)}
            />
          </label>
        </Card>

        <Card>
          <div class="flex items-center justify-between mb-3">
            <div class="font-semibold">{t('projects.uploadFiles.title')}</div>
            <Badge>{t('projects.uploadFiles.badge')}</Badge>
          </div>
          <p class="text-sm text-fg-muted mb-4">{t('projects.uploadFiles.description')}</p>
          <label class="btn-secondary w-full cursor-pointer">
            <IconFile size={14} /> {t('projects.uploadFiles.button')}
            <input
              type="file"
              class="hidden"
              multiple
              accept=".conf,.json,.yaml,.yml,.toml"
              onChange={(e) => void onFilesInput(e)}
            />
          </label>
        </Card>

        <Card>
          <div class="flex items-center justify-between mb-3">
            <div class="font-semibold">{t('projects.uploadZip.title')}</div>
            <Badge>{t('projects.uploadZip.badge')}</Badge>
          </div>
          <p class="text-sm text-fg-muted mb-4">{t('projects.uploadZip.description')}</p>
          <label class="btn-secondary w-full cursor-pointer">
            <IconFile size={14} /> {t('projects.uploadZip.button')}
            <input
              type="file"
              class="hidden"
              accept=".zip,application/zip"
              onChange={(e) => void onZipInput(e)}
            />
          </label>
        </Card>
      </div>

      <p class="mt-3 text-xs text-fg-subtle text-center hidden [@media(hover:hover)]:block">
        {t('projects.dropzone.hint')}
      </p>

      <div class="mt-8">
        <div class="flex items-baseline justify-between mb-4">
          <h2 class="text-xl font-semibold tracking-tight">{t('projects.saved.title')}</h2>
          <span class="text-xs text-fg-subtle">
            {t('projects.saved.count', { n: String(projects.length) })}
          </span>
        </div>

        {projects.length === 0 ? (
          <EmptyState
            title={t('projects.saved.emptyTitle')}
            description={t('projects.saved.emptyDescription')}
          />
        ) : (
          <div class="space-y-2">
            {projects.map((p) => (
              <Card class="flex flex-col sm:flex-row sm:items-center gap-3 !p-3">
                <div class="flex-1 min-w-0">
                  <div class="font-mono text-sm truncate flex items-center gap-2">
                    {p.name}
                    {p.dialect && <Badge>{p.dialect}</Badge>}
                  </div>
                  <div class="text-[11px] text-fg-subtle mt-0.5 break-words">
                    {p.files.length} {t('projects.saved.files')} · {formatSize(p.size)} ·{' '}
                    {new Date(p.savedAt).toLocaleString()} · {t('projects.saved.entrypoint')}{' '}
                    <span class="font-mono text-fg-muted break-all">{p.entrypoint}</span>
                  </div>
                </div>
                <div class="flex flex-wrap items-center gap-2 sm:shrink-0">
                  <button
                    class="btn-secondary text-xs flex-1 sm:flex-none justify-center"
                    onClick={() => void useProject(p)}
                    disabled={busy}
                  >
                    <IconArrowRight size={12} /> {t('projects.saved.use')}
                  </button>
                  <button
                    class="btn-ghost text-xs flex-1 sm:flex-none justify-center"
                    onClick={() => void exportProject(p)}
                  >
                    {t('projects.saved.export')}
                  </button>
                  <button
                    class="btn-ghost text-xs flex-1 sm:flex-none justify-center"
                    onClick={() => renameProject(p)}
                  >
                    {t('projects.saved.rename')}
                  </button>
                  <button
                    class="btn-ghost text-xs text-danger hover:bg-danger/10 flex-1 sm:flex-none justify-center"
                    onClick={() => deleteProject(p.name)}
                  >
                    {t('common.delete')}
                  </button>
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

interface ReviewCardProps {
  pending: PendingImport;
  dialects: { id: string; displayName: string }[];
  busy: boolean;
  onCancel: () => void;
  onSave: (name: string, dialect: string, entrypoint: string) => void;
}

function ReviewCard({ pending, dialects, busy, onCancel, onSave }: ReviewCardProps) {
  const { t } = useT();
  const [name, setName] = useState(pending.suggestedName);
  const [dialect, setDialect] = useState(pending.selectedDialect);
  const [entrypoint, setEntrypoint] = useState(pending.entrypoint);
  const sizeStr = formatSize(pending.size);
  const oversized = pending.size > SIZE_WARN_BYTES;
  const dialectOptions =
    dialects.length > 0 ? dialects : [{ id: 'rsyslog', displayName: 'rsyslog' }];

  return (
    <Card class="mb-6 border-accent/40 bg-accent/5">
      <div class="font-semibold mb-3">{t('projects.review.title')}</div>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
        <label class="text-sm">
          <div class="text-fg-muted mb-1">{t('projects.review.name')}</div>
          <input
            class="input w-full"
            value={name}
            onInput={(e) => setName((e.target as HTMLInputElement).value)}
          />
        </label>
        <label class="text-sm">
          <div class="text-fg-muted mb-1">{t('projects.review.dialect')}</div>
          <select
            class="input w-full"
            value={dialect}
            onChange={(e) => setDialect((e.target as HTMLSelectElement).value)}
          >
            {dialectOptions.map((d) => (
              <option value={d.id}>{d.displayName}</option>
            ))}
          </select>
          <div class="text-[11px] text-fg-subtle mt-1">
            {pending.detectedDialect
              ? t('projects.review.dialectDetected', {
                  dialect: pending.detectedDialect,
                  confidence: String(Math.round(pending.detectedConfidence * 100))
                })
              : t('projects.review.dialectUnknown')}
          </div>
        </label>
        <label class="text-sm md:col-span-2">
          <div class="text-fg-muted mb-1">{t('projects.review.entrypoint')}</div>
          <select
            class="input w-full font-mono text-xs"
            value={entrypoint}
            onChange={(e) => setEntrypoint((e.target as HTMLSelectElement).value)}
          >
            {pending.files.map((f) => (
              <option value={f.path}>{f.path}</option>
            ))}
          </select>
        </label>
      </div>
      <div class="text-xs text-fg-muted mb-3">
        {t('projects.review.files', { n: String(pending.files.length), size: sizeStr })}
      </div>
      {oversized && (
        <div class="text-xs text-warn bg-warn/5 border border-warn/30 rounded p-2 mb-3">
          {t('projects.review.sizeWarning', { size: sizeStr })}
        </div>
      )}
      <div class="flex items-center gap-2 justify-end">
        <button class="btn-ghost text-sm" onClick={onCancel} disabled={busy}>
          {t('projects.review.cancel')}
        </button>
        <button
          class="btn-primary text-sm"
          onClick={() => onSave(name.trim() || pending.suggestedName, dialect, entrypoint)}
          disabled={busy || !name.trim() || !entrypoint}
        >
          {t('projects.review.save')}
        </button>
      </div>
    </Card>
  );
}
