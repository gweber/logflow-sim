import { Link } from 'wouter-preact';
import { useApi } from '../hooks/useApi';
import { useT } from '../i18n/index.js';
import { Card, CodeBlock, Badge } from '../components/UI';
import {
  IconArrowRight,
  IconBolt,
  IconBug,
  IconRouter,
  IconSearch
} from '../components/Icons';

interface ParseSummary {
  diagnostics: { severity: string }[];
  summary: {
    files: number;
    inputs: number;
    rulesets: number;
    templates: number;
    lookupTables: number;
    modules: number;
    omfileActions: number;
    omfwdActions: number;
    stopStatements: number;
    unknownStatements: number;
  };
  defaultRuleset: string | null;
}

interface PostsList {
  posts: {
    slug: string;
    title: string;
    date?: string;
    excerpt?: string;
    tags?: string[];
    readingTime: number;
  }[];
}

interface ModelDigest {
  inputs: {
    id: string;
    type?: string;
    port?: number;
    ruleset?: string;
    params?: Record<string, unknown>;
    source: { file: string; line: number };
  }[];
  rulesets: { name: string; source: { file: string; line: number } }[];
  lookupTables: { name: string; file: string }[];
  templates: { name: string; type?: string }[];
  globals?: { defaultRuleset?: string };
}

const FEATURES = [
  {
    icon: IconSearch,
    title: 'Parse with diagnostics',
    body: 'Hand-written RainerScript parser. Unknown statements are preserved as UnknownNode with file/line/column and a diagnostic — never silently dropped.'
  },
  {
    icon: IconBolt,
    title: 'Simulate end-to-end',
    body: 'Send a syslog message in; get back the exact input matched, the ruleset chosen, the conditions evaluated, the variables changed, and the actions fired.'
  },
  {
    icon: IconRouter,
    title: 'Trace every decision',
    body: 'Each step in the simulation comes with a source-location chip linking directly to the line in your config that produced it.'
  },
  {
    icon: IconBug,
    title: 'Run test suites',
    body: 'Drop expectation files into conf/tests/*.json. Re-run them on every parse to catch regressions before they hit production rsyslog.'
  }
];

