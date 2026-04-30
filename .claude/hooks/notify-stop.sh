#!/usr/bin/env bash
# Stop hook: macOS notification when Claude finishes a turn.
osascript -e 'display notification "Claude finished" with title "career-ops"' >/dev/null 2>&1 || true
exit 0
