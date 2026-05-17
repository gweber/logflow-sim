/**
 * IBM QRadar (LEEF) SIEM target.
 *
 * QRadar ingests over syslog and accepts events in raw, CEF, or LEEF
 * formats. LEEF is QRadar-native and produces the cleanest parsing in
 * the DSM library. Output is pipe-delimited text — not JSON.
 *
 * Recognized output drivers: rsyslog's `omfwd` configured against
 * QRadar's syslog event collector (we infer via target port 514/6514
 * + LEEF formatting), Fluent Bit's `syslog` output, Logstash's
 * `syslog` output, Vector's `socket` sink.
 *
 * Note: detecting LEEF intent from a generic `omfwd` is unreliable;
 * the canonical signal is an explicit `qradar` driver name when present
 * (some downstream forwarders ship one). Manual `siemTarget=qradar-leef`
 * via the `# logflow:` comment is the recommended override.
 */

import type { SIEMTarget } from '../types.js';
import { LEEF_FIELD_MAP, LEEF_EVENT_ID_MAP } from './mappings.js';

export const qradarLeefTarget: SIEMTarget = {
  id: 'qradar-leef',
  displayName: 'IBM QRadar (LEEF)',
  vendor: 'IBM',
  outputDrivers: ['qradar', 'qradar_leef', 'leef'],
  fieldMap: LEEF_FIELD_MAP,
  valueMaps: {
    'leef.eventId': LEEF_EVENT_ID_MAP
  },
  rendering: 'leef',
  passthroughFields: ['cat', 'sev', 'usrName'],
  defaults: {
    requiredFields: ['devTime'],
    placeholders: {
      qradar_endpoint: 'syslog://qradar.example.com:514',
      vendor: '<Vendor>',
      product: '<Product>',
      version: '1.0'
    }
  }
};
