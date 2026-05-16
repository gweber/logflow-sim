import { describe, it, expect } from 'vitest';
import { parse, buildIR } from '../src/core/dialects/rsyslog/index.js';
import { validate } from '../src/core/validate/index.js';

function modelFrom(src: string) {
  return buildIR([parse({ path: 'main.conf', content: src }).ast]);
}

/**
 * The "I forgot to module(load=...)" footgun. rsyslog ignores inputs/
 * actions whose module isn't loaded — silent traffic loss. The validator
 * surfaces this as an error so a CI gate trips before deploy.
 */
describe('validate/module-load-required', () => {
  it('flags an imtcp input without `module(load="imtcp")`', () => {
    const model = modelFrom(`
      module(load="imudp")
      input(type="imudp" port="514" ruleset="r")
      input(type="imtcp" port="6601" ruleset="r")
      ruleset(name="r") { action(type="omfile" file="/var/log/messages") }
    `);
    const r = validate(model);
    const finding = r.findings.find(
      (f) => f.code === 'V_MODULE_MISSING' && f.message.includes('imtcp')
    );
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe('error');
    expect(finding!.message).toMatch(/silently fail to bind/);
  });

  it('does not flag inputs whose module IS loaded', () => {
    const model = modelFrom(`
      module(load="imudp")
      module(load="imtcp")
      input(type="imudp" port="514" ruleset="r")
      input(type="imtcp" port="6601" ruleset="r")
      ruleset(name="r") { action(type="omfile" file="/var/log/messages") }
    `);
    const r = validate(model);
    const findings = r.findings.filter((f) => f.code === 'V_MODULE_MISSING');
    expect(findings).toEqual([]);
  });

  it('flags omkafka action without the corresponding module', () => {
    const model = modelFrom(`
      module(load="imudp")
      input(type="imudp" port="514" ruleset="r")
      ruleset(name="r") {
        action(type="omkafka" broker="localhost:9092" topic="logs")
      }
    `);
    const r = validate(model);
    const finding = r.findings.find(
      (f) => f.code === 'V_MODULE_MISSING' && f.message.includes('omkafka')
    );
    expect(finding).toBeDefined();
  });

  it('does NOT flag omfile or omfwd (built into rsyslogd)', () => {
    const model = modelFrom(`
      module(load="imudp")
      input(type="imudp" port="514" ruleset="r")
      ruleset(name="r") {
        action(type="omfile" file="/var/log/messages")
        action(type="omfwd" target="collector.example.net" port="514" protocol="tcp")
      }
    `);
    const r = validate(model);
    const findings = r.findings.filter((f) => f.code === 'V_MODULE_MISSING');
    expect(findings).toEqual([]);
  });

  it('flags actions inside nested if-branches too', () => {
    const model = modelFrom(`
      module(load="imudp")
      input(type="imudp" port="514" ruleset="r")
      ruleset(name="r") {
        if $programname == "audit" then {
          action(type="omelasticsearch" server="es" template="audit")
        } else {
          action(type="omfile" file="/var/log/other")
        }
      }
    `);
    const r = validate(model);
    const finding = r.findings.find(
      (f) => f.code === 'V_MODULE_MISSING' && f.message.includes('omelasticsearch')
    );
    expect(finding).toBeDefined();
  });
});
