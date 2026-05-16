import type { SourceLoc } from '../source-map.js';

export interface LookupTableData {
  name: string;
  filePath: string;
  loaded: boolean;
  format?: 'object' | 'array-of-objects' | 'rsyslog-native';
  nomatch?: string;
  entries: Record<string, string>;
  size: number;
  error?: string;
  source: SourceLoc;
}

export interface LookupResult {
  hit: boolean;
  value: string;
  /** True if returned value was the table's nomatch default. */
  isDefault: boolean;
  tableLoaded: boolean;
  format?: LookupTableData['format'];
}
