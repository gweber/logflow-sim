import { describe, it, expect } from 'vitest';
import { parse } from '../src/core/dialects/rsyslog/index.js';
import { buildIR } from '../src/core/dialects/rsyslog/index.js';
import { simulate } from '../src/core/simulate/evaluator.js';
import type { SyslogMessage } from '../src/core/simulate/syslog-message.js';

function buildFrom(src: string) {
  const ast = parse({ path: 'main.conf', content: src }).ast;
  return buildIR([ast]);
}

// Fixed simulation time: 2026-03-04 09:08:07 (local TZ).
const SIM_TIME = new Date(2026, 2, 4, 9, 8, 7).getTime();

const baseMsg = (extra: Partial<SyslogMessage> = {}): SyslogMessage => ({
  transport: 'udp',
  port: 514,
  fromhost: 'host1',
  fromhostIp: '10.0.0.1',
  hostname: 'host1',
  programname: 'app',
  rawmsg: '<134>test',
  msg: 'test',
  simTime: SIM_TIME,
  myhostname: 'rsyslog-test',
  ...extra
});

describe('system time + system properties in templates', () => {
  it('resolves %$YEAR%, %$MONTH%, %$DAY%, %$HOUR%, %$MINUTE%, %$MYHOSTNAME%', () => {
    const model = buildFrom(`
input(type="imudp" port="514" ruleset="r")
template(name="t" type="string"
  string="/var/log/%$MYHOSTNAME%/%hostname%/%$YEAR%-%$MONTH%-%$DAY%-%$HOUR%-%$MINUTE%.log")
ruleset(name="r") { action(type="omfile" DynaFile="t") }
`);
    const r = simulate({ model, lookupTables: {}, message: baseMsg() });
    expect(r.finalState.outputs[0].path).toBe(
      '/var/log/rsyslog-test/host1/2026-03-04-09-08.log'
    );
  });

  it('exposes %pri%, %syslogfacility-text%, %syslogseverity-text%', () => {
    const model = buildFrom(`
input(type="imudp" port="514" ruleset="r")
template(name="t" type="string" string="%pri%|%syslogfacility-text%|%syslogseverity-text%")
ruleset(name="r") { action(type="omfile" File="x") }
`);
    // No DynaFile path to assert; render template directly by simulating and inspecting the
    // trace's resolved omfile path won't show it. Instead expose template via DynaFile:
    const model2 = buildFrom(`
input(type="imudp" port="514" ruleset="r")
template(name="t" type="string" string="%pri%|%syslogfacility-text%|%syslogseverity-text%")
ruleset(name="r") { action(type="omfile" DynaFile="t") }
`);
    const r = simulate({
      model: model2,
      lookupTables: {},
      message: baseMsg({ rawmsg: '<134>boom' })
    });
    // PRI 134 = facility 16 (local0) severity 6 (info)
    expect(r.finalState.outputs[0].path).toBe('134|local0|info');
  });
});

describe('template engine — %!field% and modifiers', () => {
  it('reads $!field via %!name% syntax (no $ prefix in template)', () => {
    const model = buildFrom(`
input(type="imudp" port="514" ruleset="r")
template(name="t" type="string" string="/x/%!host_extracted%.log")
ruleset(name="r") {
    set $!host_extracted = "fw-corp-1";
    action(type="omfile" DynaFile="t")
}
`);
    const r = simulate({ model, lookupTables: {}, message: baseMsg() });
    expect(r.finalState.outputs[0].path).toBe('/x/fw-corp-1.log');
  });

  it('applies :::lowercase and :::uppercase modifiers', () => {
    const model = buildFrom(`
input(type="imudp" port="514" ruleset="r")
template(name="lo" type="string" string="%hostname:::lowercase%")
template(name="up" type="string" string="%hostname:::uppercase%")
ruleset(name="r") {
    action(type="omfile" DynaFile="lo")
    action(type="omfile" DynaFile="up")
}
`);
    const r = simulate({
      model,
      lookupTables: {},
      message: baseMsg({ hostname: 'Host-MIXED' })
    });
    expect(r.finalState.outputs.map((o) => o.path)).toEqual(['host-mixed', 'HOST-MIXED']);
  });

  it('applies substring modifier N,M', () => {
    const model = buildFrom(`
input(type="imudp" port="514" ruleset="r")
template(name="t" type="string" string="%msg:1,5%")
ruleset(name="r") { action(type="omfile" DynaFile="t") }
`);
    const r = simulate({
      model,
      lookupTables: {},
      message: baseMsg({ msg: 'Hello-World' })
    });
    expect(r.finalState.outputs[0].path).toBe('Hello');
  });
});

