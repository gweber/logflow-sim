import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { marked } from 'marked';
import DOMPurify from 'isomorphic-dompurify';

export interface RenderedDoc {
  slug: string;
  frontmatter: Record<string, unknown>;
  html: string;
  raw: string;
  readingTimeMin: number;
  toc: { depth: number; text: string; id: string }[];
}

function slugifyHeading(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-');
}

function extractToc(md: string): { depth: number; text: string; id: string }[] {
  const lines = md.split(/\r?\n/);
  const out: { depth: number; text: string; id: string }[] = [];
  let inFence = false;
  for (const line of lines) {
    if (/^```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) {
      out.push({ depth: m[1].length, text: m[2], id: slugifyHeading(m[2]) });
    }
  }
  return out;
}

function ensureDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function listMarkdown(dir: string): RenderedDoc[] {
  if (!ensureDir(dir)) return [];
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort();
  return files.map((f) => loadMarkdown(path.join(dir, f), slugFromFile(f))).filter((x): x is RenderedDoc => x !== null);
}

function slugFromFile(f: string): string {
  return f.replace(/\.md$/, '').replace(/^\d{4}-\d{2}-\d{2}-/, '');
}

export function loadMarkdownBySlug(dir: string, slug: string): RenderedDoc | null {
  if (!ensureDir(dir)) return null;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
  for (const f of files) {
    if (slugFromFile(f) === slug) {
      return loadMarkdown(path.join(dir, f), slug);
    }
  }
  return null;
}

function loadMarkdown(absPath: string, slug: string): RenderedDoc | null {
  let raw: string;
  try {
    raw = fs.readFileSync(absPath, 'utf8');
  } catch {
    return null;
  }
  const parsed = matter(raw);
  const renderer = new marked.Renderer();
  // marked v18 passes a `Heading` token to the renderer instead of the
  // pre-rendered text/level pair v12 used. We render the children ourselves
  // via `parser.parseInline` so any inline markdown inside the heading
  // (links, code spans) still works.
  renderer.heading = function (this: { parser: { parseInline: (tokens: unknown[]) => string } }, heading) {
    const inner = this.parser.parseInline(heading.tokens);
    const id = slugifyHeading(heading.text);
    return `<h${heading.depth} id="${id}">${inner}</h${heading.depth}>\n`;
  };
  const html = marked.parse(parsed.content, { renderer }) as string;
  const safe = DOMPurify.sanitize(html);
  const words = parsed.content.split(/\s+/).filter(Boolean).length;
  return {
    slug,
    frontmatter: parsed.data,
    html: safe,
    raw: parsed.content,
    readingTimeMin: Math.max(1, Math.round(words / 220)),
    toc: extractToc(parsed.content)
  };
}
