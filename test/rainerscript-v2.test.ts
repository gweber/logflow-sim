import { describe, it, expect } from 'vitest';
import { parse, buildIR } from '../src/core/dialects/rsyslog/index.js';
import { simulate } from '../src/core/simulate/evaluator.js';
import type { SyslogMessage } from '../src/core/simulate/syslog-message.js';

function buildFrom(src: string) {
  const ast = parse({ path: 'main.conf', content: src }).ast;
  return buildIR([ast]);
}

const baseMsg = (extra: Partial<SyslogMessage> = {}): SyslogMessage => ({
  transport: 'udp',
  port: 514,
  fromhost: 'h1',
  hostname: 'h1',
  programname: 'app',
  msg: 'hello',
  rawmsg: '<134>app: hello',
  myhostname: 'sim-host',
  ...extra
});

describe('eq / ne keyword operators', () => {
  it('eq behaves like ==', () => {
    const model = buildFrom(`
input(type="imudp" port="514" ruleset="r")
ruleset(name="r") {
    if $programname eq "app" then { action(type="omfile" File="/match") }
    else { action(type="omfile" File="/nomatch") }
}`);
    const r = simulate({ model, lookupTables: {}, message: baseMsg() });
    expect(r.finalState.outputs[0].path).toBe('/match');
  });

  it('ne behaves like !=', () => {
    const model = buildFrom(`
input(type="imudp" port="514" ruleset="r")
ruleset(name="r") {
    if $programname ne "other" then { action(type="omfile" File="/match") }
}`);
    const r = simulate({ model, lookupTables: {}, message: baseMsg() });
    expect(r.finalState.outputs[0].path).toBe('/match');
  });
});

describe('=~ / !~ regex match operators', () => {
  it('=~ matches when the pattern hits', () => {
    const model = buildFrom(`
input(type="imudp" port="514" ruleset="r")
ruleset(name="r") {
    if $msg =~ "deadbeef\\\\d+" then { action(type="omfile" File="/hit") }
    else { action(type="omfile" File="/miss") }
}`);
    const r = simulate({
      model,
      lookupTables: {},
      message: baseMsg({ msg: 'see deadbeef42 in the wild' })
    });
    expect(r.finalState.outputs[0].path).toBe('/hit');
  });

  it('!~ inverts the match', () => {
    const model = buildFrom(`
input(type="imudp" port="514" ruleset="r")
ruleset(name="r") {
    if $msg !~ "ERROR" then { action(type="omfile" File="/clean") }
    else { action(type="omfile" File="/dirty") }
}`);
    const r = simulate({
      model,
      lookupTables: {},
      message: baseMsg({ msg: 'all is well' })
    });
    expect(r.finalState.outputs[0].path).toBe('/clean');
  });
});

describe('re_match / re_extract / replace / wrap / field functions', () => {
  it('re_match returns boolean', () => {
    const model = buildFrom(`
input(type="imudp" port="514" ruleset="r")
ruleset(name="r") {
    if re_match($msg, "^\\\\d+:") then { action(type="omfile" File="/yes") }
    else { action(type="omfile" File="/no") }
}`);
    const r = simulate({
      model,
      lookupTables: {},
      message: baseMsg({ msg: '42: a numeric prefix' })
    });
    expect(r.finalState.outputs[0].path).toBe('/yes');
  });

  it('re_extract returns the requested capture group', () => {
    const model = buildFrom(`
input(type="imudp" port="514" ruleset="r")
ruleset(name="r") {
    set $!user = re_extract($msg, "user=(\\\\w+)", 0, 1, "anon");
    action(type="omfile" File="/x")
}`);
    const r = simulate({
      model,
      lookupTables: {},
      message: baseMsg({ msg: 'login user=alice from 10.0.0.1' })
    });
    expect(r.finalState.structured.user).toBe('alice');
  });

  it('replace, wrap, field work on strings', () => {
    const model = buildFrom(`
input(type="imudp" port="514" ruleset="r")
ruleset(name="r") {
    set $!a = replace($msg, "a", "X");
    set $!b = wrap($programname, "[", "]");
    set $!c = field($msg, "/", 2);
    action(type="omfile" File="/x")
}`);
    const r = simulate({
      model,
      lookupTables: {},
      message: baseMsg({ msg: 'aa/bb/cc' })
    });
    expect(r.finalState.structured.a).toBe('XX/bb/cc');
    expect(r.finalState.structured.b).toBe('[app]');
    expect(r.finalState.structured.c).toBe('bb');
  });
});

