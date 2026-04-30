# Changelog

## [0.7.0] — 2026-04-30

Classification by Claude (not regex) + un-truncate emails on click.

- **Email intent is now decided by Claude at refresh time**, not by regex at every UI render. `tools/email-refresh/prompt.md` Step 5 has Claude read the full body and assign one of: `applied-ack`, `rejection`, `interview-request`, `interview-scheduling`, `interview-followup`, `offer`, `recruiter-outreach`, `security-code`, `other`. Each entry also gets `confidence` (high/medium/low) and `reason` (one short sentence) so mis-classifications are debuggable. Pull-broad, classify-strict.
- **`ui/server.mjs#classifyIntent` now trusts the cached `intent` field**, falling back to a tightened regex only for legacy caches written before 0.7.0. Applied-ack rule moved BEFORE rejection rule, and the rejection regex no longer matches generic subjects ("thank you for your interest", "regarding your application", "update on your application") that appear in BOTH acks and rejections — fixes the Luxury Presence applied-ack mis-tagged as rejection.
- **Confidence indicator** in the feed: low-confidence calls + regex-fallbacks get a `?` mark next to the chip, hover shows Claude's `reason`.
- **Expandable email bodies** in the Dashboard feed — `▾ show full` toggles between 3-line clamp and the entire body (rendered in monospace, preserving newlines).
- **Inbox cards now expand on click** with a clear hover state, replacing the silently-clipped 4-line snippet.
- **`/api/feed` includes the full `body` and the cached `confidence` / `reason` / `classifiedBy`** so the UI can show Claude's reasoning.


## [0.6.0] — 2026-04-30

UI redesign: sidebar navigation + Dashboard with 4 KPI cards + unified time-sorted activity feed. Answers "what was my last rejection / last application / last interview invite / last offer" in one screen.

- **New sidebar** (left rail, 240px): Dashboard · Messages · Active jobs · Pipeline · Companies · Closed. Live counts as badges per section. Cache-age + ↻ Refresh in the footer.
- **Dashboard (default landing):** 4 color-coded KPI cards (last applied/rejected/interview/offer) — each shows company · role and time-ago. Below: filter chips (All / Applied / Rejected / Interview / Offer / Ack) + a feed grouped by Today / Yesterday / This week / This month / Earlier.
- **Active jobs** view: only Applied/Interview/Responded rows, sorted by date. Click a card to drill into Pipeline detail.
- **Closed** view: Rejected/Discarded archive.
- **Messages** view: existing Inbox (renamed), now in the sidebar instead of a top tab.
- **New `/api/feed` endpoint** in `ui/server.mjs` — merges tracker rows + email threads into a unified `events` stream, sorted newest first.
- **Per-event chips:** `APPLIED` (green), `REJECTED` (red), `INTERVIEW` (cyan), `OFFER` (yellow), `ACK` (muted), `EVALUATED` (purple). Inline action buttons per row: Open posting · Report · Details.


## [0.5.0] — 2026-04-30

UI: "Open posting" + "Open report" actually work now.

- **Open posting** now resolves a JD URL from multiple sources in priority: report markdown's `**URL:**` line → `https://...` URLs in the notes column → `URL: jobs.ashbyhq.com/...` (scheme-less) prefix in notes. Falls back to a clear toast when no URL exists, instead of silently doing nothing.
- **Open report** handles 404 gracefully — surfaces a toast with the missing path + offers to open the JD via notes URL if available, instead of putting "not found" into the modal body.
- **Buttons disable correctly** when there's no underlying data (n/a report, no notes URLs), with a tooltip explaining why.
- **Toast banner** for action errors (`#uiToast`) — replaces silent failures across the app.
- `extractUrls()` strips trailing punctuation (`.,;:!?'"`) so URLs at sentence ends don't 404.


## [0.4.0] — 2026-04-30

Don't miss rejections.

- **`tools/email-refresh/prompt.md` — 4 queries instead of 2.** Adds a rejection-subjects query (`"update on your application"`, `"regarding your application"`, `"thank you for your interest"`, `"following up"`, `"status update"`, `"decision regarding"`, `"no longer being considered"`, `"wasn't selected"`) AND a rejection-body query (`"we have/we've decided"`, `"moving forward with other candidates"`, `"won't be moving forward"`, `"unfortunately we"`, etc.). Catches company-domain rejections that don't come through any ATS.
- **Step 6 NEVER drops threads.** Adds a tracker cross-reference, sender display-name extraction, and sender-domain-stem inference, with a final `Unknown — <domain>` bucket so unmatched threads still surface in the UI instead of vanishing.
- **`ui/server.mjs` intent classifier** — rejection rule moved to first place (boilerplate "thank you for applying" inside rejection emails was misclassifying), expanded to 18 patterns, now scans subject + snippet + body. 16/16 unit tests pass against real-world rejection-email language.
- **New `kind` values in cache:** `rejection`, `interview`, `offer` joined the existing `ats-ack` / `company-ack` / `security-code` / `other`.


## [0.3.0] — 2026-04-30

UI Inbox refresh + email setup docs.

- **New:** **↻ Refresh** button in the UI Inbox tab. Spawns `claude --print` headless with Gmail MCP, writes to the cache file, re-renders the inbox. Shows progress + clear errors (CLI not found / Gmail not authed).
- **New:** `POST /api/emails/refresh` endpoint in `ui/server.mjs`. 8-minute timeout for first-run Gmail searches.
- **README:** "Email integration" section explains 3 setup paths — manual button, hourly launchd, or just `bash tools/email-refresh/run.sh`. Failure modes documented inline.


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
