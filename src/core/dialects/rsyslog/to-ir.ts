import type {
  ConfigFile,
  Stmt,
  KVParam,
  Expr,
  RulesetStmt,
  ActionStmt,
  InputStmt,
  TemplateStmt,
  LookupTableStmt,
  ModuleStmt,
  GlobalStmt,
  IfStmt,
  SetStmt,
  ResetStmt,
  UnsetStmt
} from './parser/ast.js';
import type {
  IRModel,
  IRInput,
  IRRuleset,
  IRTemplate,
  IRLookupTable,
  IRModule,
  IRStatement,
  IRAction,
  ActionKind,
  IRValue,
  IRGlobalSettings
} from '../../ir/model.js';
import type { Diagnostic } from '../../diagnostics.js';
import type { SourceLoc } from '../../source-map.js';

function paramsToMap(params: KVParam[]): Record<string, IRValue> {
  const out: Record<string, IRValue> = {};
  for (const p of params) {
    out[p.name.toLowerCase()] = exprToValue(p.value);
  }
  return out;
}

function exprToValue(e: Expr): IRValue {
  switch (e.kind) {
    case 'StringLit':
      return e.value;
    case 'NumberLit':
      return e.value;
    case 'ArrayLit':
      return e.elements.map((el) => (el.kind === 'StringLit' ? el.value : ''));
    default:
      return e;
  }
}

function getStr(map: Record<string, IRValue>, key: string): string | undefined {
  const v = map[key.toLowerCase()];
  return typeof v === 'string' ? v : undefined;
}

function getNum(map: Record<string, IRValue>, key: string): number | undefined {
  const v = map[key.toLowerCase()];
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = parseFloat(v);
    if (!Number.isNaN(n)) return n;
  }
  return undefined;
}

function makeId(kind: string, source: { file: string; line: number; col: number }): string {
  return `${kind}:${source.file}:${source.line}:${source.col}`;
}

