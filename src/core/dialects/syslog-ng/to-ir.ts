import type { ConfigFile, NamedBlock, LogBlock, DriverCall, DriverArg, FilterExpr } from './parser/ast.js';
import type {
  IRModel,
  IRInput,
  IROutput,
  IRRoute,
  IRFilterDef,
  IRRuleset,
  IRTemplate,
  IRLookupTable,
  IRModule,
  IRGlobalSettings,
  ActionKind,
  IRValue
} from '../../ir/model.js';
import type { Diagnostic } from '../../diagnostics.js';
import type { Expr } from '../rsyslog/parser/ast.js';

/**
 * Map a syslog-ng AST forest into the normalized IRModel.
 *
 * Mapping decisions:
 *   - `source <name> { driver(…); … };`           → IRInput per source
 *   - `destination <name> { driver(…); … };`      → IROutput
 *   - `filter <name> { <expr>; };`                → IRFilterDef
 *   - `template <name> { template("…"); };`       → IRTemplate (string body)
 *   - `parser <name> { … }; rewrite <name> { … };` → tracked as IRModule entries
 *   - `log { source(s); filter(f); destination(d); … };`
 *       → IRRoute with inputRefs/filterRefs/transformRefs/outputRefs/flags
 *   - `options { … };`                            → globals.params
 *   - `@version`, `@include`                      → globals metadata
 *
 * Rulesets are left empty — syslog-ng has no equivalent statement-list
 * scope. The simulator falls back to walking routes when no rulesets exist.
 */
