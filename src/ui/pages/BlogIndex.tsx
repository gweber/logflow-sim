import { Link } from 'wouter-preact';
import { useApi } from '../hooks/useApi';
import { Card, SectionHeading, EmptyState, Badge } from '../components/UI';

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

export function BlogIndexPage() {
  const { data, loading } = useApi<PostsList>('/blog/posts');
  return (
    <div>
      <SectionHeading
        title="Blog"
        description="Notes, design write-ups, and project updates."
      />
      {loading && <div class="text-sm text-fg-muted">Loading…</div>}
      {data && data.posts.length === 0 && (
        <EmptyState
          title="No posts yet"
          description="Drop markdown files into content/posts/ to publish them here."
        />
      )}
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        {data?.posts.map((p) => (
          <Link href={`/blog/${p.slug}`}>
            <Card class="hover:border-border-strong transition-colors h-full cursor-pointer">
              <div class="flex items-center gap-2 text-xs text-fg-subtle">
                {p.date && <span>{new Date(String(p.date)).toLocaleDateString()}</span>}
                {p.date && <span>·</span>}
                <span>{p.readingTime} min read</span>
              </div>
              <div class="mt-2 font-semibold text-lg leading-snug">{p.title}</div>
              {p.excerpt && (
                <p class="text-sm text-fg-muted mt-2 leading-relaxed line-clamp-3">{p.excerpt}</p>
              )}
              {p.tags && p.tags.length > 0 && (
                <div class="mt-3 flex flex-wrap gap-1.5">
                  {p.tags.map((t) => (
                    <Badge>{t}</Badge>
                  ))}
                </div>
              )}
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
