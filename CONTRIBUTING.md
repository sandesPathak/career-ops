# Contributing to Career-Ops

Thanks for your interest in contributing! Career-Ops is built with Claude Code, and you can use it for development too.

## Before Submitting a PR

**Please open an issue first to discuss the change you'd like to make.** This helps us align on direction before you invest time coding.

PRs without a corresponding issue may be closed if they don't align with the project's architecture or goals.

### What makes a good PR
- Fixes a bug listed in Issues
- Addresses a feature request that was discussed and approved
- Includes a clear description of what changed and why
- Follows the existing code style and project philosophy (simple, minimal, quality over quantity)

## Quick Start

1. Open an issue to discuss your idea
2. Fork the repo
3. Create a branch (`git checkout -b feature/my-feature`)
4. Make your changes
5. Test with a fresh clone (see [docs/SETUP.md](docs/SETUP.md))
6. Commit and push
7. Open a Pull Request referencing the issue

## What to Contribute

**Good first contributions:**
- Add companies to `templates/portals.example.yml`
- Translate modes to other languages
- Improve documentation
- Add example CVs for different roles (in `examples/`)
- Report bugs via [Issues](https://github.com/sandesPathak/career-ops/issues)

**Bigger contributions:**
- New evaluation dimensions or scoring logic
- Dashboard TUI features (in `dashboard/`)
- New skill modes (in `modes/`)
- Script improvements (`.mjs` utilities)

## Guidelines

- Keep modes language-agnostic when possible (Claude handles both EN and ES)
- Scripts should handle missing files gracefully (check `existsSync` before `readFileSync`)
- Dashboard changes require `go build` — test with real data before submitting
- Don't commit personal data (cv.md, profile.yml, applications.md, reports/)

## Privacy: never commit personal data

Career-ops is **template code + schema examples**. Real candidate data lives in your local working copy and **must never be committed**. Files that are gitignored by default:

| File / Pattern | Why |
|---|---|
| `cv.md` | Your real CV (paste your LinkedIn or resume here) |
| `config/profile.yml` | Your name, email, phone, location, work auth, salary anchor |
| `modes/_profile.md` | Your archetypes, narrative, proof points |
| `portals.yml` | Your customized portal scanner config |
| `data/applications.md` | Application tracker — every company you've applied to |
| `data/essays/*.json` (except `example.json`) | Per-application open-ended answers |
| `screening-questions.json` | Honest answer bank for ATS screening questions |
| `cv-do-not-claim.txt` | Personal blocklist of phrases you can't honestly claim |
| `reports/*.md` | Per-offer evaluation reports |
| `output/`, `~/Desktop/resume/` | Tailored CVs per application |
| `interview-prep/*.md` | Confidential per-company interview intel |
| `batch/tracker-additions/**/*.tsv`, `batch/logs/*` | Pipeline state with offer/comp data |
| `.env` | API keys |
| `*-oneshot.mjs`, `triage-*.mjs`, `*-combos.mjs`, `oneshots/` | Throwaway scripts with hardcoded URLs/companies |

**Templates that ARE tracked (start here when onboarding):**

- `config/profile.example.yml` — copy to `config/profile.yml`
- `modes/_profile.template.md` — copy to `modes/_profile.md`
- `templates/portals.example.yml` — copy to `portals.yml`
- `data/essays/example.json` — schema for your per-company answer files
- `screening-questions.example.json` — schema for ATS screening bank
- `cv-do-not-claim.example.txt` — generic phrases-not-to-claim starter
- `.env.example` — required env vars

**Before submitting a PR**, run:

```bash
git ls-files | xargs grep -l "your-name\|your-email\|your-phone" 2>/dev/null
```

If anything turns up that's not in `.example.*` form, fix it before pushing.

## Memory system

When you run career-ops via Claude Code, the assistant builds up notes about you in a project-local memory directory at `~/.claude/projects/<sanitized-cwd>/memory/`. This is **per-machine, not in the repo, and never synced**. It captures preferences and corrections you give during sessions (location policy, ATS quirks you've hit, "don't do X again" rules). Each new clone starts with an empty memory — that's intentional, the memory is yours.

## What we do NOT accept

- **PRs that scrape platforms prohibiting automated access** (LinkedIn, etc.). We actively reject these to respect third-party ToS.
- **PRs that enable auto-submitting applications** without human review. career-ops is a decision-support tool, not a spam bot.
- **PRs that add external API dependencies** without prior discussion in an issue.
- **PRs containing personal data** (real CVs, emails, phone numbers). Use `examples/` with fictional data instead.

## Development

```bash
# Scripts
npm run doctor                # Setup validation
node verify-pipeline.mjs     # Health check
node cv-sync-check.mjs        # Config check

# Dashboard
cd dashboard && go build -o career-dashboard .
./career-dashboard --path ..
```

## Need Help?

- [Join the Discord](https://discord.gg/8pRpHETxa4) — fastest way to get answers and connect with other contributors
- [Open an issue](https://github.com/sandesPathak/career-ops/issues)
- [Read the architecture docs](docs/ARCHITECTURE.md)
