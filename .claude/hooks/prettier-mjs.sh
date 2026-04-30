#!/usr/bin/env bash
# PostToolUse hook: prettier --write on edited/written .mjs files (no-op if prettier missing).
F=$(jq -r '.tool_input.file_path // .tool_response.filePath // empty')
[ -z "$F" ] && exit 0
case "$F" in
  *.mjs)
    command -v prettier >/dev/null 2>&1 && prettier --write "$F" >/dev/null 2>&1 || true
    ;;
esac
exit 0
