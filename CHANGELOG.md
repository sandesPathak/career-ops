# Changelog

## [0.2.0] — 2026-04-30

Friction fixes for new contributors based on a fresh-clone audit.

- **Onboarding: screening-questions auto-filled.** `/start-career` now fills `screening-questions.json` honest-answer fields based on form data (work auth, location, salary). No more `{placeholder}` strings reaching live forms.
- **`npm run browser`.** New `tools/start-browser.mjs` auto-detects + launches Brave/Chrome with `--remote-debugging-port=9222` and the user's existing profile (cookies + sessions + extensions intact).
- **`npm run doctor` checks browser CDP.** Confirms a browser is attached on :9222 and prints a clear fix command if not.
- **`npm install` now downloads Chromium automatically** (`postinstall` runs `playwright install chromium`).
- **Friendly errors in apply-*.mjs.** Every CDP-attaching script (`apply-ashby-essays`, `apply-ashby-full`, `apply-greenhouse-essays`, `finish-ashby`) now uses a shared `connectToBrave()` helper that prints an actionable error when port 9222 is unreachable.
- **README rewritten with a Prerequisites table** + explicit notes on the optional Go dashboard, optional Python aggregators, and the OpenCode/Gemini slash-command directories.
- **Memory + update-system documented.**

## [0.1.0] — Initial public release

- Forked from [santifer/career-ops](https://github.com/santifer/career-ops) (upstream v1.5.0).
- Sanitized for public release: stripped personal answer banks, parameterized hardcoded location/salary/work-auth/resume-filename, added `*.example.*` templates for every user-personal file.
- Added Claude Code project hooks (`.claude/hooks/`), 4 scoped subagents (`.claude/agents/`), and `chrome-devtools-mcp` config (`.mcp.json`) replacing Playwright MCP.

For changes upstream, see [santifer/career-ops/CHANGELOG.md](https://github.com/santifer/career-ops/blob/main/CHANGELOG.md).
