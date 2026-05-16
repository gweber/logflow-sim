import type { Expr } from '../dialects/rsyslog/parser/ast.js';
import { evalExpr, toBool, type EvalContext } from './expressions.js';

export function evalCondition(e: Expr, ctx: EvalContext): boolean {
  return toBool(evalExpr(e, ctx));
}
