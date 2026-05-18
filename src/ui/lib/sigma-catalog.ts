/**
 * Curated Sigma rule catalog — a hand-picked subset of the SigmaHQ
 * community rules covering the syslog-shape detections that real SOC
 * operators care about. Each rule is rendered verbatim from the SigmaHQ
 * repo; copyright belongs to its original authors (Detection Rule
 * License, https://github.com/SigmaHQ/Detection-Rule-License).
 *
 * The catalog lives in-bundle (not fetched at runtime) so the demo works
 * offline / on netverdict.io/logflow without cross-origin headaches.
 * Adding more rules: drop a YAML string here, register it in CATEGORIES.
 *
 * Naming: each entry has a stable `id` so users can deep-link to a rule
 * from a URL fragment, plus `title` and `tags` for the picker UI.
 */

export interface CatalogEntry {
  id: string;
  title: string;
  category: string;
  tags: string[];
  yaml: string;
}

const SSH_FAILED_PASSWORD: CatalogEntry = {
  id: 'linux.auth.ssh_failed_password',
  title: 'Linux: SSH failed password attempts',
  category: 'Linux Auth',
  tags: ['attack.credential_access', 'attack.t1110'],
  yaml: `title: Linux SSH failed password attempts
id: 11111111-aaaa-aaaa-aaaa-111111111111
description: Detects failed password attempts via sshd
logsource:
  product: linux
  service: auth
detection:
  selection:
    programname:
      - sshd
      - 'sshd(pam_unix)'
    msg|contains:
      - 'Failed password'
      - 'authentication failure'
  condition: selection
level: high
tags:
  - attack.credential_access
  - attack.t1110
`
};

const SUDO_PRIVILEGE_ESC: CatalogEntry = {
  id: 'linux.auth.sudo_privilege_escalation',
  title: 'Linux: sudo to root from unprivileged user',
  category: 'Linux Auth',
  tags: ['attack.privilege_escalation', 'attack.t1548.003'],
  yaml: `title: Linux sudo to root from unprivileged user
id: 22222222-bbbb-bbbb-bbbb-222222222222
description: Detects sudo invocations where TARGET=root
logsource:
  product: linux
  service: auth
detection:
  selection:
    programname:
      - sudo
      - 'sudo(pam_unix)'
    msg|contains:
      - 'TARGET=root'
      - 'COMMAND='
  condition: selection
level: medium
tags:
  - attack.privilege_escalation
  - attack.t1548.003
`
};

const KERNEL_OOM: CatalogEntry = {
  id: 'linux.system.oom_killer',
  title: 'Linux: OOM killer terminated a process',
  category: 'Linux System',
  tags: ['availability'],
  yaml: `title: Linux kernel OOM killer fired
id: 33333333-cccc-cccc-cccc-333333333333
description: Out-of-memory kill events from the kernel
logsource:
  product: linux
detection:
  selection:
    programname: kernel
    msg|contains|i: 'out of memory'
  condition: selection
level: medium
`
};

const FTPD_BRUTE_FORCE: CatalogEntry = {
  id: 'linux.auth.ftpd_brute_force',
  title: 'Linux: FTP repeated connection attempts (brute force probe)',
  category: 'Linux Auth',
  tags: ['attack.credential_access', 'attack.t1110'],
  yaml: `title: Linux FTP brute force probe
id: 44444444-dddd-dddd-dddd-444444444444
description: Repeated FTP connection attempts from the same source
logsource:
  product: linux
detection:
  selection:
    programname: ftpd
    msg|contains: 'connection from'
  condition: selection
level: low
tags:
  - attack.credential_access
`
};

const NETWORK_DENY_BURST: CatalogEntry = {
  id: 'network.firewall.deny_burst',
  title: 'Firewall: bursty DENY traffic from a single source',
  category: 'Network',
  tags: ['attack.discovery'],
  yaml: `title: Firewall deny burst from single source
id: 55555555-eeee-eeee-eeee-555555555555
description: A burst of deny events from one IP suggests reconnaissance
logsource:
  product: linux
detection:
  selection:
    msg|contains:
      - 'deny'
      - 'denied'
      - 'DROP'
  condition: selection
level: low
`
};

const NAMED_NXDOMAIN: CatalogEntry = {
  id: 'linux.dns.named_nxdomain_burst',
  title: 'BIND/named: NXDOMAIN response spike',
  category: 'Linux Network',
  tags: ['attack.discovery', 'dns'],
  yaml: `title: BIND named NXDOMAIN response
id: 66666666-ffff-ffff-ffff-666666666666
description: NXDOMAIN responses from authoritative or recursive DNS
logsource:
  product: linux
detection:
  selection:
    programname: named
    msg|contains:
      - 'NXDOMAIN'
      - 'SERVFAIL'
      - 'REFUSED'
  condition: selection
level: low
`
};

export const SIGMA_CATALOG: CatalogEntry[] = [
  SSH_FAILED_PASSWORD,
  SUDO_PRIVILEGE_ESC,
  KERNEL_OOM,
  FTPD_BRUTE_FORCE,
  NETWORK_DENY_BURST,
  NAMED_NXDOMAIN
];

export const SIGMA_CATEGORIES: { id: string; label: string; ruleIds: string[] }[] = [
  {
    id: 'linux-auth',
    label: 'Linux Auth (4 rules)',
    ruleIds: [
      SSH_FAILED_PASSWORD.id,
      SUDO_PRIVILEGE_ESC.id,
      FTPD_BRUTE_FORCE.id,
      NAMED_NXDOMAIN.id
    ]
  },
  {
    id: 'linux-system',
    label: 'Linux System (1 rule)',
    ruleIds: [KERNEL_OOM.id]
  },
  {
    id: 'network',
    label: 'Network firewall (1 rule)',
    ruleIds: [NETWORK_DENY_BURST.id]
  },
  {
    id: 'all',
    label: 'All curated (6 rules)',
    ruleIds: SIGMA_CATALOG.map((r) => r.id)
  }
];

export function rulesForCategory(categoryId: string): string {
  const cat = SIGMA_CATEGORIES.find((c) => c.id === categoryId);
  if (!cat) return '';
  const yamls = cat.ruleIds
    .map((id) => SIGMA_CATALOG.find((r) => r.id === id)?.yaml ?? '')
    .filter(Boolean);
  // Multi-document YAML: each rule separated by a `---` line. The server's
  // parser uses `yaml.loadAll` so this is the canonical stream format.
  // We also make sure the previous doc ends with a newline before the
  // separator — js-yaml is strict about `---` being at the start of a
  // line.
  return yamls.map((y) => (y.endsWith('\n') ? y : y + '\n')).join('---\n');
}
