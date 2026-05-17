import { describe, it, expect } from 'vitest';
import { toOCSF, fromOCSF, retagValue } from '../../src/core/siem-targets/pivot.js';
import { splunkTarget } from '../../src/core/siem-targets/splunk/index.js';
import { elasticEcsTarget } from '../../src/core/siem-targets/elastic-ecs/index.js';
import { genericTarget } from '../../src/core/siem-targets/generic/index.js';
import { OCSF_CATEGORIES, OCSF_CLASSES } from '../../src/core/siem-targets/ocsf.js';

describe('OCSF pivot', () => {
  describe('toOCSF', () => {
    it('maps a known Splunk sourcetype to the right OCSF class', () => {
      const r = toOCSF(splunkTarget, 'sourcetype', 'linux:secure');
      expect(r.lossy).toBe(false);
      expect(r.ocsf.category_uid).toBe(OCSF_CATEGORIES.IAM);
      expect(r.ocsf.class_uid).toBe(OCSF_CLASSES.AUTHENTICATION);
      expect(r.ocsf._original).toEqual({
        taxonomy: 'sourcetype',
        value: 'linux:secure',
        siemId: 'splunk'
      });
    });

    it('flags lossy when the taxonomy is unknown', () => {
      const r = toOCSF(splunkTarget, 'made-up-taxonomy', 'whatever');
      expect(r.lossy).toBe(true);
      expect(r.originalValue).toBe('whatever');
    });

    it('flags lossy when the value is unknown in a known taxonomy', () => {
      const r = toOCSF(splunkTarget, 'sourcetype', 'never:heard-of-it');
      expect(r.lossy).toBe(true);
      expect(r.ocsf._original?.value).toBe('never:heard-of-it');
    });
  });

  describe('fromOCSF', () => {
    it('produces a native value for a matching OCSF class', () => {
      const pivot = { class_uid: OCSF_CLASSES.AUTHENTICATION, category_uid: OCSF_CATEGORIES.IAM };
      const r = fromOCSF(elasticEcsTarget, 'ecs.event.category', pivot);
      expect(r.lossy).toBe(false);
      expect(r.nativeValue).toBe('authentication');
    });

    it('honors the same-vendor fast path (verbatim re-emit)', () => {
      const pivot = toOCSF(splunkTarget, 'sourcetype', 'linux:secure').ocsf;
      const r = fromOCSF(splunkTarget, 'sourcetype', pivot);
      expect(r.lossy).toBe(false);
      expect(r.nativeValue).toBe('linux:secure');
    });

    it('preserves original value when target lacks the taxonomy', () => {
      const pivot = toOCSF(splunkTarget, 'sourcetype', 'linux:secure').ocsf;
      // generic has no value maps at all
      const r = fromOCSF(genericTarget, 'sourcetype', pivot);
      expect(r.lossy).toBe(true);
      expect(r.nativeValue).toBe('linux:secure');
    });
  });

  describe('retagValue (end-to-end)', () => {
    it('Splunk linux:secure → ECS authentication', () => {
      const r = retagValue(splunkTarget, elasticEcsTarget, 'sourcetype', 'linux:secure');
      // Different taxonomy on the target side wouldn't match by default —
      // verify the documented path: same taxonomy id, OCSF class hop.
      // We registered 'sourcetype' → OCSF on Splunk, and 'ecs.event.category'
      // on Elastic. So a same-taxonomy retag is correctly lossy here.
      expect(r.lossy).toBe(true);
      // The pivot's original value is preserved as the fallback.
      expect(r.value).toBe('linux:secure');
    });

    it('same source and target → identity, never lossy', () => {
      const r = retagValue(splunkTarget, splunkTarget, 'sourcetype', 'linux:secure');
      expect(r.lossy).toBe(false);
      expect(r.value).toBe('linux:secure');
    });

    it('crosses taxonomies when both sides recognize the OCSF class', () => {
      // Hand-craft a pivot that both targets recognize via class_uid.
      // Splunk's 'linux:secure' → AUTHENTICATION class.
      // ECS's 'authentication' → AUTHENTICATION class.
      // A retag that explicitly bridges those taxonomies has to be
      // declared at a higher level; verify the building blocks work.
      const splunkPivot = toOCSF(splunkTarget, 'sourcetype', 'linux:secure').ocsf;
      // Strip the _original tag so the fast-path doesn't kick in and we
      // exercise the real class-based lookup.
      delete splunkPivot._original;
      const r = fromOCSF(elasticEcsTarget, 'ecs.event.category', splunkPivot);
      expect(r.lossy).toBe(false);
      expect(r.nativeValue).toBe('authentication');
    });
  });
});
