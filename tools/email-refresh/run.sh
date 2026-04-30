#!/bin/bash
# Headless email-refresh runner. Invoked by launchd every hour.
# Writes the cache to ~/Library/Application Support/career-ops-refresh/emails-cache.json
# (outside of macOS-protected ~/Desktop), and the UI server is configured to read it.
set -euo pipefail

# These two paths are written in absolute form by install.sh.
SCRIPT_DIR="__SUPPORT_DIR__"
ROOT="__PROJECT_ROOT__"

PROMPT_FILE="$SCRIPT_DIR/prompt.md"
CACHE_FILE="$SCRIPT_DIR/emails-cache.json"
LOG_FILE="$SCRIPT_DIR/email-refresh.log"

mkdir -p "$SCRIPT_DIR"

# nvm-managed node may not be on launchd's PATH. Source nvm if present.
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh" >/dev/null 2>&1 || true
fi

CLAUDE_BIN="${CLAUDE_BIN:-}"
if [ -z "$CLAUDE_BIN" ] || [ ! -x "$CLAUDE_BIN" ]; then
  CLAUDE_BIN="$(command -v claude || true)"
fi
if [ -z "$CLAUDE_BIN" ] || [ ! -x "$CLAUDE_BIN" ]; then
  echo "[$(date -u +%FT%TZ)] claude CLI not found on PATH" >> "$LOG_FILE"
  exit 1
fi

cd "$SCRIPT_DIR"

TS="$(date -u +%FT%TZ)"
echo "[$TS] starting email refresh -> $CACHE_FILE" >> "$LOG_FILE"

CACHE_FILE="$CACHE_FILE" \
"$CLAUDE_BIN" \
  --print \
  --permission-mode bypassPermissions \
  --allowed-tools "mcp__claude_ai_Gmail__search_threads,Read,Write,Edit,Bash" \
  --append-system-prompt "Headless cache refresh. Be terse. No questions." \
  "$(cat "$PROMPT_FILE")" \
  >> "$LOG_FILE" 2>&1

echo "[$(date -u +%FT%TZ)] done" >> "$LOG_FILE"