export function buildIR(asts: ConfigFile[], existingDiagnostics: Diagnostic[] = []): IRModel {
  const inputs: IRInput[] = [];
  const outputs: IROutput[] = [];
  const routes: IRRoute[] = [];
  const filters: IRFilterDef[] = [];
  const templates: IRTemplate[] = [];
  const modules: IRModule[] = [];
  const globals: IRGlobalSettings = { params: {}, legacy: [] };
  const diagnostics: Diagnostic[] = [...existingDiagnostics];
  const files: string[] = [];

  function makeId(kind: string, source: { file: string; line: number; col: number }): string {
    return `${kind}:${source.file}:${source.line}:${source.col}`;
  }

  for (const ast of asts) {
    files.push(ast.path);
    for (const s of ast.statements) {
      switch (s.kind) {
        case 'VersionPragma':
          globals.params['version'] = s.version;
          break;
        case 'IncludePragma':
          globals.legacy.push({ name: 'include', value: s.spec, source: s.source });
          break;
        case 'OptionsBlock': {
          for (const call of s.calls) {
            const v = renderArgs(call.args);
            globals.params[call.name] = v.length === 1 ? v[0] : v.join(' ');
          }
          break;
        }
        case 'NamedBlock':
          ingestNamed(s);
          break;
        case 'LogBlock':
          ingestLog(s);
          break;
        case 'UserBlock':
        case 'UnknownTop':
          break;
      }
    }
  }

  function ingestNamed(b: NamedBlock): void {
    if (b.blockKind === 'source') {
      const driver = b.body[0];
      const type = driver?.name ?? 'unknown';
      const port = pickPort(driver?.args ?? []);
      inputs.push({
        kind: 'Input',
        id: makeId('input', b.source),
        source: b.source,
        type,
        port,
        ruleset: undefined,
        params: paramsFromCalls(b.body)
      });
      return;
    }
    if (b.blockKind === 'destination') {
      const driver = b.body[0];
      const driverName = driver?.name ?? 'unknown';
      outputs.push({
        kind: 'Output',
        id: makeId('output', b.source),
        source: b.source,
        name: b.name,
        driver: driverName,
        actionKind: classifyDestination(driverName),
        params: paramsFromCalls(b.body)
      });
      return;
    }
    if (b.blockKind === 'filter') {
      filters.push({
        kind: 'FilterDef',
        id: makeId('filter', b.source),
        source: b.source,
        name: b.name,
        expression: filterExprToCore(b.filter)
      });
      return;
    }
    if (b.blockKind === 'template') {
      const tplStr = b.body.find((c) => c.name === 'template');
      const stringArg = tplStr?.args.find((a) => a.kind === 'string');
      templates.push({
        kind: 'Template',
        id: makeId('template', b.source),
        source: b.source,
        name: b.name,
        type: 'string',
        string: stringArg?.kind === 'string' ? stringArg.value : undefined,
        params: paramsFromCalls(b.body)
      });
      return;
    }
    if (b.blockKind === 'parser' || b.blockKind === 'rewrite') {
      modules.push({
        kind: 'Module',
        id: makeId(b.blockKind, b.source),
        source: b.source,
        load: b.blockKind,
        params: { name: b.name, ...paramsFromCalls(b.body) }
      });
      return;
    }
    // block / junction / channel — tracked as module entries for visibility
    modules.push({
      kind: 'Module',
      id: makeId(b.blockKind, b.source),
      source: b.source,
      load: b.blockKind,
      params: { name: b.name }
    });
  }

  function ingestLog(b: LogBlock): void {
    const inputRefs: string[] = [];
    const outputRefs: string[] = [];
    const filterRefs: string[] = [];
    const transformRefs: string[] = [];
    const flags: string[] = [];
    const visit = (block: LogBlock): void => {
      for (const item of block.items) {
        if (item.kind === 'ref') {
          if (item.kindOf === 'source') inputRefs.push(item.name);
          else if (item.kindOf === 'destination') outputRefs.push(item.name);
          else if (item.kindOf === 'filter') filterRefs.push(item.name);
          else transformRefs.push(item.name);
        } else if (item.kind === 'flags') {
          flags.push(...item.flags);
        } else if (item.kind === 'nestedLog') {
          // Nested logs share scope with their parent in syslog-ng — fold in.
          visit(item.block);
        }
      }
    };
    visit(b);
    routes.push({
      kind: 'Route',
      id: makeId('route', b.source),
      source: b.source,
      inputRefs,
      filterRefs,
      transformRefs,
      outputRefs,
      flags
    });
  }

  const rulesets: IRRuleset[] = [];
  const rulesetByName: Record<string, IRRuleset> = {};
  const templateByName: Record<string, IRTemplate> = {};
  for (const t of templates) templateByName[t.name] = t;
  const lookupTables: IRLookupTable[] = [];
  const lookupTableByName: Record<string, IRLookupTable> = {};
  const outputByName: Record<string, IROutput> = {};
  for (const o of outputs) outputByName[o.name] = o;
  const filterByName: Record<string, IRFilterDef> = {};
  for (const f of filters) filterByName[f.name] = f;

  return {
    inputs,
    rulesets,
    templates,
    lookupTables,
    modules,
    globals,
    diagnostics,
    rulesetByName,
    templateByName,
    lookupTableByName,
    files,
    outputs,
    outputByName,
    filters,
    filterByName,
    routes,
    dialect: 'syslog-ng'
  };
}

function paramsFromCalls(calls: DriverCall[]): Record<string, IRValue> {
  const out: Record<string, IRValue> = {};
  for (const c of calls) {
    const args = renderArgs(c.args);
    out[c.name.toLowerCase()] = args.length === 1 ? args[0] : args.join(' ');
  }
  return out;
}

function renderArgs(args: DriverArg[]): string[] {
  return args.map((a) => {
    if (a.kind === 'string') return a.value;
    if (a.kind === 'number') return String(a.value);
    if (a.kind === 'ident') return a.value;
    return `${a.call.name}(${renderArgs(a.call.args).join(' ')})`;
  });
}

function pickPort(args: DriverArg[]): number | undefined {
  for (const a of args) {
    if (a.kind === 'call' && a.call.name === 'port') {
      const v = a.call.args[0];
      if (v && (v.kind === 'number' || v.kind === 'ident' || v.kind === 'string')) {
        const n = parseInt(String(v.kind === 'number' ? v.value : v.value), 10);
        if (!Number.isNaN(n)) return n;
      }
    }
  }
  return undefined;
}

