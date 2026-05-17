/**
 * SIEM-destination plugin contract.
 *
 * Mirrors the Dialect plugin axis (src/core/dialects/types.ts) but along the
 * orthogonal dimension of *where* the events ultimately land: Splunk, Elastic,
 * Loki, Datadog, Graylog, Sentinel, Sumo, Chronicle, QRadar, ArcSight, plus a
 * passthrough `generic` target.
 *
 * A SIEMTarget is mostly static data — field maps and value maps — with a
 * couple of optional hooks for non-trivial rewriting. The kernel orchestrates:
 *
 *   source.toOCSF(value)   →   OCSF pivot   →   target.fromOCSF(value)
 *
 * Every plugin maps to/from OCSF rather than directly to every other plugin,
 * so adding a new target is O(1) in mapping effort, not O(N).
 */

import type { OCSFEvent } from './ocsf.js';
import type { IRModel, IROutput } from '../ir/model.js';

/**
 * Identifier for a value-taxonomy that lookup tables can be tagged with.
 *
 * Examples:
 *   - `sourcetype`        Splunk's `vendor:product` classification
 *   - `ecs.event.category`  Elastic ECS event categorization
 *   - `ddsource`          Datadog's source field
 *   - `loki.label`        a Loki stream label
 *   - `gelf.facility`     Graylog GELF facility
 *   - `generic`           plain category names (auth, network, …)
 *
 * Plugins declare value-maps keyed by these taxonomy IDs.
 */
export type TaxonomyId = string;

/**
 * Wire format the target accepts. Drives which renderer in `renderers/`
 * synthesizes the actual output payload shape during retag.
 */
export type RenderingFormat = 'json' | 'gelf' | 'leef' | 'cef' | 'udm' | 'passthrough';

/**
 * Bidirectional field-name map between OCSF canonical paths and the target's
 * native field paths. `fromNative` is computed from `toNative` at registry
 * load time if absent — plugins only have to declare one direction.
 */
export interface FieldMap {
  /** OCSF canonical path → native path. e.g. `src_endpoint.ip` → `source.ip` (ECS) */
  toNative: Record<string, string>;
  /** Native path → OCSF canonical path. Inverse of `toNative`, auto-computed. */
  fromNative?: Record<string, string>;
}

/**
 * Reference to an OCSF class/category that a taxonomy value resolves to. Used
 * when translating between SIEM vocabularies via the OCSF pivot.
 *
 * Example: Splunk `sourcetype = "linux:secure"` →
 *   { category_uid: 3, class_uid: 3002 }   // IAM / Authentication
 *
 * The target plugin's value-map then knows how to render that OCSF class in
 * its own vocabulary (ECS `event.category = ["authentication"]`,
 * Datadog `ddsource = "ssh"`, etc.).
 */
export interface OCSFClassRef {
  /** OCSF category_uid (1..6 in v1.5.0). */
  category_uid?: number;
  /** OCSF class_uid — finer-grained than category. */
  class_uid?: number;
  /** Optional activity_id within the class. */
  activity_id?: number;
  /** Free-form hint for renderers that don't follow OCSF strictly. */
  hint?: string;
}

/**
 * One value-taxonomy's mapping table for a SIEM plugin.
 *
 * `entries` lists native values the plugin knows how to round-trip through
 * OCSF. Anything not in `entries` flows through `unmappedHandling` — either
 * preserved verbatim with an info diagnostic, or replaced by the catch-all.
 */
export interface ValueMap {
  taxonomy: TaxonomyId;
  /** Native value → OCSF class. e.g. `"linux:secure"` → `{ class_uid: 3002 }`. */
  entries: Record<string, OCSFClassRef>;
  /** Catch-all class when no entry matches. Optional. */
  catchAll?: OCSFClassRef;
  /**
   * What to do with values not in `entries` and no `catchAll`:
   *   - `preserve` (default): pass the literal through, emit info diagnostic
   *   - `drop`: replace with empty string, emit warning
   */
  unmappedHandling?: 'preserve' | 'drop';
}

/**
 * Context the renderer + value-rewriter receive when synthesizing or
 * translating an output. Keeps the plugin pure-functional.
 */
export interface EmitContext {
  /** The IR model being converted. */
  model: IRModel;
  /** The output being rewritten, if any. */
  output?: IROutput;
  /** The source SIEM, if known, so plugins can pick passthroughFields. */
  sourceSiemId?: string;
}

/**
 * The full plugin contract. Every supported SIEM destination implements this.
 */
export interface SIEMTarget {
  /** Stable identifier, lowercase kebab-case ("splunk", "elastic-ecs"). */
  readonly id: string;
  /** Human-readable name for the UI. */
  readonly displayName: string;
  /** Vendor / project that owns the destination. */
  readonly vendor: string;

  /**
   * Output drivers this target owns. detectSIEMTarget() matches an IROutput's
   * `driver` field against these to infer the SIEM.
   *
   * Examples: ['splunk_hec', 'splunk_hec_logs'] for Splunk;
   *           ['elasticsearch', 'omelasticsearch', 'elastic'] for Elastic.
   */
  readonly outputDrivers: string[];

  /** Bidirectional OCSF↔native field-path map. */
  readonly fieldMap: FieldMap;

  /** Per-taxonomy value-maps. Keyed by TaxonomyId. */
  readonly valueMaps: Record<TaxonomyId, ValueMap>;

  /** Wire-format discriminator: which renderer to use during retag. */
  readonly rendering: RenderingFormat;

  /**
   * Vendor-specific fields that survive same-vendor retags untouched (no
   * round-trip through OCSF). Splunk's `index`, Datadog's internal `service`,
   * etc. — things that have no OCSF equivalent but should not be lost when
   * the user is just changing pipeline tool.
   */
  readonly passthroughFields?: string[];

  /**
   * Heuristic to detect whether a given IR model targets this SIEM. Returns
   * confidence 0..1. Default behavior in the registry uses outputDrivers when
   * this hook isn't provided.
   */
  detect?(model: IRModel): number;

  /**
   * Rewrite an IROutput when retagging from another SIEM to this one. Lets
   * plugins swap the driver and rename params (e.g. `Index` → `index`,
   * `target_index` → `index`).
   */
  synthesizeOutput?(ir: IROutput, ctx: EmitContext): IROutput;

  /**
   * Render a dialect-specific snippet (OTTL, VRL, Filebeat processor) that
   * the dialect emitter can inline. Returns null when no native snippet is
   * meaningful — callers fall back to the standard renderer.
   */
  emitFieldRewrite?(ctx: EmitContext): string | null;

  /**
   * Defaults injected when synthesizing an output from scratch (e.g. for
   * `retag` runs where the user supplied a target SIEM but no concrete
   * driver was inferred).
   */
  defaults?: {
    requiredFields?: string[];
    placeholders?: Record<string, string>;
  };
}

/**
 * Result of running source.toOCSF on a single value. Carries the pivot event
 * plus a note about whether the translation was lossy (e.g. value not in any
 * known map, fell through to passthrough).
 */
export interface ToOCSFResult {
  ocsf: OCSFEvent;
  /** True when the source plugin didn't have a mapping for this value. */
  lossy: boolean;
  /** The original native value, preserved for passthrough renderers. */
  originalValue: string;
}

/**
 * Result of running target.fromOCSF on an OCSF pivot. Carries the rendered
 * native value plus a lossiness flag for the diagnostics layer.
 */
export interface FromOCSFResult {
  /** Native value the target uses (string-typed; the renderer handles shape). */
  nativeValue: string;
  /** True when the target plugin didn't have an entry for this OCSF class. */
  lossy: boolean;
}
