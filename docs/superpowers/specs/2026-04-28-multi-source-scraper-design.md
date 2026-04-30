# Multi-Source Scraper — Design Spec

**Date:** 2026-04-28
**Status:** Approved (autonomous build session)
**Author:** Claude (career-ops session)
**Owner:** career-ops contributor

---

## Goal

Extend career-ops's discovery surface from "Greenhouse / Ashby / Lever ATS APIs" to also cover the big aggregators (Indeed, Google Jobs, ZipRecruiter) and the SimplifyJobs community lists, **without adding any LLM cost** to the scrape loop. All postings flow through the existing dedup → `pipeline.md` → eval → apply pipeline unchanged.

## Non-Goals

- LinkedIn scraping (deferred — needs proxies; wired-but-disabled path reserved).
- Glassdoor scraping (same reason).
- LLM-driven page extraction (ScrapeGraphAI-style).
- Auto-eval or auto-apply triggered by scan. Scanners are **discovery only**.
- Streamlit dashboard, SQLite FTS5, DuckDB, or any new persistence layer.

## Architecture — 5-tier cascade

| Tier | Source | Cost | Status |
|---|---|---|---|
| T0 | ATS APIs (Greenhouse/Ashby/Lever) | $0, instant | Existing (`scan.mjs`) |
| T1 | Aggregator APIs (RemoteOK/HN/WWR) | $0, instant | Existing (`scan-discover.mjs`) |
| **T2** | **JobSpy → Indeed/Google/ZipRecruiter** | **$0, ~30s/run** | **NEW** |
| T2b | JobSpy → LinkedIn/Glassdoor | needs paid proxies | wired-but-disabled |
| **T3** | **SimplifyJobs READMEs (New-Grad + Internships)** | **$0, instant** | **NEW** |
| T4 | Bespoke page scrape via Playwright + `claude -p` | uses CC subscription | future, not in v1 |

Each tier is independent and idempotent. All write through the same dedup + filter chokepoint (`scan-core.mjs`). Failure of any tier does not affect the others.

## Components

### 1. `scan-core.mjs` (new — refactor extraction)

Extracts the shared logic currently in `scan.mjs`:
- `buildTitleFilter(titleFilter)` → `(title) => boolean`
- `buildLocationFilter(locationFilter)` → `(location) => boolean`
- `loadSeenUrls()` → `Set<string>` (URLs from scan-history.tsv + pipeline.md + applications.md)
- `loadSeenCompanyRoles()` → `Set<string>` (`company::title` keys)
- `appendToPipeline(offers)` (writes to `data/pipeline.md`)
- `appendToScanHistory(offers, date)` (writes to `data/scan-history.tsv`)
- `fetchJsonWithTimeout(url, ms)`
- `parallelFetch(tasks, concurrency)`

**Behavior change**: `scan-history.tsv` gains a **`last_seen`** column. Existing rows backfilled with `last_seen = first_seen` on first write after upgrade. New rows write `first_seen = last_seen = today`. When a URL is re-seen (already in history), `last_seen` updates and a `refreshed` row is appended (audit log).

**Schema:**
```
url	first_seen	last_seen	portal	title	company	status
```

`scan.mjs` is updated to import from `scan-core.mjs`. **Zero behavior change** to its outputs (verified by dry-run before/after diff).

### 2. `scan-aggregators.py` (new — Python sidecar)

A ~50-line one-shot script. Reads `aggregator_queries` from `portals.yml`, calls `jobspy.scrape_jobs` per query, dumps the merged result as JSON to stdout.

```python
#!/usr/bin/env python3
import json, sys, yaml
from jobspy import scrape_jobs

with open("portals.yml") as f:
    cfg = yaml.safe_load(f)

queries = cfg.get("aggregator_queries", [])
all_jobs = []
for q in queries:
    if not q.get("enabled", True):
        continue
    df = scrape_jobs(
        site_name=q.get("sites", ["indeed", "google", "zip_recruiter"]),
        search_term=q["search_term"],
        google_search_term=q.get("google_search_term", q["search_term"]),
        location=q.get("location", ""),
        is_remote=q.get("is_remote", True),
        results_wanted=q.get("results_wanted", 1000),
        hours_old=q.get("hours_old", 24),
        country_indeed="USA",
    )
    if df is None or df.empty:
        continue
    df["__query_name"] = q["name"]
    all_jobs.extend(json.loads(df.to_json(orient="records")))

sys.stdout.write(json.dumps(all_jobs))
```

`requirements.txt`: pinned `python-jobspy==1.1.80` (or latest stable).

### 3. `scan-aggregators.mjs` (new — Node wrapper, ~150 LOC)

