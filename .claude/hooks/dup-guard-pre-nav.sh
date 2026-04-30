#!/usr/bin/env bash
# PreToolUse hook for mcp__chrome-devtools__navigate_page.
# Denies navigation to URLs already in data/applications.md (Applied/Interview/Offer/Responded/Rejected).
set -e
URL=$(jq -r '.tool_input.url // empty')
[ -z "$URL" ] && exit 0
cd "$(dirname "$0")/../.."
if ! OUT=$(node dup-guard.mjs check "$URL" "" "" 2>&1); then
  jq -Rn --arg msg "$OUT" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$msg}}'
fi
exit 0
