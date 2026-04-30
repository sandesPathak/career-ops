# career-ops

AI-powered job search pipeline built on Claude Code. Personal fork of [santifer/career-ops](https://github.com/santifer/career-ops), customized for my own search and shared in case it's useful.

## What it does

- Score job descriptions against your CV with a structured A–G rubric
- Generate aggressively tailored resumes per application (every bullet rewritten to mirror JD vocabulary)
- Drive Greenhouse / Ashby / Lever forms via Chrome DevTools MCP, with a duplicate-submit hard gate
- Track every offer, application, response, interview, and rejection in a single markdown ledger
- Scan 45+ portals daily for new postings matching your archetypes — zero LLM cost on the scrape loop

## Quick start

1. Clone the repo
2. `npm install`
3. Open in Claude Code and run `/start-career` — a 7-field local form opens in your browser, takes ~2 minutes, and writes everything you need (`config/profile.yml`, `cv.md`, all template copies). Form data stays on your machine; nothing is uploaded.

Manual setup (if you'd rather not use the form):

- Copy each `*.example.*` to its real name and fill in your values: `config/profile.example.yml` → `config/profile.yml`; `modes/_profile.template.md` → `modes/_profile.md`; `templates/portals.example.yml` → `portals.yml`; `screening-questions.example.json` → `screening-questions.json`; `cv-do-not-claim.example.txt` → `cv-do-not-claim.txt`; `.env.example` → `.env`.
- Add your resume at `cv.md`.
- See `CLAUDE.md` for the full onboarding flow.

## Privacy

This repo contains template code only. Real candidate data lives in gitignored files on your machine and never gets committed. See `CONTRIBUTING.md` for the full list of files that must never be tracked.

## License

MIT. See `LICENSE`.

## Maintainer

[@sandesPathak](https://github.com/sandesPathak) — personal fork. For the canonical upstream project with active maintenance and community, see [@santifer/career-ops](https://github.com/santifer/career-ops).
