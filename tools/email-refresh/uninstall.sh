#!/bin/bash
set -euo pipefail
PLIST_TARGET="$HOME/Library/LaunchAgents/com.career-ops.email-refresh.plist"
SUPPORT_DIR="$HOME/Library/Application Support/career-ops-refresh"

if [ -f "$PLIST_TARGET" ]; then
  launchctl bootout "gui/$(id -u)" "$PLIST_TARGET" 2>/dev/null || true
  rm -f "$PLIST_TARGET"
  echo "Removed: $PLIST_TARGET"
fi
if [ -d "$SUPPORT_DIR" ]; then
  rm -rf "$SUPPORT_DIR"
  echo "Removed: $SUPPORT_DIR"
fi
echo "Done."
