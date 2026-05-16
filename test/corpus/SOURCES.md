# Corpus sources

Every file in `test/corpus/` was fetched verbatim from a publicly available
source. None of them are synthetic. The corpus is the regression bed for the
parser — its purpose is to catch the moment a real-world syntax pattern starts
producing crashes or `UnknownNode` warnings.

If you add a new file, record where it came from below and the date you fetched
it.

## distro-defaults/

| File | Source |
|---|---|
| `debian.conf` | https://salsa.debian.org/debian/rsyslog/-/raw/debian/master/debian/rsyslog.conf |
| `fedora.conf` | https://src.fedoraproject.org/rpms/rsyslog/raw/rawhide/f/rsyslog.conf |
| `alpine.conf` | https://gitlab.alpinelinux.org/alpine/aports/-/raw/master/main/rsyslog/rsyslog.conf |
| `gentoo.conf` | https://gitweb.gentoo.org/repo/gentoo.git/plain/app-admin/rsyslog/files/rsyslog.conf |

## real-world/

Configurations from public GitHub projects. Each filename is `<owner>-<descriptor>.conf`
so you can trace it back to the source. License notes: every file here is
public on its respective project under the project's own license; we use them
for compatibility testing only. None are redistributed in this repo's binary
output.

| File | Source |
|---|---|
| `bokysan-postfix.conf` | https://raw.githubusercontent.com/bokysan/docker-postfix/master/image_root/etc/rsyslog.conf |
| `buoyant-hotdog-kafka.conf` | https://raw.githubusercontent.com/buoyant-data/hotdog/main/contrib/rsyslog/rsyslog.conf |
| `danos-vyatta.conf` | https://raw.githubusercontent.com/danos/vyatta-syslog/master/etc/rsyslog.conf.vyatta |
| `digitalocean-logtalez.conf` | https://raw.githubusercontent.com/digitalocean/logtalez/master/rsyslog.d/example_rsyslog.conf |
| `dronebridge.conf` | https://raw.githubusercontent.com/DroneBridge/DroneBridge/master/rsyslog.conf |
| `grafana-alloy-syslog.conf` | https://raw.githubusercontent.com/grafana/alloy-scenarios/main/syslog/rsyslog.conf |
| `JPvRiel-imkafka.conf` | https://raw.githubusercontent.com/JPvRiel/docker-rsyslog/master/debug/imkafka_load/rsyslog.conf |
| `mpoznyak-aggregation.conf` | https://raw.githubusercontent.com/mpoznyak/rsyslog-aggregation-demo/master/rsyslog/conf/rsyslog.conf |
| `NCAR-remote-syslog.conf` | https://raw.githubusercontent.com/NCAR/cluster-a-la-docker/master/remote-syslog/example.rsyslog.conf |
| `openbmc-facebook.conf` | https://raw.githubusercontent.com/openbmc/openbmc/master/meta-facebook/recipes-extended/rsyslog/rsyslog/rsyslog.conf |
| `python-psf-fastly.conf` | https://raw.githubusercontent.com/python/psf-salt/main/salt/cdn-logs/config/fastly.rsyslog.conf |
| `rsyslog-alpine-appliance.conf` | https://raw.githubusercontent.com/rsyslog/rsyslog/main/packaging/docker/appliance/alpine/rsyslog.conf |
| `sematext-multiple-rules.conf` | https://raw.githubusercontent.com/sematext/lucene-revolution-samples/master/2015/rsyslog_configs/rsyslog.conf.lr.multiple_rules |
| `sematext-velocity-kafka.conf` | https://raw.githubusercontent.com/sematext/velocity/master/rsyslog.conf.kafka |
| `slackhq-go-audit.conf` | https://raw.githubusercontent.com/slackhq/go-audit/master/examples/rsyslog/rsyslog.conf |
| `votingworks.conf` | https://raw.githubusercontent.com/votingworks/vxsuite-complete-system/main/config/rsyslog.conf |
| `wikimedia-fundraising.conf` | https://raw.githubusercontent.com/wikimedia/wikimedia-fundraising-dev/master/config/logger-rsyslog.conf |

## Refreshing

To pull updated copies, see `scripts/fetch-corpus.sh`. We snapshot files rather
than re-fetching at test time so the build stays deterministic and works
offline.
