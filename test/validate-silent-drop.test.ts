import { describe, it, expect } from 'vitest';
import { parse, buildIR } from '../src/core/dialects/rsyslog/index.js';
import { validate } from '../src/core/validate/index.js';

function modelFrom(src: string) {
  return buildIR([parse({ path: 'main.conf', content: src }).ast]);
}

describe('validate/silent-drop-paths', () => {
  it('flags a ruleset whose last statement is an `if` without `else`', () => {
    const model = modelFrom(`
      ruleset(name="t") {
        if $programname == "sshd" then {
          action(type="omfile" file="/var/log/secure")
        }
      }
    `);
    const r = validate(model);
    const finding = r.findings.find((f) => f.code === 'V_SILENT_DROP');
    expect(finding).toBeDefined();
    expect(finding!.message).toContain('"t"');
    expect(finding!.message).toMatch(/silently/);
    expect(finding!.severity).toBe('warning');
  });

  it('passes a ruleset that ends with a catch-all action', () => {
    const model = modelFrom(`
      ruleset(name="t") {
        if $programname == "sshd" then {
          action(type="omfile" file="/var/log/secure")
        }
        action(type="omfile" file="/var/log/messages")
      }
    `);
    const r = validate(model);
    const finding = r.findings.find((f) => f.code === 'V_SILENT_DROP');
    expect(finding).toBeUndefined();
  });

  it('passes a ruleset that ends with an explicit stop', () => {
    const model = modelFrom(`
      ruleset(name="t") {
        if $programname == "sshd" then {
          action(type="omfile" file="/var/log/secure")
        }
        stop
      }
    `);
    const r = validate(model);
    const finding = r.findings.find((f) => f.code === 'V_SILENT_DROP');
    expect(finding).toBeUndefined();
  });

  it('passes an if/else where both branches end terminally', () => {
    const model = modelFrom(`
      ruleset(name="t") {
        if $programname == "sshd" then {
          action(type="omfile" file="/var/log/secure")
        } else {
          action(type="omfile" file="/var/log/messages")
        }
      }
    `);
    const r = validate(model);
    const finding = r.findings.find((f) => f.code === 'V_SILENT_DROP');
    expect(finding).toBeUndefined();
  });

  it('flags an if/else where the `else` branch silently drops', () => {
    const model = modelFrom(`
      ruleset(name="t") {
        if $programname == "sshd" then {
          action(type="omfile" file="/var/log/secure")
        } else {
          set $!sourcetype = "unknown";
        }
      }
    `);
    const r = validate(model);
    // The else branch ends with a Set (non-terminal), so the if itself is
    // non-terminal — meaning the ruleset's tail is non-terminal.
    const finding = r.findings.find((f) => f.code === 'V_SILENT_DROP');
    expect(finding).toBeDefined();
  });

  it('does NOT flag a ruleset that is reached via `call` (helper pattern)', () => {
    const model = modelFrom(`
      ruleset(name="entry") {
        call helper
        action(type="omfile" file="/var/log/messages")
      }
      ruleset(name="helper") {
        set $!sourcetype = "x";
      }
    `);
    const r = validate(model);
    const finding = r.findings.find(
      (f) => f.code === 'V_SILENT_DROP' && f.message.includes('"helper"')
    );
    expect(finding).toBeUndefined();
  });

  it('narrative names what went wrong (the operator-facing message)', () => {
    const model = modelFrom(`ruleset(name="empty") {}`);
    const r = validate(model);
    const finding = r.findings.find((f) => f.code === 'V_SILENT_DROP');
    expect(finding).toBeDefined();
    expect(finding!.message).toMatch(/empty/);
    expect(finding!.message).toMatch(/end the ruleset.*stop/i);
  });
});
