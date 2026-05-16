import type { ComponentChildren, JSX } from 'preact';
import { useState } from 'preact/hooks';
import { IconCopy, IconCheck } from './Icons';

export function Card({
  children,
  class: cls = '',
  ...rest
}: { children: ComponentChildren; class?: string } & JSX.HTMLAttributes<HTMLDivElement>) {
  return (
    <div class={`card p-5 ${cls}`} {...rest}>
      {children}
    </div>
  );
}

export function SectionHeading({
  title,
  description,
  actions
}: {
  title: string;
  description?: string;
  actions?: ComponentChildren;
}) {
  return (
    <div class="flex items-end justify-between gap-4 mb-5">
      <div>
        <h1 class="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && <p class="text-sm text-fg-muted mt-1">{description}</p>}
      </div>
      {actions && <div class="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Badge({
  tone = 'neutral',
  children
}: {
  tone?: 'neutral' | 'ok' | 'warn' | 'error' | 'accent';
  children: ComponentChildren;
}) {
  const cls =
    tone === 'ok'
      ? 'badge-ok'
      : tone === 'warn'
      ? 'badge-warning'
      : tone === 'error'
      ? 'badge-error'
      : tone === 'accent'
      ? 'badge-info'
      : 'chip';
  return <span class={cls}>{children}</span>;
}

export function Tabs({
  tabs,
  active,
  onChange
}: {
  tabs: { id: string; label: string; badge?: string | number }[];
  active: string;
  onChange: (id: string) => void;
}) {
  return (
    <div class="flex items-center gap-1 border-b border-border overflow-x-auto">
      {tabs.map((t) => (
        <button
          key={t.id}
          onClick={() => onChange(t.id)}
          class={`relative px-3 py-2 text-sm font-medium transition-colors whitespace-nowrap ${
            active === t.id
              ? 'text-fg'
              : 'text-fg-muted hover:text-fg'
          }`}
        >
          <span class="flex items-center gap-2">
            {t.label}
            {t.badge !== undefined && t.badge !== 0 && t.badge !== '' && (
              <span class="chip">{t.badge}</span>
            )}
          </span>
          {active === t.id && (
            <span class="absolute left-2 right-2 -bottom-px h-0.5 bg-accent rounded-full" />
          )}
        </button>
      ))}
    </div>
  );
}

export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      class="btn-ghost text-xs"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        } catch {}
      }}
      title="Copy"
    >
      {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
      <span>{copied ? 'Copied' : 'Copy'}</span>
    </button>
  );
}

export function CodeBlock({ code, language }: { code: string; language?: string }) {
  return (
    <div class="relative group">
      <pre class="bg-bg-subtle border border-border rounded-lg p-4 overflow-x-auto text-xs leading-relaxed">
        <code class={language ? `language-${language}` : ''}>{code}</code>
      </pre>
      <div class="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity">
        <CopyButton text={code} />
      </div>
    </div>
  );
}

export function JsonViewer({ value }: { value: unknown }) {
  return <CodeBlock code={JSON.stringify(value, null, 2)} language="json" />;
}

export function EmptyState({
  title,
  description,
  action
}: {
  title: string;
  description?: string;
  action?: ComponentChildren;
}) {
  return (
    <div class="border border-dashed border-border rounded-xl p-10 text-center">
      <div class="text-fg font-medium">{title}</div>
      {description && <div class="text-sm text-fg-muted mt-1">{description}</div>}
      {action && <div class="mt-4">{action}</div>}
    </div>
  );
}

export function Skeleton({ height = 16, width = '100%' }: { height?: number; width?: number | string }) {
  return (
    <div
      class="animate-pulse bg-bg-subtle rounded"
      style={{ height: `${height}px`, width: typeof width === 'number' ? `${width}px` : width }}
    />
  );
}

export function SourceLocChip({
  file,
  line,
  col
}: {
  file?: string;
  line?: number;
  col?: number;
}) {
  if (!file) return null;
  const href = `/config?file=${encodeURIComponent(file)}${line ? `&line=${line}` : ''}`;
  return (
    <a
      href={href}
      class="chip hover:text-fg hover:border-border-strong font-mono"
      title={`${file}:${line ?? ''}:${col ?? ''}`}
    >
      {file}
      {line ? `:${line}` : ''}
    </a>
  );
}
