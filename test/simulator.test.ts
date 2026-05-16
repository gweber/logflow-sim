import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { parse } from '../src/core/dialects/rsyslog/index.js';
import { buildIR } from '../src/core/dialects/rsyslog/index.js';
import { simulate } from '../src/core/simulate/evaluator.js';
import { loadLookupTables } from '../src/lookups/loader.js';
import { NodeVFS } from '../src/vfs/node.js';
import type { SyslogMessage } from '../src/core/simulate/syslog-message.js';

function buildFrom(src: string, files: Record<string, string> = {}) {
  const asts = [parse({ path: 'main.conf', content: src }).ast];
  for (const [p, c] of Object.entries(files)) {
    asts.push(parse({ path: p, content: c }).ast);
  }
  return buildIR(asts);
}

function withLookupFiles(files: Record<string, string>): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rsyslog-sim-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return {
    root,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true })
  };
}

describe('simulator', () => {
  it('selects input by transport+port', () => {
    const model = buildFrom(`
input(type="imudp" port="514" ruleset="r1")
input(type="imtcp" port="514" ruleset="r2")
ruleset(name="r1") { action(type="omfile" File="/a") }
ruleset(name="r2") { action(type="omfile" File="/b") }
`);
    const r = simulate({
      model,
      lookupTables: {},
      message: { transport: 'tcp', port: 514 } as SyslogMessage
    });
    expect(r.selectedRuleset).toBe('r2');
    expect(r.finalState.outputs[0].path).toBe('/b');
  });

  it('falls back to $DefaultRuleset when no input matches', () => {
    const model = buildFrom(`
$DefaultRuleset dr
ruleset(name="dr") { action(type="omfile" File="/default") }
`);
    const r = simulate({
      model,
      lookupTables: {},
      message: { transport: 'udp', port: 9999 } as SyslogMessage
    });
    expect(r.selectedRuleset).toBe('dr');
    expect(r.finalState.outputs[0].path).toBe('/default');
  });

  it('evaluates if/else branches', () => {
    const model = buildFrom(`
input(type="imudp" port="514" ruleset="r")
ruleset(name="r") {
    if $programname == "match" then {
        action(type="omfile" File="/match")
    } else {
        action(type="omfile" File="/nomatch")
    }
}
`);
    const r1 = simulate({
      model,
      lookupTables: {},
      message: { transport: 'udp', port: 514, programname: 'match' } as SyslogMessage
    });
    expect(r1.finalState.outputs[0].path).toBe('/match');
    const r2 = simulate({
      model,
      lookupTables: {},
      message: { transport: 'udp', port: 514, programname: 'other' } as SyslogMessage
    });
    expect(r2.finalState.outputs[0].path).toBe('/nomatch');
  });

  it('tracks set/reset/unset of local and structured', () => {
    const model = buildFrom(`
input(type="imudp" port="514" ruleset="r")
ruleset(name="r") {
    set $.tmp = "hello";
    set $!st = "type-a";
    reset $.tmp = "world";
    unset $!st;
}
`);
    const r = simulate({
      model,
      lookupTables: {},
      message: { transport: 'udp', port: 514 } as SyslogMessage
    });
    expect(r.finalState.localVars.tmp).toBe('world');
    expect(r.finalState.structured.st).toBeUndefined();
    const types = r.trace.map((t) => t.type);
    expect(types).toContain('set');
    expect(types).toContain('reset');
    expect(types).toContain('unset');
  });

  it('lookup hit and miss with rsyslog-native format', async () => {
    const tmp = withLookupFiles({
      'lookups/types.json': JSON.stringify({
        version: 1,
        nomatch: 'syslog',
        type: 'string',
        table: [{ index: 'firewall', value: 'pan:traffic' }]
      })
    });
    try {
      const model = buildFrom(`
input(type="imudp" port="514" ruleset="r")
lookup_table(name="types" file="lookups/types.json")
ruleset(name="r") {
    set $!sourcetype = lookup("types", $programname);
    action(type="omfile" File="/x")
}
`);
      const { data: lookupTables } = await loadLookupTables(
        model.lookupTables,
        new NodeVFS(tmp.root)
      );
      const hit = simulate({
        model,
        lookupTables,
        message: { transport: 'udp', port: 514, programname: 'firewall' } as SyslogMessage
      });
      expect(hit.finalState.structured.sourcetype).toBe('pan:traffic');
      const miss = simulate({
        model,
        lookupTables,
        message: { transport: 'udp', port: 514, programname: 'unknown' } as SyslogMessage
      });
      expect(miss.finalState.structured.sourcetype).toBe('syslog');
      const lookupEvents = miss.trace.filter((t) => t.type === 'lookup');
      expect(lookupEvents.length).toBeGreaterThan(0);
    } finally {
      tmp.cleanup();
    }
  });

  it('stop terminates ruleset evaluation', () => {
    const model = buildFrom(`
input(type="imudp" port="514" ruleset="r")
ruleset(name="r") {
    action(type="omfile" File="/a")
    stop
    action(type="omfile" File="/never")
}
`);
    const r = simulate({
      model,
      lookupTables: {},
      message: { transport: 'udp', port: 514 } as SyslogMessage
    });
    expect(r.finalState.stopped).toBe(true);
    expect(r.finalState.outputs.map((o) => o.path)).toEqual(['/a']);
  });

  it('resolves DynaFile template with property substitution', () => {
    const model = buildFrom(`
input(type="imudp" port="514" ruleset="r")
template(name="dyna" type="string" string="/var/log/%hostname%/%programname%.log")
ruleset(name="r") {
    action(type="omfile" DynaFile="dyna")
}
`);
    const r = simulate({
      model,
      lookupTables: {},
      message: {
        transport: 'udp',
        port: 514,
        hostname: 'host1',
        programname: 'sshd'
      } as SyslogMessage
    });
    expect(r.finalState.outputs[0].path).toBe('/var/log/host1/sshd.log');
    expect(r.finalState.outputs[0].template).toBe('dyna');
  });

  it('omfwd emits target/port/protocol output', () => {
    const model = buildFrom(`
input(type="imudp" port="514" ruleset="r")
ruleset(name="r") {
    action(type="omfwd" Target="splunk.example.net" Port="6514" Protocol="tcp")
}
`);
    const r = simulate({
      model,
      lookupTables: {},
      message: { transport: 'udp', port: 514 } as SyslogMessage
    });
    expect(r.finalState.outputs[0].kind).toBe('omfwd');
    expect(r.finalState.outputs[0].target).toBe('splunk.example.net');
    expect(r.finalState.outputs[0].port).toBe(6514);
    expect(r.finalState.outputs[0].protocol).toBe('tcp');
  });

  it('startswith_i with array RHS matches any element', () => {
    const model = buildFrom(`
input(type="imudp" port="514" ruleset="r")
ruleset(name="r") {
    if $programname startswith_i ["SSHD","SUDO"] then {
        action(type="omfile" File="/secure")
    } else {
        action(type="omfile" File="/other")
    }
}
`);
    const r = simulate({
      model,
      lookupTables: {},
      message: { transport: 'udp', port: 514, programname: 'sshd' } as SyslogMessage
    });
    expect(r.finalState.outputs[0].path).toBe('/secure');
  });

  it('call descends into named ruleset', () => {
    const model = buildFrom(`
input(type="imudp" port="514" ruleset="r")
ruleset(name="sub") { action(type="omfile" File="/sub") }
ruleset(name="r") {
    call sub
    action(type="omfile" File="/after")
}
`);
    const r = simulate({
      model,
      lookupTables: {},
      message: { transport: 'udp', port: 514 } as SyslogMessage
    });
    expect(r.finalState.outputs.map((o) => o.path)).toEqual(['/sub', '/after']);
  });
});
