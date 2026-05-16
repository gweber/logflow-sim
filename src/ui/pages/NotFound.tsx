import { Link } from 'wouter-preact';

export function NotFoundPage() {
  return (
    <div class="text-center py-24">
      <div class="text-6xl font-bold tracking-tight text-fg-muted">404</div>
      <div class="text-fg mt-4">This page does not exist.</div>
      <div class="mt-6">
        <Link href="/" class="btn-primary">
          Go home
        </Link>
      </div>
    </div>
  );
}
