import { describe, it, expect } from 'vitest';
import { getSIEMTarget, listSIEMTargets } from '../../src/core/siem-targets/registry.js';
import { toOCSF, fromOCSF, retagValue } from '../../src/core/siem-targets/pivot.js';
import { renderGELF } from '../../src/core/siem-targets/renderers/gelf.js';
import { OCSF_CATEGORIES, OCSF_CLASSES } from '../../src/core/siem-targets/ocsf.js';

describe('Week 2: registry size', () => {
  it('Week 2 added at least 6 SIEM targets to the registry', () => {
    const ids = listSIEMTargets().map((t) => t.id);
    expect(ids).toEqual(expect.arrayContaining([
      'generic',
      'splunk',
      'elastic-ecs',
      'datadog',
      'loki',
      'graylog-gelf'
    ]));
  });
});

describe('Datadog plugin', () => {
  it('maps ssh → AUTHENTICATION', () => {
    const r = toOCSF(getSIEMTarget('datadog')!, 'ddsource', 'ssh');
    expect(r.lossy).toBe(false);
    expect(r.ocsf.class_uid).toBe(OCSF_CLASSES.AUTHENTICATION);
  });

  it('maps nginx → HTTP_ACTIVITY', () => {
    const r = toOCSF(getSIEMTarget('datadog')!, 'ddsource', 'nginx');
    expect(r.lossy).toBe(false);
    expect(r.ocsf.class_uid).toBe(OCSF_CLASSES.HTTP_ACTIVITY);
  });

  it('preserves unmapped ddsource verbatim through pivot', () => {
    const r = toOCSF(getSIEMTarget('datadog')!, 'ddsource', 'made-up-tool');
    expect(r.lossy).toBe(true);
    expect(r.originalValue).toBe('made-up-tool');
  });
});

describe('Loki plugin', () => {
  it('maps auth label → AUTHENTICATION class', () => {
    const r = toOCSF(getSIEMTarget('loki')!, 'loki.label', 'auth');
    expect(r.lossy).toBe(false);
    expect(r.ocsf.class_uid).toBe(OCSF_CLASSES.AUTHENTICATION);
  });

  it('preserves unknown labels verbatim', () => {
    const r = toOCSF(getSIEMTarget('loki')!, 'loki.label', 'my-custom-app');
    expect(r.lossy).toBe(true);
  });
});

describe('Graylog GELF plugin', () => {
  it('maps standard syslog facilities', () => {
    const gelf = getSIEMTarget('graylog-gelf')!;
    expect(toOCSF(gelf, 'gelf.facility', 'auth').ocsf.class_uid).toBe(
      OCSF_CLASSES.AUTHENTICATION
    );
    expect(toOCSF(gelf, 'gelf.facility', 'mail').ocsf.class_uid).toBe(
      OCSF_CLASSES.EMAIL_ACTIVITY
    );
    expect(toOCSF(gelf, 'gelf.facility', 'kern').ocsf.class_uid).toBe(
      OCSF_CLASSES.KERNEL_ACTIVITY
    );
  });

  it('round-trips through OCSF for known facilities', () => {
    const gelf = getSIEMTarget('graylog-gelf')!;
    const r = retagValue(gelf, gelf, 'gelf.facility', 'auth');
    expect(r.lossy).toBe(false);
    expect(r.value).toBe('auth');
  });
});

describe('GELF renderer', () => {
  const gelf = getSIEMTarget('graylog-gelf')!;

  it('always emits version=1.1', () => {
    const out = renderGELF(gelf, {});
    expect(out.version).toBe('1.1');
  });

  it('provides default host and short_message when missing', () => {
    const out = renderGELF(gelf, {});
    expect(out.host).toBe('_unknown');
    expect(out.short_message).toBe('');
  });

  it('maps mapped OCSF paths to GELF reserved fields', () => {
    const out = renderGELF(gelf, {
      'src_endpoint.hostname': 'web-01',
      'service.name': 'mail'
    });
    expect(out.host).toBe('web-01');
    expect(out.facility).toBe('mail');
  });

  it('underscores unmapped fields per GELF 1.1', () => {
    const out = renderGELF(gelf, {
      'src_endpoint.hostname': 'h',
      'custom.thing': 'x'
    });
    // custom.thing is unmapped → goes into _unmapped JSON blob
    expect(out._unmapped).toBeDefined();
  });

  it('underscores passthrough fields too', () => {
    const out = renderGELF(gelf, {
      'src_endpoint.hostname': 'h',
      stream_id: 'stream-42',
      level: 6
    });
    // stream_id and level are passthroughs; level is reserved, stream_id is not
    expect(out.level).toBe(6);
    expect(out._stream_id).toBe('stream-42');
  });
});

describe('Cross-vendor retag via OCSF', () => {
  it('Splunk linux:secure → Datadog ssh (via OCSF AUTHENTICATION)', () => {
    const splunk = getSIEMTarget('splunk')!;
    const datadog = getSIEMTarget('datadog')!;
    const pivot = toOCSF(splunk, 'sourcetype', 'linux:secure').ocsf;
    delete pivot._original; // bypass same-vendor fast-path
    const result = fromOCSF(datadog, 'ddsource', pivot);
    expect(result.lossy).toBe(false);
    expect(result.nativeValue).toBe('ssh');
  });

  it('Datadog nginx → ECS web (via OCSF HTTP_ACTIVITY)', () => {
    const datadog = getSIEMTarget('datadog')!;
    const ecs = getSIEMTarget('elastic-ecs')!;
    const pivot = toOCSF(datadog, 'ddsource', 'nginx').ocsf;
    delete pivot._original;
    const result = fromOCSF(ecs, 'ecs.event.category', pivot);
    expect(result.lossy).toBe(false);
    expect(result.nativeValue).toBe('web');
  });

  it('Splunk linux:secure → GELF auth (via OCSF AUTHENTICATION)', () => {
    const splunk = getSIEMTarget('splunk')!;
    const gelf = getSIEMTarget('graylog-gelf')!;
    const pivot = toOCSF(splunk, 'sourcetype', 'linux:secure').ocsf;
    delete pivot._original;
    const result = fromOCSF(gelf, 'gelf.facility', pivot);
    expect(result.lossy).toBe(false);
    expect(result.nativeValue).toBe('auth');
  });
});
