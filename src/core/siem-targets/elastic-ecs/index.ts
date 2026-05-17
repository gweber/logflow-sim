/**
 * Elastic Common Schema (ECS) SIEM target.
 *
 * ECS is Elastic's vendor-agnostic field convention for events landing in
 * Elasticsearch. Used by the Elastic Stack, OpenSearch, and any tool that
 * adopts ECS as its canonical field model. Output drivers we recognize:
 * rsyslog's `omelasticsearch`, OTel's `elasticsearch` exporter, Vector's
 * `elasticsearch` sink, Logstash's `elasticsearch` output, Fluent Bit's
 * `es`/`elasticsearch` output, Filebeat's `elasticsearch` output.
 *
 * ECS uses dotted hierarchical field paths (`host.hostname`, `event.category`,
 * `source.ip`). The JSON renderer produces those paths directly from the
 * OCSF pivot.
 */

import type { SIEMTarget } from '../types.js';
import {
  ELASTIC_ECS_FIELD_MAP,
  ELASTIC_ECS_CATEGORY_MAP,
  ELASTIC_ECS_TYPE_MAP
} from './mappings.js';

export const elasticEcsTarget: SIEMTarget = {
  id: 'elastic-ecs',
  displayName: 'Elastic (ECS)',
  vendor: 'Elastic',
  outputDrivers: [
    'omelasticsearch',
    'elasticsearch',
    'elasticsearch-http',
    'es',
    'elastic',
    'opensearch'
  ],
  fieldMap: ELASTIC_ECS_FIELD_MAP,
  valueMaps: {
    'ecs.event.category': ELASTIC_ECS_CATEGORY_MAP,
    'ecs.event.type': ELASTIC_ECS_TYPE_MAP
  },
  rendering: 'json',
  passthroughFields: [
    'event.dataset',
    'event.module',
    'agent.type',
    'agent.version',
    'data_stream.dataset',
    'data_stream.namespace',
    'data_stream.type'
  ],
  defaults: {
    requiredFields: ['event.dataset', '@timestamp'],
    placeholders: {
      es_url: 'https://elastic.example.com:9200',
      es_index: 'logs-${data_stream.dataset}-${data_stream.namespace}'
    }
  }
};
