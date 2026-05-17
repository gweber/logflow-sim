/**
 * ArcSight (CEF) SIEM target.
 *
 * CEF (Common Event Format) is OpenText/MicroFocus ArcSight's
 * normalization standard, also accepted by HP ESM, Microsoft Sentinel
 * (as CommonSecurityLog), Splunk (via ArcSight add-on), and many other
 * SIEMs. Wire format is pipe-delimited text.
 *
 * Recognized output drivers: rsyslog's `omfwd` to an ArcSight syslog
 * connector (we match explicit `arcsight` or `cef` driver names),
 * Fluent Bit's `syslog` output with CEF formatting, Vector's `socket`
 * sink configured for CEF.
 */

import type { SIEMTarget } from '../types.js';
import { CEF_FIELD_MAP, CEF_EVENT_CLASS_MAP } from './mappings.js';

export const arcsightCefTarget: SIEMTarget = {
  id: 'arcsight-cef',
  displayName: 'ArcSight (CEF)',
  vendor: 'OpenText',
  outputDrivers: ['arcsight', 'cef', 'arcsight_cef', 'common_event_format'],
  fieldMap: CEF_FIELD_MAP,
  valueMaps: {
    'cef.eventClassID': CEF_EVENT_CLASS_MAP
  },
  rendering: 'cef',
  passthroughFields: ['cs1', 'cs2', 'cs3', 'cs4', 'cs5', 'cs6', 'suser', 'duser'],
  defaults: {
    requiredFields: ['rt'],
    placeholders: {
      arcsight_endpoint: 'syslog://arcsight.example.com:514',
      vendor: '<Vendor>',
      product: '<Product>',
      version: '1.0'
    }
  }
};
