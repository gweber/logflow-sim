import type { IRModel, IRTemplate } from '../ir/model.js';
import type { EvalContext } from './expressions.js';
import { splitProperty, applyModifierChain } from './property-modifiers.js';

/**
 * Resolve a property reference from inside a template substitution.
 * Supported reference forms (before any `:` modifier):
 *
 *   name              → $name (case-insensitive)
 *   $NAME             → system property
 *   $.var             → local variable
 *   !field / $!field  → structured data
 *
 * Modifiers (chainable, after `:`) are handled by `applyModifierChain`.
 */
export function resolveProperty(name: string, ctx: EvalContext): string {
  const { base, modifiers } = splitProperty(name);
  const raw = readProperty(base.trim(), ctx);
  return modifiers.length ? applyModifierChain(raw, modifiers) : raw;
}

function readProperty(raw: string, ctx: EvalContext): string {
  if (!raw) return '';
  const lower = raw.toLowerCase();
  if (raw.startsWith('$.')) return ctx.localVars[raw.slice(2)] ?? '';
  if (raw.startsWith('$!')) return ctx.structured[raw.slice(2)] ?? '';
  if (raw.startsWith('!')) return ctx.structured[raw.slice(1)] ?? '';
  if (raw.startsWith('$')) return ctx.properties[lower] ?? '';
  return ctx.properties[lower] ?? '';
}

/**
 * Substitute `%property%` references inside a template `string="..."` body.
 * `%%` escapes to a literal `%`. Unclosed `%` is left literal.
 */
export function substituteTemplate(body: string, ctx: EvalContext): string {
  let out = '';
  let i = 0;
  while (i < body.length) {
    const c = body[i];
    if (c !== '%') {
      out += c;
      i++;
      continue;
    }
    if (body[i + 1] === '%') {
      out += '%';
      i += 2;
      continue;
    }
    const end = body.indexOf('%', i + 1);
    if (end === -1) {
      out += body.slice(i);
      break;
    }
    const name = body.slice(i + 1, end);
    out += resolveProperty(name, ctx);
    i = end + 1;
  }
  return out;
}

export function renderTemplateByName(
  model: IRModel,
  name: string,
  ctx: EvalContext
): { value: string; template?: IRTemplate; missing?: boolean } {
  const tpl = model.templateByName[name];
  if (!tpl) return { value: '', missing: true };

  // List templates: `template(name="x" type="list") { constant(value="...") property(name="...") ... }`.
  // The IR builder serializes the parts into `tpl.parts`; render each in order.
  if (tpl.type === 'list' && Array.isArray(tpl.parts)) {
    let out = '';
    for (const part of tpl.parts) {
      if (part.kind === 'constant') {
        out += part.value;
      } else if (part.kind === 'property') {
        out += resolveProperty(part.name, ctx);
      }
    }
    return { value: out, template: tpl };
  }

  if (tpl.type === 'string' && tpl.string !== undefined) {
    return { value: substituteTemplate(tpl.string, ctx), template: tpl };
  }
  return { value: tpl.string ?? '', template: tpl };
}