- Spawns `python3 scan-aggregators.py` in `.venv/` via `child_process.execFile`. 120s timeout.
- Parses stdout JSON.
- Normalizes each row to `{ title, url, company, location, source }` shape.
- Strips bulky fields (`description`, `emails`, etc.) — eval re-fetches live JD anyway.
- Applies `buildTitleFilter` + `buildLocationFilter` from `scan-core`.
- Dedupes via `loadSeenUrls` + `loadSeenCompanyRoles`.
- Writes via `appendToPipeline` + `appendToScanHistory` with `portal` values: `indeed-jobspy`, `google-jobspy`, `zip-jobspy`.
- On missing venv: prints helpful "run `npm run setup:python`" and exits with code 2 (distinguishable from real failures).
- On Python error: logs stderr, exits with code 1.
- Prints one-line summary: `Aggregators: +12 new, 3 refreshed, 0 errors (Indeed: 8 / Google: 3 / Zip: 1)`.

### 4. `scan-curated.mjs` (new — pure Node, ~100 LOC)

- Fetches `https://raw.githubusercontent.com/SimplifyJobs/New-Grad-Positions/dev/README.md` and `Summer-Internship-Listings/dev/README.md`.
- Markdown table parser: extracts rows from the listings table, skipping headers/separators.
- Each row → `{ company, title, location, applicationUrl, postedAgo }`.
- Drops rows where `postedAgo > 14 days`.
- Applies the standard title/location filter (strict — same as existing). Per-source loose-filter override is a future enhancement.
- Dedupes + writes via `scan-core` with `portal` values: `simplify-newgrad`, `simplify-intern`.
- Summary line: `Curated: +0 new, +2 refreshed (NewGrad: 0 / Intern: 0)`.

### 5. `portals.yml` additions

Appended (does not break existing structure):

```yaml
# -- Recency thresholds (max age, max gap since last refresh) --
recency:
  ats_scan_max_age_days: 14       # for tracked_companies (scan.mjs)
  aggregator_default_hours: 24    # for JobSpy (scan-aggregators.mjs)
  curated_max_age_days: 14        # for SimplifyJobs (scan-curated.mjs)
  discover_max_age_days: 7        # for scan-discover.mjs

# -- Aggregator queries (JobSpy via scan-aggregators.mjs) --
aggregator_queries:
  - name: "AI/ML/Applied AI — Local + Remote US"
    enabled: true
    search_term: '("AI Engineer" OR "Machine Learning Engineer" OR "Applied AI" OR "ML Engineer")'
    google_search_term: 'AI Engineer OR ML Engineer OR Applied AI jobs <YOUR-CITY> OR Remote US since yesterday'
    location: "United States"
    is_remote: true
    hours_old: 24
    results_wanted: 200
    sites: [indeed, google, zip_recruiter]

  - name: "LLM/Agents Engineer — Remote US"
    enabled: true
    search_term: '("LLM Engineer" OR "Agents Engineer" OR "Agentic AI" OR "GenAI Engineer")'
    google_search_term: 'LLM Engineer OR Agents Engineer OR GenAI jobs Remote US since yesterday'
    location: "United States"
    is_remote: true
    hours_old: 24
    results_wanted: 200
    sites: [indeed, google]

  - name: "Forward Deployed / Solutions AI — US"
    enabled: true
    search_term: '("Forward Deployed Engineer" OR "Solutions Engineer" AI OR "Solutions Architect" AI OR "Customer Engineer" AI)'
    google_search_term: 'Forward Deployed Engineer OR Solutions Engineer AI Remote US since yesterday'
    location: "United States"
    is_remote: true
    hours_old: 24
    results_wanted: 200
    sites: [indeed, google]

  - name: "Senior Full-Stack (AI/ML) — Remote US"
    enabled: true
    search_term: '("Senior Full Stack" OR "Senior Software Engineer") (AI OR ML OR LLM)'
    google_search_term: 'Senior Full Stack AI Remote US since yesterday'
    location: "United States"
    is_remote: true
    hours_old: 24
    results_wanted: 200
    sites: [indeed, google]

  - name: "Founding/Product AI Engineer — US"
    enabled: true
    search_term: '("Founding Engineer" OR "Founding AI" OR "Product Engineer") (AI OR LLM OR ML)'
    google_search_term: 'Founding Engineer AI Remote US since yesterday'
    location: "United States"
    is_remote: true
    hours_old: 24
    results_wanted: 200
    sites: [indeed, google]
```

### 6. `package.json` additions

```json
"scripts": {
  "setup:python": "python3 -m venv .venv && .venv/bin/pip install --upgrade pip && .venv/bin/pip install -r requirements.txt",
  "scan:aggregators": "node scan-aggregators.mjs",
  "scan:curated": "node scan-curated.mjs",
  "scan:all": "node scan.mjs && node scan-aggregators.mjs && node scan-curated.mjs && node scan-discover.mjs"
}
```

### 7. `modes/scan.md` additions

