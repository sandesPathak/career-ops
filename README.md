# career-ops

AI-powered job search pipeline built on Claude Code. Personal fork of [santifer/career-ops](https://github.com/santifer/career-ops), customized for my own search and shared in case it's useful.

## What it does

- Score job descriptions against your CV with a structured A–G rubric
- Generate aggressively tailored resumes per application (every bullet rewritten to mirror JD vocabulary)
- Drive Greenhouse / Ashby / Lever forms via Chrome DevTools MCP, with a duplicate-submit hard gate
- Track every offer, application, response, interview, and rejection in a single markdown ledger
- Scan 45+ portals daily for new postings matching your archetypes — zero LLM cost on the scrape loop

## Prerequisites

| Required for | What you need |
|---|---|
| Everything | Node.js ≥ 20, `npm` |
| PDF generation, JD scrapers (`prefilter`, `match-keywords`, `check-liveness`) | A local headless Chromium — installed automatically by `npm install` (`postinstall` runs `playwright install chromium`, ~150 MB one-time) |
| Auto-fill / auto-apply (browser flow) | Brave or Chrome running with `--remote-debugging-port=9222`. Run `npm run browser` and we'll launch one for you with your existing profile (cookies + sessions intact). |
| Optional dashboard TUI (`dashboard/`) | Go ≥ 1.21. Skip if you don't want the TUI. |
| Optional Python aggregators (Indeed/Google/ZipRecruiter via JobSpy) | `npm run setup:python` (creates a `.venv`, installs deps from `requirements.txt`) |

Run `npm run doctor` any time to verify all the prerequisites in one shot.

## Quick start

```bash
# 1. Clone + install (auto-downloads Chromium for PDF rendering)
git clone https://github.com/sandesPathak/career-ops.git
cd career-ops
npm install

# 2. Open in Claude Code and run:
/start-career
# A 7-field local form opens at http://localhost:7331 (~2 min).
# It writes config/profile.yml + cv.md + all template copies.
# Nothing is uploaded — all data stays on your machine, gitignored.

# 3. (Only if you want to auto-fill applications)
npm run browser
# Auto-launches Brave/Chrome with the debug port + your existing profile.

# 4. Verify everything's wired up
npm run doctor
```

You're done. Paste a job URL into Claude Code to evaluate it, or run `/career-ops scan` to discover new postings.

### Manual setup (skip the form)

If you'd rather not use the form: copy each `*.example.*` to its real name and fill in your values manually — `config/profile.example.yml` → `config/profile.yml`; `modes/_profile.template.md` → `modes/_profile.md`; `templates/portals.example.yml` → `portals.yml`; `screening-questions.example.json` → `screening-questions.json`; `cv-do-not-claim.example.txt` → `cv-do-not-claim.txt`; `.env.example` → `.env`. Add your resume at `cv.md`. See `CLAUDE.md` for the full onboarding flow.

## Slash commands

This repo ships slash-command definitions for **three** Claude-compatible CLIs:

- `.claude/commands/` — [Claude Code](https://docs.claude.com/code) (primary)
- `.opencode/commands/` — [OpenCode](https://opencode.ai)
- `.gemini/commands/` — [Gemini CLI](https://github.com/google-gemini/gemini-cli)

Use whichever you prefer. If you only use one, the other two directories are harmless — leave them or delete; they don't affect anything.

## Updating from upstream

`npm run update:check` polls `update-system.mjs`'s canonical-repo URL (defaults to this fork's repo) for newer versions. If you maintain your own fork of this fork, edit the `CANONICAL_REPO` constant in `update-system.mjs` to point at yours.

## Memory

When you run career-ops via Claude Code, the assistant builds up notes about your preferences in a project-local memory directory (`~/.claude/projects/<sanitized-cwd>/memory/`). It's per-machine, never synced, never in the repo. Each new clone starts with an empty memory — that's intentional. The system gets smarter the more you use it.

## Privacy

This repo contains template code only. Real candidate data lives in gitignored files on your machine and never gets committed. See `CONTRIBUTING.md` for the full list of files that must never be tracked.

## License

MIT. See `LICENSE`.

## Maintainer

[@sandesPathak](https://github.com/sandesPathak) — personal fork. For the canonical upstream project with active maintenance and community, see [@santifer/career-ops](https://github.com/santifer/career-ops).
