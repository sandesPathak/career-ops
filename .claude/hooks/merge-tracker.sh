#!/usr/bin/env bash
# PostToolUse hook: auto-merge tracker after a TSV is written to batch/tracker-additions/.
cd "$(dirname "$0")/../.."
node merge-tracker.mjs >/dev/null 2>&1 || true
exit 0
