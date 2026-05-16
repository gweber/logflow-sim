import { Link } from 'wouter-preact';
import { useApi } from '../hooks/useApi';
import { Card, Badge } from '../components/UI';
import { IconArrowRight } from '../components/Icons';

interface Doc {
  slug: string;
  frontmatter: Record<string, unknown>;
  html: string;
  readingTimeMin: number;
}

export function BlogPostPage({ slug }: { slug: string }) {
  const { data, loading, error } = useApi<Doc>(`/blog/posts/${encodeURIComponent(slug)}`);
  return (
    <article class="max-w-3xl mx-auto">
      <div class="mb-6">
        <Link href="/blog" class="text-sm text-accent inline-flex items-center gap-1 hover:underline">
          ← All posts
        </Link>
      </div>
      {loading && <div class="text-sm text-fg-muted">Loading…</div>}
      {error && (
        <Card class="border-danger/40 bg-danger/5 text-sm">{error.message}</Card>
      )}
      {data && (
        <>
          <header class="mb-8">
            <div class="flex items-center gap-2 text-sm text-fg-muted">
              {data.frontmatter.date && (
                <span>{new Date(String(data.frontmatter.date)).toLocaleDateString()}</span>
              )}
              <span>·</span>
              <span>{data.readingTimeMin} min read</span>
            </div>
            <h1 class="mt-3 text-4xl font-bold tracking-tight">
              {String(data.frontmatter.title ?? data.slug)}
            </h1>
            {Array.isArray(data.frontmatter.tags) && (
              <div class="mt-4 flex flex-wrap gap-1.5">
                {(data.frontmatter.tags as string[]).map((t) => (
                  <Badge>{t}</Badge>
                ))}
              </div>
            )}
          </header>
          <div class="prose-doc" dangerouslySetInnerHTML={{ __html: data.html }} />
        </>
      )}
    </article>
  );
}
