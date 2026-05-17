/**
 * Sumo Logic SIEM target.
 *
 * Sumo's HTTP Source endpoint accepts JSON events plus three top-level
 * source-axis fields: `_sourceCategory`, `_sourceName`, `_sourceHost`.
 * These can be set via HTTP headers (`X-Sumo-Category`) or embedded in
 * the JSON body.
 *
 * Recognized output drivers: rsyslog's `omhttp` configured against the
 * Sumo HTTP collector URL, Fluent Bit's `cloudwatch` output (no — they
 * support `http` with Sumo URL), Logstash's `sumologic` output, Vector
 * via `http` sink. We match on the Sumo-specific driver names where
 * they exist.
 */

import type { SIEMTarget } from '../types.js';
import { SUMO_FIELD_MAP, SUMO_SOURCE_CATEGORY_MAP } from './mappings.js';

export const sumoLogicTarget: SIEMTarget = {
  id: 'sumo-logic',
  displayName: 'Sumo Logic',
  vendor: 'Sumo Logic',
  outputDrivers: ['sumologic', 'sumo', 'sumologic_logs'],
  fieldMap: SUMO_FIELD_MAP,
  valueMaps: {
    'sumo.sourceCategory': SUMO_SOURCE_CATEGORY_MAP
  },
  rendering: 'json',
  passthroughFields: ['_sourceCategory', '_sourceName', '_sourceHost', '_collector'],
  defaults: {
    requiredFields: ['_sourceCategory'],
    placeholders: {
      http_source_url: 'https://endpoint.collection.sumologic.com/receiver/v1/http/${TOKEN}'
    }
  }
};
