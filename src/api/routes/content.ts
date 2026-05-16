import express from 'express';
import path from 'node:path';
import { listMarkdown, loadMarkdownBySlug } from '../../content/markdown.js';
import { NotFoundError } from '../../core/errors.js';
import { asyncHandler } from '../error-handler.js';
import type { AppPaths } from '../context.js';

/**
 * Blog + docs endpoints. The content lives in `content/posts/` and
 * `content/docs/` as markdown files with frontmatter; we render them
 * server-side with marked + DOMPurify.
 */
export function contentRouter(paths: AppPaths): express.Router {
  const r = express.Router();

  r.get('/blog/posts', (_req, res) => {
    const dir = path.join(paths.contentDir, 'posts');
    const posts = listMarkdown(dir).map((p) => ({
      slug: p.slug,
      title: p.frontmatter.title ?? p.slug,
      date: p.frontmatter.date ?? null,
      excerpt: p.frontmatter.excerpt ?? p.raw.split('\n').slice(0, 3).join(' ').slice(0, 200),
      tags: p.frontmatter.tags ?? [],
      readingTime: p.readingTimeMin
    }));
    res.json({ posts });
  });

  r.get(
    '/blog/posts/:slug',
    asyncHandler((req, res) => {
      const dir = path.join(paths.contentDir, 'posts');
      const slug = String(req.params.slug);
      const doc = loadMarkdownBySlug(dir, slug);
      if (!doc) throw new NotFoundError('Post not found', { slug });
      res.json(doc);
    })
  );

  r.get('/docs', (_req, res) => {
    const dir = path.join(paths.contentDir, 'docs');
    const docs = listMarkdown(dir).map((p) => ({
      slug: p.slug,
      title: p.frontmatter.title ?? p.slug,
      order: typeof p.frontmatter.order === 'number' ? (p.frontmatter.order as number) : 999,
      readingTime: p.readingTimeMin
    }));
    docs.sort((a, b) => a.order - b.order || String(a.title).localeCompare(String(b.title)));
    res.json({ docs });
  });

  r.get(
    '/docs/:slug',
    asyncHandler((req, res) => {
      const dir = path.join(paths.contentDir, 'docs');
      const doc = loadMarkdownBySlug(dir, String(req.params.slug));
      if (!doc) throw new NotFoundError('Doc not found', { slug: String(req.params.slug) });
      res.json(doc);
    })
  );

  return r;
}
