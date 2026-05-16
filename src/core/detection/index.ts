export { parseSigma } from './sigma-parser.js';
export type { ParseSigmaResult } from './sigma-parser.js';
export { matches } from './sigma-matcher.js';
export type { SigmaMatchContext } from './sigma-matcher.js';
export { detectionImpact, detectionDiff } from './engine.js';
export type {
  DetectionImpactReport,
  DetectionRuleReport,
  DetectionImpactOptions,
  DetectionFireSample,
  DetectionDiffReport,
  DetectionDiffEntry
} from './engine.js';
export type { SigmaRule, SigmaSelection, SigmaField, SigmaModifier } from './types.js';
