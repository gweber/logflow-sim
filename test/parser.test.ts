import { describe, it, expect } from 'vitest';
import { parse } from '../src/core/dialects/rsyslog/index.js';
import { tokenize } from '../src/core/dialects/rsyslog/parser/lexer.js';

function parseSrc(content: string) {
  return parse({ path: 'test.conf', content });
}

describe('lexer', () => {
  it('tokenizes strings with escapes', () => {
    const toks = tokenize('t.conf', 'a = "hello\\"world"');
    const str = toks.find((t) => t.kind === 'STRING')!;
    expect(str.value).toBe('hello"world');
  });

  it('recognizes legacy directives at line start', () => {
    const toks = tokenize('t.conf', '$DefaultRuleset foo\nmodule(load="imudp")');
    expect(toks[0].kind).toBe('LEGACY_DIRECTIVE');
    expect(toks[0].value).toContain('DefaultRuleset');
  });

  it('parses property references inside expression context', () => {
    // `$ident` at line-start would be a legacy directive (e.g. `$Umask 0022`).
    // Real config always uses property refs inside an expression, so we test
    // that shape here.
    const toks = tokenize('t.conf', 'if $msg == $.local then unset $!field; set $.x = $fromhost-ip;');
    const props = toks.filter((t) => t.kind === 'PROP').map((t) => t.value);
    expect(props).toEqual(['$msg', '$.local', '$!field', '$.x', '$fromhost-ip']);
  });

  it('treats $<ident> at line start as a legacy directive', () => {
    const toks = tokenize('t.conf', '$Umask 0022\n$workdirectory /var/spool/rsyslog\n');
    const dirs = toks.filter((t) => t.kind === 'LEGACY_DIRECTIVE').map((t) => t.value);
    expect(dirs).toEqual(['$Umask 0022', '$workdirectory /var/spool/rsyslog']);
  });
});

describe('parser', () => {
  it('parses module/global/input/template/lookup_table/action', () => {
    const src = `
module(load="imudp")
global(workDirectory="/tmp")
input(type="imudp" port="514" ruleset="r1")
template(name="t" type="string" string="/var/log/%hostname%.log")
lookup_table(name="lt" file="t.json" reloadOnHUP="on")
ruleset(name="r1") {
    action(type="omfile" DynaFile="t")
}
`;
    const { ast, diagnostics } = parseSrc(src);
    expect(diagnostics.hasErrors()).toBe(false);
    const kinds = ast.statements.map((s) => s.kind);
    expect(kinds).toContain('ModuleStmt');
    expect(kinds).toContain('GlobalStmt');
    expect(kinds).toContain('InputStmt');
    expect(kinds).toContain('TemplateStmt');
    expect(kinds).toContain('LookupTableStmt');
    expect(kinds).toContain('RulesetStmt');
  });

  it('parses nested if / else if / else', () => {
    const src = `
ruleset(name="r") {
    if $programname == "a" then {
        action(type="omfile" File="/a")
    } else if $programname == "b" then {
        action(type="omfile" File="/b")
    } else {
        action(type="omfile" File="/c")
    }
}
`;
    const { ast, diagnostics } = parseSrc(src);
    expect(diagnostics.hasErrors()).toBe(false);
    const rs = ast.statements.find((s) => s.kind === 'RulesetStmt')!;
    expect(rs.kind).toBe('RulesetStmt');
    if (rs.kind === 'RulesetStmt') {
      const ifs = rs.body[0];
      expect(ifs.kind).toBe('IfStmt');
    }
  });

  it('recognizes legacy BSD selectors as first-class LegacySelectorStmt', () => {
    const src = `
*.info;mail.none /var/log/messages
mail.* -/var/log/mail.log
ruleset(name="r") { }
`;
    const { ast, diagnostics } = parseSrc(src);
    const legacy = ast.statements.filter((s) => s.kind === 'LegacySelectorStmt');
    expect(legacy.length).toBe(2);
    expect(diagnostics.items.some((d) => d.code === 'W_UNKNOWN_STATEMENT')).toBe(false);
  });

  it('preserves truly unknown statements as UnknownNode with a diagnostic', () => {
    const src = `
@@gibberish-not-rsyslog!
ruleset(name="r") { }
`;
    const { ast, diagnostics } = parseSrc(src);
    const unknown = ast.statements.find((s) => s.kind === 'UnknownNode');
    expect(unknown).toBeDefined();
    expect(diagnostics.items.some((d) => d.code === 'W_UNKNOWN_STATEMENT')).toBe(true);
  });

  it('parses startswith_i with array RHS', () => {
    const src = `
ruleset(name="r") {
    if $programname startswith_i ["sshd","sudo"] then {
        action(type="omfile" File="/x")
    }
}
`;
    const { ast, diagnostics } = parseSrc(src);
    expect(diagnostics.hasErrors()).toBe(false);
    const rs = ast.statements[0];
    expect(rs.kind).toBe('RulesetStmt');
  });

  it('attaches accurate source locations', () => {
    const src = `module(load="imudp")\nruleset(name="r") {\n    stop\n}\n`;
    const { ast } = parseSrc(src);
    const ruleset = ast.statements.find((s) => s.kind === 'RulesetStmt')!;
    expect(ruleset.source.file).toBe('test.conf');
    expect(ruleset.source.line).toBe(2);
  });

  it('parses set / unset of $.local and $!field', () => {
    const src = `
ruleset(name="r") {
    set $.tmp = "v";
    set $!sourcetype = lookup("t", $programname);
    unset $.tmp;
}
`;
    const { ast, diagnostics } = parseSrc(src);
    expect(diagnostics.hasErrors()).toBe(false);
    const body = (ast.statements[0] as any).body;
    expect(body[0].kind).toBe('SetStmt');
    expect(body[1].kind).toBe('SetStmt');
    expect(body[2].kind).toBe('UnsetStmt');
  });
});
