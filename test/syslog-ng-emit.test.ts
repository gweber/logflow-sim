import { describe, it, expect } from 'vitest';
import { parse, buildIR } from '../src/core/dialects/rsyslog/index.js';
import { emit } from '../src/core/dialects/syslog-ng/emit.js';

/**
 * syslog-ng emit regressions. The previous implementation dropped every
 * `if` condition and every lookup with a single bland diagnostic; these
 * tests pin the new behavior so it doesn't regress back into silent
 * lossiness.
 */

function modelFrom(src: string) {
  return buildIR([parse({ path: 'main.conf', content: src }).ast]);
}

describe('syslog-ng emit', () => {
  it('translates `if $programname == "x"` into a program() filter', () => {
    const model = modelFrom(`
      module(load="imudp")
      input(type="imudp" port="514" ruleset="r")
      ruleset(name="r") {
        if $programname == "sshd" then {
          action(type="omfile" file="/var/log/secure")
        }
      }
    `);
    const result = emit(model);
    expect(result.output).toMatch(/filter f_\d+ \{ program\("sshd"\); \};/);
    expect(result.output).toMatch(/filter\(f_\d+\)/);
    expect(result.output).toMatch(/destination\(d_omfile_/);
    const info = result.diagnostics.find((d) => d.code === 'I_SYSLOGNG_IFS');
    expect(info?.message).toMatch(/translated 1 if-condition\(s\)/);
  });

  it('translates `if $msg contains "X"` into a message() regex filter', () => {
    const model = modelFrom(`
      module(load="imudp")
      input(type="imudp" port="514" ruleset="r")
      ruleset(name="r") {
        if $msg contains "Failed password" then {
          action(type="omfile" file="/var/log/auth-fail")
        }
      }
    `);
    const result = emit(model);
    expect(result.output).toMatch(/message\("Failed password"\)/);
  });

  it('emits add-contextual-data parsers + CSV sidecars for lookup tables', () => {
    const model = modelFrom(`
      lookup_table(name="sourcetypes" file="lookups/sourcetypes.json")
      module(load="imudp")
      input(type="imudp" port="514" ruleset="r")
      ruleset(name="r") {
        action(type="omfile" file="/var/log/messages")
      }
    `);
    const result = emit(model, {
      lookupTables: {
        sourcetypes: {
          entries: { sshd: 'linux:secure', cron: 'linux:cron' },
          nomatch: 'syslog'
        }
      }
    });
    expect(result.output).toMatch(/parser p_lookup_sourcetypes \{/);
    expect(result.output).toMatch(/add-contextual-data\(/);
    expect(result.output).toContain('database("lookups/sourcetypes.csv")');
    expect(result.output).toContain('default-selector("syslog")');
    const sidecar = result.files?.find((f) => f.path === 'lookups/sourcetypes.csv');
    expect(sidecar).toBeDefined();
    expect(sidecar!.content).toContain('sshd,sourcetypes,linux:secure');
    expect(sidecar!.content).toContain('cron,sourcetypes,linux:cron');
  });

  it('untranslatable conditions land as a comment with a specific diagnostic', () => {
    const model = modelFrom(`
      module(load="imudp")
      input(type="imudp" port="514" ruleset="r")
      ruleset(name="r") {
        if $!sourcetype == "linux:secure" then {
          action(type="omfile" file="/var/log/secure")
        }
      }
    `);
    const result = emit(model);
    // Structured-data property refs aren't translatable to syslog-ng's
    // top-level filter() primitives — they should land as a comment plus
    // an honest count in the diagnostic.
    expect(result.output).toMatch(/# untranslated condition:/);
    const info = result.diagnostics.find((d) => d.code === 'I_SYSLOGNG_IFS');
    expect(info?.message).toMatch(/1 condition\(s\) had no syslog-ng equivalent/);
  });

  it('flattens `call ruleset` into the caller', () => {
    const model = modelFrom(`
      module(load="imudp")
      input(type="imudp" port="514" ruleset="entry")
      ruleset(name="entry") {
        call helper
        action(type="omfile" file="/var/log/messages")
      }
      ruleset(name="helper") {
        action(type="omfile" file="/var/log/helper-out")
      }
    `);
    const result = emit(model);
    expect(result.output).toContain('/var/log/helper-out');
    expect(result.output).toContain('/var/log/messages');
    const info = result.diagnostics.find((d) => d.code === 'I_SYSLOGNG_CALL_FLATTENED');
    expect(info?.message).toMatch(/flattened/);
  });
});
