#!/bin/bash
# Install the email-refresh launchd agent. Runs every hour.
# Cache + logs live in ~/Library/Application Support/career-ops-refresh/
# because macOS TCC blocks launchd from accessing ~/Desktop.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PLIST_TEMPLATE="$SCRIPT_DIR/com.career-ops.email-refresh.plist"

SUPPORT_DIR="$HOME/Library/Application Support/career-ops-refresh"
RUN_SCRIPT="$SUPPORT_DIR/run.sh"
PROMPT_FILE="$SUPPORT_DIR/prompt.md"
CACHE_FILE="$SUPPORT_DIR/emails-cache.json"

PLIST_TARGET="$HOME/Library/LaunchAgents/com.career-ops.email-refresh.plist"

CLAUDE_BIN="$(command -v claude || true)"
if [ -z "$CLAUDE_BIN" ]; then
  echo "ERROR: 'claude' CLI not found on PATH. Install Claude Code first."
  exit 1
fi

mkdir -p "$SUPPORT_DIR"
cp "$SCRIPT_DIR/prompt.md" "$PROMPT_FILE"

# Stage runner with absolute paths inlined
SUPPORT_ESC=$(printf '%s\n' "$SUPPORT_DIR" | sed 's/[\/&|]/\\&/g')
ROOT_ESC=$(printf '%s\n' "$ROOT" | sed 's/[\/&|]/\\&/g')
sed \
  -e "s|__SUPPORT_DIR__|$SUPPORT_ESC|g" \
  -e "s|__PROJECT_ROOT__|$ROOT_ESC|g" \
  "$SCRIPT_DIR/run.sh" > "$RUN_SCRIPT"
chmod +x "$RUN_SCRIPT"

# Seed the cache with the existing data file if present so the UI has data immediately.
if [ ! -f "$CACHE_FILE" ] && [ -f "$ROOT/data/emails-cache.json" ]; then
  cp "$ROOT/data/emails-cache.json" "$CACHE_FILE"
  echo "Seeded cache from $ROOT/data/emails-cache.json"
fi

# Materialize plist
mkdir -p "$HOME/Library/LaunchAgents"
sed \
  -e "s|__SCRIPT_PATH__|$RUN_SCRIPT|g" \
  -e "s|__SUPPORT_DIR__|$SUPPORT_DIR|g" \
  -e "s|__HOME__|$HOME|g" \
  -e "s|__PATH__|$PATH|g" \
  -e "s|__CLAUDE_BIN__|$CLAUDE_BIN|g" \
  "$PLIST_TEMPLATE" > "$PLIST_TARGET"

launchctl bootout "gui/$(id -u)" "$PLIST_TARGET" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_TARGET"
launchctl enable "gui/$(id -u)/com.career-ops.email-refresh"

echo "Installed."
echo "  agent      : $PLIST_TARGET"
echo "  runner     : $RUN_SCRIPT"
echo "  prompt     : $PROMPT_FILE"
echo "  cache      : $CACHE_FILE"
echo "  cadence    : every 3600s (1h), with RunAtLoad"
echo
echo "Tail:    tail -f \"$SUPPORT_DIR/email-refresh.log\""
echo "Force:   launchctl kickstart -k gui/\$(id -u)/com.career-ops.email-refresh"
echo "Status:  launchctl print gui/\$(id -u)/com.career-ops.email-refresh | head"
echo "Uninstall: $SCRIPT_DIR/uninstall.sh"
echo
echo "NOTE: The UI server is now reading from $CACHE_FILE."
echo "      Restart the UI server (npm run ui) to pick up the new path."