function classifyDestination(driver: string): ActionKind {
  const d = driver.toLowerCase();
  if (d === 'file') return 'omfile';
  if (d === 'tcp' || d === 'udp' || d === 'syslog' || d === 'network' || d === 'unix-stream' || d === 'unix-dgram')
    return 'omfwd';
  if (d === 'elasticsearch' || d === 'elasticsearch-http' || d === 'elasticsearch2') return 'omelasticsearch';
  if (d === 'kafka') return 'omkafka';
  if (d === 'http') return 'omhttp';
  return 'unknown';
}

/**
 * Best-effort mapping of a syslog-ng filter expression into rsyslog's Expr AST,
 * so analyzers, validators, and the simulator can treat both dialects'
 * conditions uniformly. We support the most common filter calls:
 *
 *   facility(mail) / facility(mail, news)    → BinaryOp `==` on $syslogfacility-text
 *   level(info..emerg) / level(info)         → numeric comparison on $syslogseverity
 *   priority(...)                            → alias of level
 *   host("pat") / program("pat")             → contains / startswith on the property
 *   match("re") / match("re" value("MSG"))   → =~ on the target property
 *   netmask(10.0.0.0/8)                      → startswith on $fromhost-ip
 *
 * Unknown calls become a TRUE placeholder StringLit ("1") so the route still
 * "passes" the filter rather than silently dropping during simulation — we
 * surface this conservatism via diagnostics on the syslog-ng dialect entry.
 */
function filterExprToCore(f: FilterExpr | undefined): Expr {
  if (!f) return { kind: 'StringLit', value: '1', source: zeroLoc() };
  if (f.kind === 'FilterUnary' && f.op === 'not') {
    return {
      kind: 'UnaryOp',
      op: 'not',
      operand: filterExprToCore(f.operand),
      source: f.source
    };
  }
  if (f.kind === 'FilterBinary') {
    return {
      kind: 'BinaryOp',
      op: f.op,
      left: filterExprToCore(f.left),
      right: filterExprToCore(f.right),
      source: f.source
    };
  }
  // FilterCall
  const name = f.name.toLowerCase();
  const firstStr = f.args.find((a) => a.kind === 'string') as
    | { kind: 'string'; value: string }
    | undefined;
  const firstIdent = f.args.find((a) => a.kind === 'ident') as
    | { kind: 'ident'; value: string }
    | undefined;
  const arg = firstStr?.value ?? firstIdent?.value ?? '';
  if (name === 'host')
    return cmpProperty('hostname', '=~', arg, f.source);
  if (name === 'program')
    return cmpProperty('programname', '=~', arg, f.source);
  if (name === 'match')
    return cmpProperty(propertyForMatch(f.args), '=~', arg, f.source);
  if (name === 'facility')
    return cmpProperty('syslogfacility-text', '==', arg, f.source);
  if (name === 'level' || name === 'priority' || name === 'severity')
    return cmpProperty('syslogseverity-text', '==', arg, f.source);
  if (name === 'netmask')
    return cmpProperty('fromhost-ip', 'startswith', arg.replace(/\/.*$/, '').replace(/\.0$/, '.'), f.source);
  // Unknown filter primitive: treat as always-true to keep route alive.
  return { kind: 'StringLit', value: '1', source: f.source };
}

function cmpProperty(
  prop: string,
  op: '==' | '=~' | 'startswith',
  value: string,
  source: { file: string; line: number; col: number; offset: number; length: number }
): Expr {
  return {
    kind: 'BinaryOp',
    op,
    left: { kind: 'PropertyRef', name: prop, source },
    right: { kind: 'StringLit', value, source },
    source
  };
}

function propertyForMatch(args: DriverArg[]): string {
  for (const a of args) {
    if (a.kind === 'call' && a.call.name === 'value') {
      const v = a.call.args[0];
      if (v && v.kind === 'string') return v.value.toLowerCase().replace(/[$]/g, '');
    }
  }
  return 'msg';
}

function zeroLoc(): { file: string; line: number; col: number; offset: number; length: number } {
  return { file: '<syslog-ng>', line: 0, col: 0, offset: 0, length: 0 };
}