describe('prifilt()', () => {
  it('matches by exact severity', () => {
    const model = buildFrom(`
input(type="imudp" port="514" ruleset="r")
ruleset(name="r") {
    if prifilt("mail.=warning") then { action(type="omfile" File="/warn") }
    else { action(type="omfile" File="/other") }
}`);
    // PRI 20 = facility 2 (mail) severity 4 (warning)
    const r = simulate({
      model,
      lookupTables: {},
      message: baseMsg({ rawmsg: '<20>postfix: queued' })
    });
    expect(r.finalState.outputs[0].path).toBe('/warn');
  });

  it('threshold form ".info" matches info-and-higher', () => {
    const model = buildFrom(`
input(type="imudp" port="514" ruleset="r")
ruleset(name="r") {
    if prifilt("*.info") then { action(type="omfile" File="/info") }
}`);
    // <134> = facility 16 severity 6 (info) → matches "info-or-higher"
    const r = simulate({
      model,
      lookupTables: {},
      message: baseMsg({ rawmsg: '<134>app: hi' })
    });
    expect(r.finalState.outputs[0].path).toBe('/info');
  });

  it('".none" excludes a facility', () => {
    const model = buildFrom(`
input(type="imudp" port="514" ruleset="r")
ruleset(name="r") {
    if prifilt("*.info;mail.none") then { action(type="omfile" File="/in") }
    else { action(type="omfile" File="/out") }
}`);
    // mail facility 2 severity info → excluded by mail.none
    const r = simulate({
      model,
      lookupTables: {},
      message: baseMsg({ rawmsg: '<22>postfix: routed' })
    });
    expect(r.finalState.outputs[0].path).toBe('/out');
  });
});

describe('property modifiers in expressions', () => {
  it('substring modifier works in conditions', () => {
    const model = buildFrom(`
input(type="imudp" port="514" ruleset="r")
ruleset(name="r") {
    if $msg:1,5 == "ERROR" then { action(type="omfile" File="/err") }
    else { action(type="omfile" File="/ok") }
}`);
    const r1 = simulate({
      model,
      lookupTables: {},
      message: baseMsg({ msg: 'ERROR: disk full' })
    });
    expect(r1.finalState.outputs[0].path).toBe('/err');
    const r2 = simulate({
      model,
      lookupTables: {},
      message: baseMsg({ msg: 'normal log line' })
    });
    expect(r2.finalState.outputs[0].path).toBe('/ok');
  });

  it(':::lowercase modifier works in conditions', () => {
    const model = buildFrom(`
input(type="imudp" port="514" ruleset="r")
ruleset(name="r") {
    if $hostname:::lowercase == "host1" then { action(type="omfile" File="/m") }
}`);
    const r = simulate({
      model,
      lookupTables: {},
      message: baseMsg({ hostname: 'HOST1' })
    });
    expect(r.finalState.outputs[0].path).toBe('/m');
  });

  it('regex-extract modifier works in conditions', () => {
    // Property-modifier text in expressions is taken verbatim from source
    // (no string-decoding step), so only one level of backslash escaping is
    // needed compared to template strings.
    const model = buildFrom(`
input(type="imudp" port="514" ruleset="r")
ruleset(name="r") {
    set $!user = $msg:R,ERE,1,FIELD:user=(\\w+)--end;
    action(type="omfile" File="/x")
}`);
    const r = simulate({
      model,
      lookupTables: {},
      message: baseMsg({ msg: 'login user=bob' })
    });
    expect(r.finalState.structured.user).toBe('bob');
  });
});