describe('regex-extract template modifier', () => {
  it('extracts the requested submatch group', () => {
    const model = buildFrom(`
input(type="imudp" port="514" ruleset="r")
template(name="extract" type="string"
  string="%msg:R,ERE,1,FIELD:originsicname=CN=(\\\\w+)--end%")
ruleset(name="r") {
    reset $!host = exec_template("extract");
    action(type="omfile" File="/x")
}
`);
    const r = simulate({
      model,
      lookupTables: {},
      message: baseMsg({ msg: 'noise originsicname=CN=fwcorp7 more noise' })
    });
    expect(r.finalState.structured.host).toBe('fwcorp7');
  });

  it('returns empty string when regex does not match (FIELD onerror)', () => {
    const model = buildFrom(`
input(type="imudp" port="514" ruleset="r")
template(name="extract" type="string"
  string="%msg:R,ERE,1,FIELD:foo=(\\\\w+)--end%")
ruleset(name="r") {
    set $!host = exec_template("extract");
    action(type="omfile" File="/x")
}
`);
    const r = simulate({
      model,
      lookupTables: {},
      message: baseMsg({ msg: 'no match here' })
    });
    expect(r.finalState.structured.host).toBe('');
  });
});

describe('expression functions', () => {
  it('tolower / toupper', () => {
    const model = buildFrom(`
input(type="imudp" port="514" ruleset="r")
ruleset(name="r") {
    set $!lo = tolower($hostname);
    set $!up = toupper($hostname);
    action(type="omfile" File="/x")
}
`);
    const r = simulate({
      model,
      lookupTables: {},
      message: baseMsg({ hostname: 'MixedCase' })
    });
    expect(r.finalState.structured.lo).toBe('mixedcase');
    expect(r.finalState.structured.up).toBe('MIXEDCASE');
  });

  it('exec_template renders a template against the current message', () => {
    const model = buildFrom(`
input(type="imudp" port="514" ruleset="r")
template(name="greet" type="string" string="hi-%hostname%")
ruleset(name="r") {
    set $!g = exec_template("greet");
    action(type="omfile" File="/x")
}
`);
    const r = simulate({
      model,
      lookupTables: {},
      message: baseMsg({ hostname: 'alpha' })
    });
    expect(r.finalState.structured.g).toBe('hi-alpha');
  });
});

describe('& string concatenation', () => {
  it('concatenates strings and properties', () => {
    const model = buildFrom(`
input(type="imudp" port="514" ruleset="r")
ruleset(name="r") {
    set $!c = $hostname & "_" & $programname;
    action(type="omfile" File="/x")
}
`);
    const r = simulate({
      model,
      lookupTables: {},
      message: baseMsg({ hostname: 'h1', programname: 'app1' })
    });
    expect(r.finalState.structured.c).toBe('h1_app1');
  });
});

describe('numeric comparison operators', () => {
  it('< <= > >= work on numeric-looking strings', () => {
    const model = buildFrom(`
input(type="imudp" port="514" ruleset="r")
ruleset(name="r") {
    if $syslogseverity < 4 then {
        action(type="omfile" File="/critical")
    } else {
        action(type="omfile" File="/normal")
    }
}
`);
    const high = simulate({
      model,
      lookupTables: {},
      message: baseMsg({ rawmsg: '<10>uh oh' }) // facility 1 severity 2 (crit)
    });
    expect(high.finalState.outputs[0].path).toBe('/critical');
    const low = simulate({
      model,
      lookupTables: {},
      message: baseMsg({ rawmsg: '<134>fine' }) // severity 6 info
    });
    expect(low.finalState.outputs[0].path).toBe('/normal');
  });
});

describe('continue statement', () => {
  it('parses and traces continue without halting ruleset', () => {
    const model = buildFrom(`
input(type="imudp" port="514" ruleset="r")
ruleset(name="r") {
    if $programname == "foo" then { continue }
    action(type="omfile" File="/after")
}
`);
    const r = simulate({
      model,
      lookupTables: {},
      message: baseMsg({ programname: 'foo' })
    });
    expect(r.finalState.outputs[0].path).toBe('/after');
    expect(r.trace.some((t) => t.message === 'continue')).toBe(true);
  });
});