export function HomePage() {
  const { t } = useT();
  const summary = useApi<ParseSummary>('/config/parse');
  const model = useApi<ModelDigest>('/model');
  const posts = useApi<PostsList>('/blog/posts');
  const errCount = summary.data?.diagnostics.filter((d) => d.severity === 'error').length ?? 0;
  const warnCount = summary.data?.diagnostics.filter((d) => d.severity === 'warning').length ?? 0;

  return (
    <div>
      {/* Hero */}
      <section class="relative overflow-hidden">
        <div
          aria-hidden
          class="absolute inset-0 -z-10 opacity-60 pointer-events-none"
          style={{
            background:
              'radial-gradient(700px 280px at 20% 0%, rgb(var(--c-accent) / 0.12), transparent 70%), radial-gradient(700px 240px at 100% 20%, rgb(var(--c-accent) / 0.08), transparent 60%)'
          }}
        />
        <div class="py-12 sm:py-20 max-w-3xl">
          <Badge tone="accent">{t('home.hero.eyebrow')}</Badge>
          <h1 class="mt-4 text-4xl sm:text-5xl font-bold tracking-tight leading-tight">
            {t('home.hero.title')}
            <span class="text-accent">.</span>
          </h1>
          <p class="mt-5 text-lg text-fg-muted leading-relaxed">
            {t('home.hero.description', { name: 'logflow-sim' })
              .split('logflow-sim')
              .map((part, i, arr) => (
                <>
                  {part}
                  {i < arr.length - 1 && <span class="font-mono text-fg">logflow-sim</span>}
                </>
              ))}
          </p>
          <div class="mt-7 flex flex-wrap gap-3">
            <Link href="/simulator" class="btn-primary">
              {t('home.hero.cta.simulator')} <IconArrowRight size={16} />
            </Link>
            <Link href="/docs" class="btn-secondary">
              {t('home.hero.cta.docs')}
            </Link>
            <Link href="/config" class="btn-ghost">
              {t('home.hero.cta.config')}
            </Link>
          </div>
        </div>
      </section>

      {/* Status strip */}
      <section class="mt-2">
        <Card class="!p-0 overflow-hidden">
          <div class="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 divide-y sm:divide-y-0 sm:divide-x divide-border">
            <Stat label={t('home.stats.files')} value={summary.data?.summary.files} />
            <Stat label={t('home.stats.inputs')} value={summary.data?.summary.inputs} />
            <Stat label={t('home.stats.rulesets')} value={summary.data?.summary.rulesets} />
            <Stat label={t('home.stats.templates')} value={summary.data?.summary.templates} />
            <Stat label={t('home.stats.lookupTables')} value={summary.data?.summary.lookupTables} />
            <Stat label={t('home.stats.errors')} value={errCount} tone={errCount ? 'error' : 'neutral'} />
            <Stat label={t('home.stats.warnings')} value={warnCount} tone={warnCount ? 'warn' : 'neutral'} />
          </div>
        </Card>
      </section>

      {/* Config digest — what the parser actually found in your config */}
      <section class="mt-10">
        <div class="flex items-baseline justify-between mb-4">
          <h2 class="text-xl font-semibold tracking-tight">{t('home.yourConfig.title')}</h2>
          <Link href="/config" class="text-sm text-accent hover:underline inline-flex items-center gap-1">
            {t('home.yourConfig.openBrowser')} <IconArrowRight size={14} />
          </Link>
        </div>
        <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Card>
            <div class="flex items-center justify-between mb-3">
              <div class="font-semibold">{t("home.yourConfig.inputs")}</div>
              <Badge>{model.data?.inputs.length ?? 0}</Badge>
            </div>
            {model.loading && <SkeletonList rows={3} />}
            {model.data && model.data.inputs.length === 0 && (
              <div class="text-sm text-fg-muted">{t("home.yourConfig.noInputs")}</div>
            )}
            <ul class="space-y-1.5">
              {model.data?.inputs.slice(0, 6).map((i) => (
                <li class="flex items-center justify-between gap-2 text-sm">
                  <span class="font-mono text-fg">
                    {i.type ?? '?'}
                    {i.port ? `:${i.port}` : ''}
                  </span>
                  <span class="text-xs text-fg-muted truncate">
                    → <span class="font-mono">{i.ruleset ?? model.data?.globals?.defaultRuleset ?? '—'}</span>
                  </span>
                </li>
              ))}
            </ul>
          </Card>

          <Card>
            <div class="flex items-center justify-between mb-3">
              <div class="font-semibold">{t("home.yourConfig.rulesets")}</div>
              <Badge>{model.data?.rulesets.length ?? 0}</Badge>
            </div>
            {model.loading && <SkeletonList rows={3} />}
            <ul class="space-y-1.5">
              {model.data?.rulesets.slice(0, 6).map((r) => (
                <li class="flex items-center justify-between gap-2 text-sm">
                  <span class="font-mono">{r.name}</span>
                  <span class="text-[11px] text-fg-subtle font-mono truncate">
                    {r.source.file}:{r.source.line}
                  </span>
                </li>
              ))}
            </ul>
            {model.data?.globals?.defaultRuleset && (
              <div class="mt-3 pt-3 border-t border-border text-xs text-fg-muted">
                {t("home.yourConfig.defaultRuleset")} <span class="font-mono text-fg">{model.data.globals.defaultRuleset}</span>
              </div>
            )}
          </Card>

          <Card>
            <div class="flex items-center justify-between mb-3">
              <div class="font-semibold">{t("home.yourConfig.lookupTables")}</div>
              <Badge>{model.data?.lookupTables.length ?? 0}</Badge>
            </div>
            {model.loading && <SkeletonList rows={3} />}
            {model.data && model.data.lookupTables.length === 0 && (
              <div class="text-sm text-fg-muted">{t("home.yourConfig.noLookups")}</div>
            )}
            <ul class="space-y-1.5">
              {model.data?.lookupTables.slice(0, 6).map((l) => (
                <li class="flex items-center justify-between gap-2 text-sm">
                  <span class="font-mono">{l.name}</span>
                  <span class="text-[11px] text-fg-subtle font-mono truncate" title={l.file}>
                    {l.file.split('/').pop()}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </section>

      {/* Features grid */}
      <section class="mt-14">
        <h2 class="text-xl font-semibold tracking-tight mb-5">What it does</h2>
        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {FEATURES.map((f) => (
            <Card class="hover:border-border-strong transition-colors">
              <div class="w-9 h-9 rounded-lg bg-accent/10 text-accent flex items-center justify-center mb-3">
                <f.icon size={18} />
              </div>
              <div class="font-semibold">{f.title}</div>
              <p class="text-sm text-fg-muted leading-relaxed mt-1.5">{f.body}</p>
            </Card>
          ))}
        </div>
      </section>

      {/* Quick start */}
      <section class="mt-14 grid grid-cols-1 lg:grid-cols-5 gap-6">
        <Card class="lg:col-span-3">
          <div class="flex items-center justify-between">
            <h2 class="text-lg font-semibold">Quick start</h2>
            <Badge>Docker</Badge>
          </div>
          <p class="text-sm text-fg-muted mt-1">
            Place your rsyslog config in <code class="font-mono">./conf/</code>, then:
          </p>
          <div class="mt-4">
            <CodeBlock
              code={`docker compose up --build

# Then:
curl -s localhost:3000/api/config/parse | jq .summary

curl -s localhost:3000/api/simulate -H 'content-type: application/json' -d '{
  "transport": "udp", "port": 514,
  "fromhost": "fw01", "programname": "firewall",
  "msg": "deny tcp 10.0.0.1 -> 8.8.8.8:53"
}' | jq .`}
              language="bash"
            />
          </div>
        </Card>

        <Card class="lg:col-span-2">
          <h2 class="text-lg font-semibold">Latest posts</h2>
          <p class="text-sm text-fg-muted mt-1">From the project blog.</p>
          <div class="mt-4 space-y-3">
            {posts.loading && (
              <div class="space-y-3">
                <div class="h-12 bg-bg-subtle rounded animate-pulse" />
                <div class="h-12 bg-bg-subtle rounded animate-pulse" />
              </div>
            )}
            {posts.data?.posts.slice(0, 3).map((p) => (
              <Link
                href={`/blog/${p.slug}`}
                class="block group rounded-lg -mx-1 px-2 py-2 hover:bg-bg-subtle transition-colors"
              >
                <div class="text-sm font-medium group-hover:text-accent transition-colors">
                  {p.title}
                </div>
                <div class="text-xs text-fg-subtle mt-0.5">
                  {p.date ? new Date(String(p.date)).toLocaleDateString() : ''}
                  {p.date && p.readingTime ? ' · ' : ''}
                  {p.readingTime ? `${p.readingTime} min read` : ''}
                </div>
                {p.excerpt && (
                  <div class="text-xs text-fg-muted mt-1 line-clamp-2">{p.excerpt}</div>
                )}
              </Link>
            ))}
            {posts.data && posts.data.posts.length === 0 && (
              <div class="text-sm text-fg-muted">
                No posts yet. Drop markdown files in <code>content/posts/</code>.
              </div>
            )}
          </div>
          <div class="mt-4">
            <Link href="/blog" class="text-sm text-accent hover:underline inline-flex items-center gap-1">
              All posts <IconArrowRight size={14} />
            </Link>
          </div>
        </Card>
      </section>

      {/* API quick reference */}
      <section class="mt-14">
        <h2 class="text-xl font-semibold tracking-tight mb-5">API at a glance</h2>
        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {[
            ['GET', '/api/health', 'Liveness check'],
            ['GET', '/api/config/tree', 'All files under conf/'],
            ['GET', '/api/config/parse', 'Diagnostics + summary'],
            ['GET', '/api/model', 'Full normalized IR'],
            ['POST', '/api/simulate', 'Run a message'],
            ['POST', '/api/tests/run', 'Run all conf/tests/*.json']
          ].map(([m, p, d]) => (
            <Card class="flex items-center gap-3 !py-3">
              <span
                class={`text-[10px] font-bold tracking-wider px-1.5 py-0.5 rounded ${
                  m === 'GET' ? 'bg-ok/15 text-ok' : 'bg-accent/15 text-accent'
                }`}
              >
                {m}
              </span>
              <code class="text-xs flex-1 truncate">{p}</code>
              <span class="text-xs text-fg-muted hidden sm:inline">{d}</span>
            </Card>
          ))}
        </div>
      </section>
    </div>
  );
}

function SkeletonList({ rows }: { rows: number }) {
  return (
    <div class="space-y-2">
      {Array.from({ length: rows }).map(() => (
        <div class="h-5 bg-bg-subtle rounded animate-pulse" />
      ))}
    </div>
  );
}

function Stat({
  label,
  value,
  tone = 'neutral'
}: {
  label: string;
  value: number | undefined;
  tone?: 'neutral' | 'error' | 'warn';
}) {
  const v = value ?? '—';
  const cls =
    tone === 'error'
      ? 'text-danger'
      : tone === 'warn'
      ? 'text-warn'
      : 'text-fg';
  return (
    <div class="px-4 py-4 sm:py-5">
      <div class={`text-2xl font-semibold tabular-nums ${cls}`}>{v}</div>
      <div class="text-[11px] uppercase tracking-wider text-fg-subtle mt-1">{label}</div>
    </div>
  );
}
