import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NodeVFS } from '../../src/vfs/node.js';
import { load } from '../../src/core/kernel.js';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'siem-infer-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function write(rel: string, content: string) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

describe('inferLookupTaxonomies', () => {
  it('tags a lookup table that feeds $!sourcetype with taxonomy=sourcetype', async () => {
    write('lookups/st.json', JSON.stringify({
      version: 1,
      nomatch: '',
      type: 'string',
      table: [{ index: 'sshd', value: 'linux:secure' }]
    }));
    write('rsyslog.conf', `
module(load="imudp")
lookup_table(name="st" file="lookups/st.json")
input(type="imudp" port="514" ruleset="r")
ruleset(name="r") {
  set $!sourcetype = lookup("st", $programname);
  action(type="omfile" file="/var/log/x")
}
`);
    const res = await load(new NodeVFS(root), { entrypoint: '/rsyslog.conf' });
    const lt = res.model.lookupTableByName['st'];
    expect(lt).toBeDefined();
    expect(lt.taxonomy).toBe('sourcetype');
  });

  it('tags ecs.event.category for $!event_category assignments', async () => {
    write('lookups/cat.json', JSON.stringify({
      version: 1,
      nomatch: '',
      type: 'string',
      table: [{ index: 'sshd', value: 'authentication' }]
    }));
    write('rsyslog.conf', `
module(load="imudp")
lookup_table(name="cat" file="lookups/cat.json")
input(type="imudp" port="514" ruleset="r")
ruleset(name="r") {
  set $!event_category = lookup("cat", $programname);
  action(type="omfile" file="/var/log/x")
}
`);
    const res = await load(new NodeVFS(root), { entrypoint: '/rsyslog.conf' });
    expect(res.model.lookupTableByName['cat'].taxonomy).toBe('ecs.event.category');
  });

  it('leaves a lookup untagged when no taxonomy-bearing assignment uses it', async () => {
    write('lookups/x.json', JSON.stringify({
      version: 1,
      nomatch: '',
      type: 'string',
      table: [{ index: 'a', value: 'b' }]
    }));
    write('rsyslog.conf', `
module(load="imudp")
lookup_table(name="x" file="lookups/x.json")
input(type="imudp" port="514" ruleset="r")
ruleset(name="r") {
  set $!whatever = lookup("x", $programname);
  action(type="omfile" file="/var/log/x")
}
`);
    const res = await load(new NodeVFS(root), { entrypoint: '/rsyslog.conf' });
    expect(res.model.lookupTableByName['x'].taxonomy).toBeUndefined();
  });
});

describe('inferOutputSIEMs', () => {
  it('tags non-rsyslog outputs by driver name', async () => {
    // Use a syslog-ng config since it has explicit `destination` outputs.
    write('syslog-ng.conf', `
@version: 4.0
source s_local { system(); };
destination d_es {
  elasticsearch-http(url("https://es:9200/_bulk") index("logs"));
};
log { source(s_local); destination(d_es); };
`);
    const res = await load(new NodeVFS(root), {
      entrypoint: '/syslog-ng.conf',
      dialect: 'syslog-ng'
    });
    // syslog-ng dialect builds outputs; verify the elasticsearch sink is
    // tagged with elastic-ecs.
    const elasticOuts = res.model.outputs.filter((o) => o.siemTarget === 'elastic-ecs');
    expect(elasticOuts.length).toBeGreaterThan(0);
  });
});
