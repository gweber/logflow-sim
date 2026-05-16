import { Link, useLocation } from 'wouter-preact';
import { useEffect } from 'preact/hooks';
import { useApi } from '../hooks/useApi';
import { Card, EmptyState, Badge } from '../components/UI';

interface DocsList {
  docs: { slug: string; title: string; order: number; readingTime: number }[];
}

interface Doc {
  slug: string;
  frontmatter: Record<string, unknown>;
  html: string;
  readingTimeMin: number;
  toc: { depth: number; text: string; id: string }[];
}

export function DocsPage({ slug }: { slug?: string }) {
  const list = useApi<DocsList>('/docs');
  const [, navigate] = useLocation();

  useEffect(() => {
    if (!slug && list.data && list.data.docs.length > 0) {
      navigate(`/docs/${list.data.docs[0].slug}`, { replace: true });
    }
  }, [slug, list.data]);

  return (
    <div class="grid grid-cols-1 lg:grid-cols-12 gap-8">
      <aside class="lg:col-span-3">
        <div class="sticky top-20">
          <div class="text-xs uppercase tracking-wider text-fg-subtle mb-3">Documentation</div>
          <nav class="space-y-1">
            {list.data?.docs.map((d) => (
              <Link
                href={`/docs/${d.slug}`}
                class={`block rounded-md px-3 py-1.5 text-sm transition-colors ${
                  slug === d.slug
                    ? 'bg-accent/10 text-accent'
                    : 'text-fg-muted hover:bg-bg-subtle hover:text-fg'
                }`}
              >
                {d.title}
              </Link>
            ))}
            {list.data && list.data.docs.length === 0 && (
              <div class="text-sm text-fg-muted">No docs found.</div>
            )}
          </nav>
        </div>
      </aside>
      <main class="lg:col-span-9 min-w-0">
        {slug ? <DocBody slug={slug} /> : <EmptyState title="Pick a document" />}
      </main>
    </div>
  );
}

function DocBody({ slug }: { slug: string }) {
  const { data, loading, error } = useApi<Doc>(`/docs/${encodeURIComponent(slug)}`);
  if (loading) return <div class="text-sm text-fg-muted">Loading…</div>;
  if (error)
    return <Card class="border-danger/40 bg-danger/5 text-sm">{error.message}</Card>;
  if (!data) return null;
  return (
    <div class="grid grid-cols-1 xl:grid-cols-12 gap-8">
      <article class="xl:col-span-9 min-w-0">
        <h1 class="text-3xl font-bold tracking-tight mb-6">
          {String(data.frontmatter.title ?? data.slug)}
        </h1>
        <div class="prose-doc" dangerouslySetInnerHTML={{ __html: data.html }} />
      </article>
      {data.toc.length > 0 && (
        <aside class="xl:col-span-3 hidden xl:block">
          <div class="sticky top-20 text-sm">
            <div class="text-xs uppercase tracking-wider text-fg-subtle mb-2">On this page</div>
            <ul class="space-y-1">
              {data.toc
                .filter((h) => h.depth <= 3)
                .map((h) => (
                  <li>
                    <a
                      href={`#${h.id}`}
                      class={`block py-0.5 text-fg-muted hover:text-fg ${
                        h.depth === 1
                          ? 'font-semibold'
                          : h.depth === 2
                          ? 'pl-2'
                          : 'pl-4 text-xs'
                      }`}
                    >
                      {h.text}
                    </a>
                  </li>
                ))}
            </ul>
          </div>
        </aside>
      )}
    </div>
  );
}
