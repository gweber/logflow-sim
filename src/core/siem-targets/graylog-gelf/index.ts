/**
 * Graylog GELF SIEM target.
 *
 * GELF 1.1 is Graylog's native log format. Accepted over UDP (chunked),
 * TCP (newline-delimited JSON), and HTTP. Mandatory top-level fields:
 * version, host, short_message. Optional: timestamp, level, facility,
 * full_message. Custom fields must be prefixed with `_`.
 *
 * Recognized output drivers: rsyslog's `omfwd` to a GELF-receiving
 * input (we infer via target port / format), Fluent Bit's `gelf`
 * output, syslog-ng's `gelf()` destination, Vector's `socket` with
 * `encoding.codec=gelf`, Logstash's `gelf` output.
 */

import type { SIEMTarget } from '../types.js';
import { GELF_FIELD_MAP, GELF_FACILITY_MAP } from './mappings.js';

export const graylogGelfTarget: SIEMTarget = {
  id: 'graylog-gelf',
  displayName: 'Graylog (GELF)',
  vendor: 'Graylog',
  outputDrivers: ['gelf', 'graylog', 'graylog2'],
  fieldMap: GELF_FIELD_MAP,
  valueMaps: {
    'gelf.facility': GELF_FACILITY_MAP
  },
  rendering: 'gelf',
  passthroughFields: ['stream_id', 'level', 'full_message'],
  defaults: {
    requiredFields: ['version', 'host', 'short_message'],
    placeholders: {
      gelf_endpoint: 'gelf://graylog.example.com:12201'
    }
  }
};