describe('list templates', () => {
  it('renders constant() and property() parts in order', () => {
    const model = buildFrom(`
input(type="imudp" port="514" ruleset="r")
template(name="payload" type="list") {
    constant(value="[")
    property(name="hostname")
    constant(value="] ")
    property(name="programname")
    constant(value=": ")
    property(name="msg")
}
ruleset(name="r") {
    action(type="omfile" DynaFile="payload")
}`);
    const r = simulate({
      model,
      lookupTables: {},
      message: baseMsg({ hostname: 'h1', programname: 'sshd', msg: 'login' })
    });
    expect(r.finalState.outputs[0].path).toBe('[h1] sshd: login');
  });
});

describe('mmjsonparse', () => {
  it('merges @cee-prefixed JSON into $!structured', () => {
    const model = buildFrom(`
input(type="imudp" port="514" ruleset="r")
ruleset(name="r") {
    action(type="mmjsonparse")
    action(type="omfile" File="/x")
}`);
    const r = simulate({
      model,
      lookupTables: {},
      message: baseMsg({
        msg: '@cee:{"user":"alice","action":"login","success":true}'
      })
    });
    expect(r.finalState.structured.user).toBe('alice');
    expect(r.finalState.structured.action).toBe('login');
    expect(r.finalState.structured.success).toBe('true');
  });

  it('plain JSON (no @cee: cookie) also parses', () => {
    const model = buildFrom(`
input(type="imudp" port="514" ruleset="r")
ruleset(name="r") {
    action(type="mmjsonparse" cookie="")
    action(type="omfile" File="/x")
}`);
    const r = simulate({
      model,
      lookupTables: {},
      message: baseMsg({ msg: '{"foo":"bar"}' })
    });
    expect(r.finalState.structured.foo).toBe('bar');
  });

  it('non-JSON input is left untouched (parsesuccess=FAIL)', () => {
    const model = buildFrom(`
input(type="imudp" port="514" ruleset="r")
ruleset(name="r") {
    action(type="mmjsonparse")
    action(type="omfile" File="/x")
}`);
    const r = simulate({
      model,
      lookupTables: {},
      message: baseMsg({ msg: 'plain text not json' })
    });
    expect(r.finalState.structured.user).toBeUndefined();
  });
});

describe('legacy BSD selectors', () => {
  it('routes mail.* to its file under the implicit default ruleset', () => {
    const model = buildFrom(`
mail.*  /var/log/mail.log
`);
    expect(model.globals.defaultRuleset).toBe('_default_legacy');
    const r = simulate({
      model,
      lookupTables: {},
      message: baseMsg({ rawmsg: '<22>postfix: routed' })
    });
    expect(r.finalState.outputs[0].kind).toBe('omfile');
    expect(r.finalState.outputs[0].path).toBe('/var/log/mail.log');
  });

  it('selectors at @host become omfwd UDP, @@host become omfwd TCP', () => {
    const model = buildFrom(`
*.info     @udphost.example.net:5140
mail.warn  @@tcphost.example.net:6514
`);
    const r1 = simulate({
      model,
      lookupTables: {},
      message: baseMsg({ rawmsg: '<134>app: hi' })
    });
    const udp = r1.finalState.outputs.find((o) => o.target?.startsWith('udphost'));
    expect(udp?.kind).toBe('omfwd');
    expect(udp?.protocol).toBe('udp');

    const r2 = simulate({
      model,
      lookupTables: {},
      message: baseMsg({ rawmsg: '<20>postfix: warn' })
    });
    const tcp = r2.finalState.outputs.find((o) => o.target?.startsWith('tcphost'));
    expect(tcp?.kind).toBe('omfwd');
    expect(tcp?.protocol).toBe('tcp');
  });

  it('~ target drops the message', () => {
    const model = buildFrom(`
local7.*  ~
*.info    /var/log/messages
`);
    // Use facility 23 (local7) — should be discarded
    const r = simulate({
      model,
      lookupTables: {},
      message: baseMsg({ rawmsg: '<190>local7msg: x' })
    });
    expect(r.finalState.stopped).toBe(true);
    expect(r.finalState.outputs.length).toBe(0);
  });
});
