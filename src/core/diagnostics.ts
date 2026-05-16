import type { SourceLoc } from './source-map.js';

export type Severity = 'error' | 'warning' | 'info';

export interface Diagnostic {
  severity: Severity;
  message: string;
  source: SourceLoc;
  code?: string;
}

export class DiagnosticBag {
  readonly items: Diagnostic[] = [];

  add(d: Diagnostic): void {
    this.items.push(d);
  }

  error(message: string, source: SourceLoc, code?: string): void {
    this.add({ severity: 'error', message, source, code });
  }

  warning(message: string, source: SourceLoc, code?: string): void {
    this.add({ severity: 'warning', message, source, code });
  }

  info(message: string, source: SourceLoc, code?: string): void {
    this.add({ severity: 'info', message, source, code });
  }

  merge(other: DiagnosticBag | Diagnostic[]): void {
    const arr = other instanceof DiagnosticBag ? other.items : other;
    for (const d of arr) this.items.push(d);
  }

  hasErrors(): boolean {
    return this.items.some((d) => d.severity === 'error');
  }
}
