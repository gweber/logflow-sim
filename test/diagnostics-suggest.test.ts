import { describe, it, expect } from 'vitest';
import { suggest, withSuggestion } from '../src/core/diagnostics-suggest.js';
import { parse, buildIR } from '../src/core/dialects/rsyslog/index.js';
import { validate } from '../src/core/validate/index.js';

describe('diagnostics-suggest', () => {
  it('returns null on empty pool', () => {
    expect(suggest('foo', [])).toBeNull();
  });

  it('returns null when nothing is close enough', () => {
    expect(suggest('foo', ['bazzzz', 'qux'])).toBeNull();
  });

  it('catches single-character typos', () => {
    expect(suggest('catchall', ['catchhall', 'firewall_rs'])).toBe('catchhall');
  });

  it('catches transpositions as a single edit', () => {
    expect(suggest('sshd', ['ssdh', 'sshd_pam'])).toBe('ssdh');
  });

  it('is case-insensitive', () => {
    expect(suggest('Catchall', ['catchall_rs', 'firewall_rs'])).toBe('catchall_rs');
  });

  it('does not suggest something wildly different for short names', () => {
    expect(suggest('foo', ['banana'])).toBeNull();
  });

  it('withSuggestion appends the hint', () => {
    expect(withSuggestion('undefined ruleset "X"', 'XA')).toBe(
      'undefined ruleset "X" (did you mean: `XA`?)'
    );
    expect(withSuggestion('undefined ruleset "X"', null)).toBe('undefined ruleset "X"');
  });
});

describe('integration: undefined-refs uses suggest', () => {
  it('appends "did you mean" to undefined-ruleset findings', () => {
    const ast = parse({
      path: 'main.conf',
      content: `
        module(load="imudp")
        input(type="imudp" port="514" ruleset="r")
        ruleset(name="catchall_rs") { action(type="omfile" file="/x") }
        ruleset(name="r") {
          call catchall_rss
        }
      `
    }).ast;
    const model = buildIR([ast]);
    const r = validate(model);
    const finding = r.findings.find(
      (f) => f.code === 'V_UNDEFINED_RULESET' && f.message.includes('catchall_rss')
    );
    expect(finding).toBeDefined();
    expect(finding!.message).toContain('did you mean');
    expect(finding!.message).toContain('catchall_rs');
  });
});