Append a Tier-2/Tier-3 documentation section telling the subagent that `npm run scan:all` populates `pipeline.md` from all four sources. No behavior change to the existing `/career-ops scan` flow.

### 8. `/loop` integration

Manual: user types `/loop 1h /career-ops scan` when they want recurring scans. The `/career-ops scan` command runs `npm run scan:all` internally. At hourly cadence, `hours_old: 24` provides ~24× redundancy per posting (acceptable, dedup catches duplicates).

**Silent on no-change**: if no scanner adds anything, `npm run scan:all` exits with no output (just an exit code 0). Loop sessions stay quiet.

## Data Contract

**Files written:**
- `data/pipeline.md` — append-only via `appendToPipeline`
- `data/scan-history.tsv` — append-only, includes new `last_seen` column

**Files NOT touched:**
- `cv.md`, `config/profile.yml`, `modes/_profile.md`, `modes/_shared.md`
- `data/applications.md` (only the eval pipeline writes here, never scanners)
- `reports/*`
- `output/*`

## Testing

1. **Unit-equivalent test**: refactor diff — `scan.mjs --dry-run` output identical before/after `scan-core.mjs` extraction.
2. **Integration test — JobSpy**: `npm run scan:aggregators` against real config, verify ≥1 posting returned, verify JSON parsed cleanly, verify dedup against existing `scan-history.tsv` works.
3. **Integration test — Curated**: `npm run scan:curated` returns parsed rows, applies filter, writes correctly.
4. **End-to-end**: `npm run scan:all` populates `pipeline.md` with new postings, `scan-history.tsv` grows, no duplicates leak.
5. **Liveness verification — Playwright**: spot-check 3-5 randomly sampled URLs from each new source. Navigate, snapshot, confirm posting is live and title matches what the scanner reported. Flag any drift.
6. **Smoke test — eval flow**: pick one new posting, run it through the existing `/career-ops oferta` evaluation. Confirm Block A-G report generates, score lands in expected range, gates fire correctly (citizenship, location).

## Acceptance Criteria

- [ ] `scan.mjs --dry-run` produces byte-identical output before/after refactor.
- [ ] `npm run setup:python` succeeds on the user's machine (Python 3.14, venv).
- [ ] `npm run scan:aggregators` returns ≥1 high-relevance new posting on first run.
- [ ] `npm run scan:curated` parses both READMEs and applies filter (yield may be 0; that's fine).
- [ ] `npm run scan:all` runs end-to-end in <2 minutes, summary line on stdout.
- [ ] Playwright spot-check on 3 sampled URLs per source confirms ground truth.
- [ ] One full eval cycle (scan → pipeline → oferta) completes without errors.
- [ ] If any ≥4.0/5 fits emerge, applications submitted per pre-flight checklist (cold-start mode).

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| JobSpy's Indeed GraphQL endpoint rotates and breaks | Pin version. `scan-aggregators.mjs` exits non-zero on Python error. Other tiers continue working. Fix in next maintenance window. |
| Python 3.14 incompatibility with `python-jobspy` deps | Test `setup:python` early; fall back to `python3.12` if needed (homebrew-managed). |
| SimplifyJobs README format change breaks parser | Defensive markdown parser (skips malformed rows, doesn't crash). Logs row count for sanity. |
| JobSpy returns junk titles ("AI" matched in JD body, not title) | Existing strict `title_filter.negative` already drops most. After first real run, tune. |
| Hourly cadence floods `pipeline.md` with low-quality postings | Strict filter + 24h `hours_old` keep volume bounded. Worst case: silent on no-change keeps the session noise low. |
| LinkedIn flag accidentally enabled without proxies | Disabled by default in `aggregator_queries`. Code path requires explicit `LINKEDIN_PROXIES` env var to activate. |

## What this design explicitly does NOT change

- The eval pipeline (`modes/oferta.md`, `modes/pipeline.md`).
- The apply pipeline (`modes/apply.md`).
- The CV tailoring pipeline (`generate-pdf.mjs`, `generate-latex.mjs`).
- The submission authorization rules (`CLAUDE.md`, `feedback_submission_authorization.md`).
- The auto-discard rules (`feedback_us_citizen_only_blocker.md`).
- The applications tracker (`data/applications.md`) and merge-tracker flow.

Source of a URL is irrelevant after it lands in `pipeline.md`. All downstream rules apply uniformly.

---

## Out of scope for v1 (logged as future work)

- LinkedIn scraping (T2b) — re-enable when proxy decision is made.
- Glassdoor scraping (T2b) — same.
- Bespoke page scrape via Claude Code subprocess (T4).
- ATS keyword-match score (Resume Matcher pattern) — unrelated to scraper, but flagged.
- Auto-loop wiring as a default — user starts loop manually.
- Per-source loose-filter override for SimplifyJobs (allow `New Grad` while still dropping `Intern`).
