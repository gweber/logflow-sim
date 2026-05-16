#!/usr/bin/env bash
# Replay the Loghub Linux dataset (25k real /var/log/messages lines) through
# the running logflow-sim server and pretty-print the aggregate verdict.
#
# Usage:
#   scripts/replay-loghub.sh            # fetches the dataset on first run
#   scripts/replay-loghub.sh /path/to/Linux.log
#   LOGFLOW_BASE_URL=http://host:5140 scripts/replay-loghub.sh
#
# Requires: curl, jq. The dataset is cached under /tmp/loghub-linux/.

set -euo pipefail

BASE="${LOGFLOW_BASE_URL:-http://localhost:5140}"
CACHE_DIR="/tmp/loghub-linux"
LOG_FILE="${1:-$CACHE_DIR/Linux.log}"

if [[ ! -f "$LOG_FILE" ]]; then
  mkdir -p "$CACHE_DIR"
  echo "Fetching Loghub Linux dataset (~232 KB)..." >&2
  curl -sL -o "$CACHE_DIR/Linux.tar.gz" \
    "https://zenodo.org/records/8196385/files/Linux.tar.gz"
  tar -xzf "$CACHE_DIR/Linux.tar.gz" -C "$CACHE_DIR"
  LOG_FILE="$CACHE_DIR/Linux.log"
fi

LINES=$(wc -l <"$LOG_FILE")
echo "Replaying $LINES lines from $LOG_FILE against $BASE..." >&2

# Build a JSON body with the file content as the `text` field. We use
# jq's --rawfile to do the JSON-escaping correctly.
jq -n --rawfile body "$LOG_FILE" '{text: $body, maxMessages: 50000}' \
  | curl -s -X POST "$BASE/api/replay/lines" \
      -H 'content-type: application/json' \
      --data-binary @- \
  | jq '{
      summary: {
        total: .report.total,
        processed: .report.processed,
        delivered: .report.delivered,
        noInputMatch: .report.noInputMatch,
        noOutput: .report.noOutput,
        errors: .report.errors,
        durationMs: .report.durationMs
      },
      topPrograms: .report.topPrograms,
      perRuleset: .report.perRuleset,
      perOutput: .report.perOutput,
      unmatchedSamples: .report.unmatchedSamples[0:3]
    }'
