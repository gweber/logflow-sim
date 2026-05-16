import type { SourceLoc } from '../../../source-map.js';

export interface NodeBase {
  source: SourceLoc;
}

// ---------- Expressions ----------

export type Expr =
  | StringLit
  | NumberLit
  | ArrayLit
  | PropertyRef
  | LocalVarRef
  | StructuredRef
  | LookupCall
  | CallExpr
  | UnaryOp
  | BinaryOp
  | ParenExpr;

export interface StringLit extends NodeBase {
  kind: 'StringLit';
  value: string;
}

export interface NumberLit extends NodeBase {
  kind: 'NumberLit';
  value: number;
}

export interface ArrayLit extends NodeBase {
  kind: 'ArrayLit';
  elements: Expr[];
}

/** $msg, $hostname, $fromhost, $fromhost-ip, $programname, $syslogtag, $rawmsg, $inputname, ... */
export interface PropertyRef extends NodeBase {
  kind: 'PropertyRef';
  name: string; // without leading $
}

/** $.localvar */
export interface LocalVarRef extends NodeBase {
  kind: 'LocalVarRef';
  name: string; // without leading $.
}

/** $!field (structured data / JSON properties) */
export interface StructuredRef extends NodeBase {
  kind: 'StructuredRef';
  name: string; // without leading $!
}

export interface LookupCall extends NodeBase {
  kind: 'LookupCall';
  table: Expr;
  key: Expr;
}

export interface CallExpr extends NodeBase {
  kind: 'CallExpr';
  callee: string;
  args: Expr[];
}

export interface UnaryOp extends NodeBase {
  kind: 'UnaryOp';
  op: 'not' | '-';
  operand: Expr;
}

export type BinaryOperator =
  | '=='
  | '!='
  | '<'
  | '<='
  | '>'
  | '>='
  | '&'
  | '+'
  | '-'
  | '*'
  | '/'
  | '%'
  | '=~'
  | '!~'
  | 'and'
  | 'or'
  | 'contains'
  | 'contains_i'
  | 'startswith'
  | 'startswith_i';

export interface BinaryOp extends NodeBase {
  kind: 'BinaryOp';
  op: BinaryOperator;
  left: Expr;
  right: Expr;
}

export interface ParenExpr extends NodeBase {
  kind: 'ParenExpr';
  inner: Expr;
}

// ---------- Statements ----------

export type Stmt =
  | ModuleStmt
  | GlobalStmt
  | MainQueueStmt
  | InputStmt
  | RulesetStmt
  | TemplateStmt
  | LookupTableStmt
  | ReloadLookupTableStmt
  | ActionStmt
  | IfStmt
  | SetStmt
  | ResetStmt
  | UnsetStmt
  | StopStmt
  | ContinueStmt
  | LegacySelectorStmt
  | CallStmt
  | LegacyDirective
  | UnknownNode;

export interface KVParam extends NodeBase {
  name: string;
  value: Expr;
}

export interface ModuleStmt extends NodeBase {
  kind: 'ModuleStmt';
  params: KVParam[];
}
export interface GlobalStmt extends NodeBase {
  kind: 'GlobalStmt';
  params: KVParam[];
}
export interface MainQueueStmt extends NodeBase {
  kind: 'MainQueueStmt';
  params: KVParam[];
}
export interface InputStmt extends NodeBase {
  kind: 'InputStmt';
  params: KVParam[];
}
export interface TemplateStmt extends NodeBase {
  kind: 'TemplateStmt';
  params: KVParam[];
  /**
   * Body parts for `type="list"` templates:
   *   template(name="x" type="list") {
   *     constant(value="hi-")
   *     property(name="hostname" position.from="1" position.to="5")
   *   }
   * Each entry is the captured params of the inner call. Empty when the
   * template uses the `string=` form.
   */
  body?: { kind: 'constant' | 'property'; params: KVParam[]; source: SourceLoc }[];
}
export interface LookupTableStmt extends NodeBase {
  kind: 'LookupTableStmt';
  params: KVParam[];
}
export interface ReloadLookupTableStmt extends NodeBase {
  kind: 'ReloadLookupTableStmt';
  table: string;
}
export interface ActionStmt extends NodeBase {
  kind: 'ActionStmt';
  params: KVParam[];
}
export interface RulesetStmt extends NodeBase {
  kind: 'RulesetStmt';
  params: KVParam[];
  body: Stmt[];
}
export interface IfStmt extends NodeBase {
  kind: 'IfStmt';
  condition: Expr;
  then: Stmt[];
  /** Each else-if turns into a nested IfStmt inside else. */
  else?: Stmt[];
}
export interface SetStmt extends NodeBase {
  kind: 'SetStmt';
  target: LocalVarRef | StructuredRef;
  value: Expr;
}
export interface ResetStmt extends NodeBase {
  kind: 'ResetStmt';
  target: LocalVarRef | StructuredRef;
  value: Expr;
}
export interface UnsetStmt extends NodeBase {
  kind: 'UnsetStmt';
  target: LocalVarRef | StructuredRef;
}
export interface StopStmt extends NodeBase {
  kind: 'StopStmt';
}
export interface ContinueStmt extends NodeBase {
  kind: 'ContinueStmt';
}

/**
 * Legacy BSD-syslog selector (sysklogd-style) preserved at top level.
 * Example: `*.info;mail.none /var/log/messages`
 *
 * `facspec` is the part before the first whitespace block (one or more
 * `facility.severity` clauses separated by `;`). `target` is everything
 * after — a file path, `~` (discard), `&` (use previous action), `@host`
 * (UDP forward), `@@host` (TCP forward), `|fifo`, or `:omusrmsg:user`.
 *
 * The IR builder unfolds these into prifilt-guarded actions inside the
 * default ruleset so the simulator can evaluate them like first-class
 * statements.
 */
export interface LegacySelectorStmt extends NodeBase {
  kind: 'LegacySelectorStmt';
  facspec: string;
  target: string;
}
export interface CallStmt extends NodeBase {
  kind: 'CallStmt';
  ruleset: string;
}
export interface LegacyDirective extends NodeBase {
  kind: 'LegacyDirective';
  name: string;
  rest: string;
  raw: string;
}
export interface UnknownNode extends NodeBase {
  kind: 'UnknownNode';
  raw: string;
}

// ---------- File ----------

export interface ConfigFile extends NodeBase {
  kind: 'ConfigFile';
  path: string;
  statements: Stmt[];
}
