#!/usr/bin/env bash
# fetch-corpus.sh — refresh test/corpus/ from upstream sources.
#
# Each entry below is `<dest> <url>`. We download verbatim, then `git diff`
# tells you what upstream changed since the last refresh. Run from the repo
# root.
#
# Files are licensed by their upstream projects. We use them only as parser
# inputs for regression tests and do not redistribute them in any released
# build artifact.

set -euo pipefail
cd "$(dirname "$0")/.."

CORPUS=test/corpus
mkdir -p "$CORPUS/distro-defaults" "$CORPUS/real-world"

# Distro defaults
declare -A DISTRO=(
  [distro-defaults/debian.conf]="https://salsa.debian.org/debian/rsyslog/-/raw/debian/master/debian/rsyslog.conf"
  [distro-defaults/fedora.conf]="https://src.fedoraproject.org/rpms/rsyslog/raw/rawhide/f/rsyslog.conf"
  [distro-defaults/alpine.conf]="https://gitlab.alpinelinux.org/alpine/aports/-/raw/master/main/rsyslog/rsyslog.conf"
  [distro-defaults/gentoo.conf]="https://gitweb.gentoo.org/repo/gentoo.git/plain/app-admin/rsyslog/files/rsyslog.conf"
)

# Real-world configs from public GitHub repos
declare -A REAL=(
  [real-world/bokysan-postfix.conf]="https://raw.githubusercontent.com/bokysan/docker-postfix/master/image_root/etc/rsyslog.conf"
  [real-world/buoyant-hotdog-kafka.conf]="https://raw.githubusercontent.com/buoyant-data/hotdog/main/contrib/rsyslog/rsyslog.conf"
  [real-world/danos-vyatta.conf]="https://raw.githubusercontent.com/danos/vyatta-syslog/master/etc/rsyslog.conf.vyatta"
  [real-world/digitalocean-logtalez.conf]="https://raw.githubusercontent.com/digitalocean/logtalez/master/rsyslog.d/example_rsyslog.conf"
  [real-world/dronebridge.conf]="https://raw.githubusercontent.com/DroneBridge/DroneBridge/master/rsyslog.conf"
  [real-world/grafana-alloy-syslog.conf]="https://raw.githubusercontent.com/grafana/alloy-scenarios/main/syslog/rsyslog.conf"
  [real-world/JPvRiel-imkafka.conf]="https://raw.githubusercontent.com/JPvRiel/docker-rsyslog/master/debug/imkafka_load/rsyslog.conf"
  [real-world/mpoznyak-aggregation.conf]="https://raw.githubusercontent.com/mpoznyak/rsyslog-aggregation-demo/master/rsyslog/conf/rsyslog.conf"
  [real-world/NCAR-remote-syslog.conf]="https://raw.githubusercontent.com/NCAR/cluster-a-la-docker/master/remote-syslog/example.rsyslog.conf"
  [real-world/openbmc-facebook.conf]="https://raw.githubusercontent.com/openbmc/openbmc/master/meta-facebook/recipes-extended/rsyslog/rsyslog/rsyslog.conf"
  [real-world/python-psf-fastly.conf]="https://raw.githubusercontent.com/python/psf-salt/main/salt/cdn-logs/config/fastly.rsyslog.conf"
  [real-world/rsyslog-alpine-appliance.conf]="https://raw.githubusercontent.com/rsyslog/rsyslog/main/packaging/docker/appliance/alpine/rsyslog.conf"
  [real-world/sematext-multiple-rules.conf]="https://raw.githubusercontent.com/sematext/lucene-revolution-samples/master/2015/rsyslog_configs/rsyslog.conf.lr.multiple_rules"
  [real-world/sematext-velocity-kafka.conf]="https://raw.githubusercontent.com/sematext/velocity/master/rsyslog.conf.kafka"
  [real-world/slackhq-go-audit.conf]="https://raw.githubusercontent.com/slackhq/go-audit/master/examples/rsyslog/rsyslog.conf"
  [real-world/votingworks.conf]="https://raw.githubusercontent.com/votingworks/vxsuite-complete-system/main/config/rsyslog.conf"
  [real-world/wikimedia-fundraising.conf]="https://raw.githubusercontent.com/wikimedia/wikimedia-fundraising-dev/master/config/logger-rsyslog.conf"
)

fetch() {
  local rel="$1"
  local url="$2"
  local dest="$CORPUS/$rel"
  if curl -sfL --max-time 15 "$url" -o "$dest.tmp"; then
    mv "$dest.tmp" "$dest"
    printf "  %-45s %4s lines\n" "$rel" "$(wc -l < "$dest")"
  else
    rm -f "$dest.tmp"
    printf "  FAIL %s (%s)\n" "$rel" "$url" >&2
  fi
}

echo "Refreshing distro-defaults/"
for k in "${!DISTRO[@]}"; do fetch "$k" "${DISTRO[$k]}"; done

echo "Refreshing real-world/"
for k in "${!REAL[@]}"; do fetch "$k" "${REAL[$k]}"; done

echo
echo "Done. \`git diff $CORPUS/\` shows what changed since last refresh."