export function buildIR(asts: ConfigFile[], existingDiagnostics: Diagnostic[] = []): IRModel {
  const inputs: IRInput[] = [];
  const rulesets: IRRuleset[] = [];
  const templates: IRTemplate[] = [];
  const lookupTables: IRLookupTable[] = [];
  const modules: IRModule[] = [];
  const globals: IRGlobalSettings = { params: {}, legacy: [] };
  const diagnostics: Diagnostic[] = [...existingDiagnostics];
  const files: string[] = [];
  const topLevelLegacy: import('./parser/ast.js').LegacySelectorStmt[] = [];
  const topLevelActions: IRAction[] = [];
  const topLevelStatements: IRStatement[] = [];

  for (const ast of asts) {
    files.push(ast.path);
    for (const s of ast.statements) {
      ingestTop(s);
    }
  }

  // Fold every top-level statement (legacy selectors, bare action() calls,
  // top-level if/set/stop/...) into a synthetic "_default_legacy" ruleset.
  // rsyslog's own runtime does the same: the implicit default ruleset runs
  // every statement that wasn't placed inside an explicit `ruleset(...)`.
  const syntheticStmts: IRStatement[] = [
    ...topLevelLegacy.map(
      (s) =>
        ({
          kind: 'LegacySelector' as const,
          id: makeId('legacy_selector', s.source),
          source: s.source,
          facspec: s.facspec,
          target: s.target
        })
    ),
    ...topLevelActions,
    ...topLevelStatements
  ];
  if (syntheticStmts.length > 0) {
    const first = syntheticStmts[0].source;
    const synthetic: IRRuleset = {
      kind: 'Ruleset',
      id: `ruleset:_default_legacy:${first.file}:${first.line}`,
      source: first,
      name: '_default_legacy',
      statements: syntheticStmts,
      params: {}
    };
    rulesets.push(synthetic);
    if (!globals.defaultRuleset) globals.defaultRuleset = '_default_legacy';
  }

  const rulesetByName: Record<string, IRRuleset> = {};
  for (const r of rulesets) rulesetByName[r.name] = r;
  const templateByName: Record<string, IRTemplate> = {};
  for (const t of templates) templateByName[t.name] = t;
  const lookupTableByName: Record<string, IRLookupTable> = {};
  for (const lt of lookupTables) lookupTableByName[lt.name] = lt;

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
    outputs: [],
    outputByName: {},
    filters: [],
    filterByName: {},
    routes: [],
    dialect: 'rsyslog'
  };

  function ingestTop(s: Stmt): void {
    switch (s.kind) {
      case 'ModuleStmt': {
        const params = paramsToMap((s as ModuleStmt).params);
        modules.push({
          kind: 'Module',
          id: makeId('module', s.source),
          source: s.source,
          load: getStr(params, 'load') ?? '',
          params
        });
        return;
      }
      case 'GlobalStmt': {
        Object.assign(globals.params, paramsToMap((s as GlobalStmt).params));
        return;
      }
      case 'MainQueueStmt': {
        globals.params['main_queue'] = JSON.stringify(paramsToMap(s.params));
        return;
      }
      case 'InputStmt': {
        const params = paramsToMap((s as InputStmt).params);
        const port = getNum(params, 'port');
        inputs.push({
          kind: 'Input',
          id: makeId('input', s.source),
          source: s.source,
          type: getStr(params, 'type') ?? '',
          port,
          ruleset: getStr(params, 'ruleset'),
          params
        });
        return;
      }
      case 'TemplateStmt': {
        const tpl = s as TemplateStmt;
        const params = paramsToMap(tpl.params);
        const parts = tpl.body?.map((part) => {
          const partParams = paramsToMap(part.params);
          if (part.kind === 'constant') {
            const v = partParams['value'];
            return { kind: 'constant' as const, value: typeof v === 'string' ? v : '' };
          }
          const nameV = partParams['name'];
          return {
            kind: 'property' as const,
            name: typeof nameV === 'string' ? nameV : ''
          };
        });
        templates.push({
          kind: 'Template',
          id: makeId('template', s.source),
          source: s.source,
          name: getStr(params, 'name') ?? '',
          type: getStr(params, 'type') ?? 'string',
          string: getStr(params, 'string'),
          parts: parts && parts.length ? parts : undefined,
          params
        });
        return;
      }
      case 'LookupTableStmt': {
        const params = paramsToMap((s as LookupTableStmt).params);
        lookupTables.push({
          kind: 'LookupTable',
          id: makeId('lookup_table', s.source),
          source: s.source,
          name: getStr(params, 'name') ?? '',
          file: getStr(params, 'file') ?? '',
          reloadOnHUP: getStr(params, 'reloadonhup') === 'on',
          params
        });
        return;
      }
      case 'RulesetStmt': {
        const params = paramsToMap((s as RulesetStmt).params);
        const name = getStr(params, 'name') ?? '';
        const ir: IRRuleset = {
          kind: 'Ruleset',
          id: makeId('ruleset', s.source),
          source: s.source,
          name,
          statements: s.body.map((b) => buildStatement(b)),
          params
        };
        rulesets.push(ir);
        return;
      }
      case 'LegacyDirective': {
        globals.legacy.push({ name: s.name, value: s.rest, source: s.source });
        if (s.name === 'DefaultRuleset') globals.defaultRuleset = s.rest.trim();
        if (s.name === 'WorkDirectory') globals.workDirectory = s.rest.trim();
        return;
      }
      case 'ActionStmt': {
        // Top-level actions implicitly belong to the default ruleset; rsyslog
        // itself folds them in. We do the same and emit only an info-level
        // record so the user can see where the synthesis happened.
        diagnostics.push({
          severity: 'info',
          message: 'Top-level action() folded into the implicit default ruleset',
          source: s.source,
          code: 'I_TOPLEVEL_ACTION_FOLDED'
        });
        topLevelActions.push(buildStatement(s) as IRAction);
        return;
      }
      case 'IfStmt':
      case 'SetStmt':
      case 'ResetStmt':
      case 'UnsetStmt':
      case 'StopStmt':
      case 'ContinueStmt':
      case 'CallStmt':
      case 'ReloadLookupTableStmt': {
        // Same treatment as bare action(): fold into the default ruleset.
        topLevelStatements.push(buildStatement(s));
        return;
      }
      case 'LegacySelectorStmt': {
        // Top-level legacy selectors implicitly belong to the default ruleset.
        // We stash them in a side-list and fold them in once all top-level
        // statements have been visited (after this for-loop finishes).
        topLevelLegacy.push(s);
        return;
      }
      case 'UnknownNode': {
        // Already reported by parser; nothing to do at IR level.
        return;
      }
      default: {
        // All known statement kinds are explicitly handled above, so reaching
        // this branch means the AST grew a new variant without IR support.
        const unhandled = s as { kind: string; source: SourceLoc };
        diagnostics.push({
          severity: 'info',
          message: `Top-level statement "${unhandled.kind}" ignored at IR build`,
          source: unhandled.source,
          code: 'I_IR_SKIP'
        });
      }
    }
  }

  function buildStatement(s: Stmt): IRStatement {
    switch (s.kind) {
      case 'IfStmt': {
        const ifs = s as IfStmt;
        return {
          kind: 'If',
          id: makeId('if', s.source),
          source: s.source,
          condition: ifs.condition,
          then: ifs.then.map(buildStatement),
          else: ifs.else?.map(buildStatement)
        };
      }
      case 'ActionStmt': {
        const params = paramsToMap((s as ActionStmt).params);
        const t = (getStr(params, 'type') ?? '').toLowerCase();
        const KNOWN_ACTION_KINDS: ActionKind[] = [
          'omfile',
          'omfwd',
          'omelasticsearch',
          'omkafka',
          'omhttp',
          'mmjsonparse'
        ];
        const actionKind: ActionKind =
          (KNOWN_ACTION_KINDS as readonly string[]).includes(t)
            ? (t as ActionKind)
            : 'unknown';
        return {
          kind: 'Action',
          id: makeId('action', s.source),
          source: s.source,
          actionType: getStr(params, 'type') ?? '',
          actionKind,
          params
        };
      }
      case 'SetStmt': {
        const ss = s as SetStmt;
        return {
          kind: 'Set',
          id: makeId('set', s.source),
          source: s.source,
          targetKind: ss.target.kind === 'LocalVarRef' ? 'local' : 'structured',
          targetName: ss.target.name,
          value: ss.value
        };
      }
      case 'ResetStmt': {
        const ss = s as ResetStmt;
        return {
          kind: 'Reset',
          id: makeId('reset', s.source),
          source: s.source,
          targetKind: ss.target.kind === 'LocalVarRef' ? 'local' : 'structured',
          targetName: ss.target.name,
          value: ss.value
        };
      }
      case 'UnsetStmt': {
        const ss = s as UnsetStmt;
        return {
          kind: 'Unset',
          id: makeId('unset', s.source),
          source: s.source,
          targetKind: ss.target.kind === 'LocalVarRef' ? 'local' : 'structured',
          targetName: ss.target.name
        };
      }
      case 'StopStmt':
        return { kind: 'Stop', id: makeId('stop', s.source), source: s.source };
      case 'ContinueStmt':
        return { kind: 'Continue', id: makeId('continue', s.source), source: s.source };
      case 'CallStmt':
        return {
          kind: 'Call',
          id: makeId('call', s.source),
          source: s.source,
          ruleset: s.ruleset
        };
      case 'ReloadLookupTableStmt':
        return {
          kind: 'ReloadLookupTable',
          id: makeId('reload_lookup_table', s.source),
          source: s.source,
          table: s.table
        };
      default:
        return {
          kind: 'Unknown',
          id: makeId('unknown', s.source),
          source: s.source,
          raw: 'raw' in s ? (s as { raw: string }).raw : `<${s.kind}>`
        };
    }
  }
}
