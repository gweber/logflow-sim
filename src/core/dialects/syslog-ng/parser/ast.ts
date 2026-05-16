import type { SourceLoc } from '../../../source-map.js';

/**
 * syslog-ng AST.
 *
 * The configuration grammar is block-oriented:
 *
 *   @version: 4.3                       VersionPragma
 *   @include "scl.conf"                 IncludePragma
 *   options { … };                      OptionsBlock
 *   source <name> { driver(...); … };   NamedBlock(kind="source")
 *   destination <name> { … };           NamedBlock(kind="destination")
 *   filter <name> { <expr>; };          NamedBlock(kind="filter")
 *   template <name> { template("…"); };  NamedBlock(kind="template")
 *   parser <name> { csv-parser(…); };   NamedBlock(kind="parser")
 *   rewrite <name> { subst(…); };       NamedBlock(kind="rewrite")
 *   log { source(s); filter(f); … };    LogBlock
 *   block <funcname>(<args>) { … };     UserBlock (macros)
 */

export interface ConfigFile {
  kind: 'ConfigFile';
  path: string;
  statements: TopStmt[];
  source: SourceLoc;
}

export type TopStmt =
  | VersionPragma
  | IncludePragma
  | OptionsBlock
  | NamedBlock
  | LogBlock
  | UserBlock
  | UnknownTop;

export interface VersionPragma {
  kind: 'VersionPragma';
  version: string;
  source: SourceLoc;
}

export interface IncludePragma {
  kind: 'IncludePragma';
  spec: string;
  source: SourceLoc;
}

export interface OptionsBlock {
  kind: 'OptionsBlock';
  /** Sequence of `key(value …)` calls inside `options { … };`. */
  calls: DriverCall[];
  source: SourceLoc;
}

export type BlockKind =
  | 'source'
  | 'destination'
  | 'filter'
  | 'template'
  | 'parser'
  | 'rewrite'
  | 'block';

export interface NamedBlock {
  kind: 'NamedBlock';
  blockKind: BlockKind;
  name: string;
  /** For source/destination/parser/rewrite/template the body is a list of driver calls. */
  body: DriverCall[];
  /** For filter blocks the body is a boolean expression. */
  filter?: FilterExpr;
  source: SourceLoc;
}

/**
 * `log { source(s_src); filter(f_auth); destination(d_auth); flags(final); };`
 */
export interface LogBlock {
  kind: 'LogBlock';
  /** Inner directives — typically `source()`, `filter()`, `destination()`,
   *  `parser()`, `rewrite()`, `flags()`, plus nested `log { … };` blocks. */
  items: LogItem[];
  source: SourceLoc;
}

export type LogItem =
  | { kind: 'ref'; kindOf: 'source' | 'filter' | 'destination' | 'parser' | 'rewrite'; name: string; source: SourceLoc }
  | { kind: 'flags'; flags: string[]; source: SourceLoc }
  | { kind: 'nestedLog'; block: LogBlock };

export interface UserBlock {
  kind: 'UserBlock';
  funcName: string;
  /** Raw text of the block body — we don't try to instantiate macros. */
  body: string;
  source: SourceLoc;
}

export interface UnknownTop {
  kind: 'UnknownTop';
  raw: string;
  source: SourceLoc;
}

// ---------- Driver calls (the function-like nodes inside blocks) ----------

/**
 * `foo("arg" key1(v) key2("v" sub(z))) // comment`
 *
 * Recursive: parameters may themselves be DriverCall nodes (the `template(...)`
 * inside a `file("/x" template(t) ...)` driver).
 */
export interface DriverCall {
  kind: 'DriverCall';
  name: string;
  args: DriverArg[];
  source: SourceLoc;
}

export type DriverArg =
  | { kind: 'string'; value: string; source: SourceLoc }
  | { kind: 'number'; value: number; source: SourceLoc }
  | { kind: 'ident'; value: string; source: SourceLoc }
  | { kind: 'call'; call: DriverCall };

// ---------- Filter expressions ----------

export type FilterExpr =
  | FilterCall
  | FilterUnary
  | FilterBinary;

export interface FilterCall {
  kind: 'FilterCall';
  /** e.g. `facility`, `level`, `priority`, `host`, `program`, `match`, `netmask`, `tags`. */
  name: string;
  args: DriverArg[];
  source: SourceLoc;
}

export interface FilterUnary {
  kind: 'FilterUnary';
  op: 'not';
  operand: FilterExpr;
  source: SourceLoc;
}

export interface FilterBinary {
  kind: 'FilterBinary';
  op: 'and' | 'or';
  left: FilterExpr;
  right: FilterExpr;
  source: SourceLoc;
}
