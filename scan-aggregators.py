#!/usr/bin/env python3
"""
scan-aggregators.py — JobSpy sidecar for career-ops.

Reads aggregator_queries from portals.yml, calls jobspy.scrape_jobs
for each enabled query, dumps merged results as JSON to stdout.

Errors / warnings go to stderr so they don't pollute the JSON payload.

Used by scan-aggregators.mjs as a subprocess.
"""

import json
import sys
import warnings
from pathlib import Path

# Silence noisy pandas / urllib3 warnings on stderr.
warnings.filterwarnings("ignore")

try:
    import yaml
    from jobspy import scrape_jobs
except ImportError as e:
    print(
        f"[scan-aggregators.py] missing Python dep: {e}. "
        f"Run `npm run setup:python`.",
        file=sys.stderr,
    )
    sys.exit(2)


def load_queries(portals_path: Path) -> list[dict]:
    if not portals_path.exists():
        print(
            f"[scan-aggregators.py] {portals_path} not found.", file=sys.stderr
        )
        sys.exit(1)
    with portals_path.open() as f:
        cfg = yaml.safe_load(f)
    return cfg.get("aggregator_queries", []) or []


def normalize_row(row: dict, query_name: str) -> dict:
    """Reduce JobSpy's bulky row to the fields scan-aggregators.mjs needs.

    Prefer job_url_direct (the real ATS URL — Greenhouse/Ashby/Lever/Workday)
    over job_url (the indeed.com tracker URL). Indeed has aggressive Cloudflare
    bot detection that blocks Playwright on every viewjob URL, but the direct
    ATS URLs are uncontested. Many of these URLs naturally dedupe with
    scan.mjs's tracked-companies output too.
    """
    direct = (row.get("job_url_direct") or "").strip()
    fallback = (row.get("job_url") or "").strip()
    # Normalize: unwrap recruitics/jsv3 redirectors, strip utm/ref/src trackers,
    # and drop the direct URL entirely if it lives on a tracker host we cannot
    # unwrap (e.g., jometer/iCIMS-style ones that don't expose the real ATS URL).
    TRACKER_HOSTS = (
        "recruitics.com",
        "jsv3.",
        "jometer.com",
        "tnl2.",
        "click.appcast.io",
        "trk.appcast.io",
        "u.linksynergy.com",
        "redirect.appcast.io",
    )
    if direct:
        from urllib.parse import urlsplit, urlunsplit, parse_qsl, urlencode, unquote

        # Try to unwrap an embedded real URL.
        if "/redirect" in direct or "recruitics.com" in direct:
            parts = urlsplit(direct)
            qs = dict(parse_qsl(parts.query))
            for key in ("rx_url", "url", "redirect", "redirectUrl", "destination"):
                if key in qs and qs[key].startswith("http"):
                    direct = unquote(qs[key])
                    break

        # If still on a tracker host, give up on the direct URL — let
        # scan.mjs catch the canonical posting via tracked_companies, or
        # drop entirely if not tracked.
        host = urlsplit(direct).netloc.lower()
        if any(t in host for t in TRACKER_HOSTS):
            direct = ""
        else:
            parts = urlsplit(direct)
            kept = [
                (k, v)
                for k, v in parse_qsl(parts.query)
                if not k.startswith("utm_")
                and not k.startswith("rx_")
                and k not in {"ref", "src", "source", "lever-source"}
            ]
            direct = urlunsplit(
                (parts.scheme, parts.netloc, parts.path, urlencode(kept), parts.fragment)
            )

    return {
        "title": (row.get("title") or "").strip(),
        "company": (row.get("company") or "").strip(),
        "location": (row.get("location") or "").strip(),
        "url": direct or fallback,
        "url_indeed": fallback,        # always the indeed.com URL (when present)
        "url_direct": direct,          # always the ATS URL (when present)
        "site": row.get("site") or "",
        "date_posted": row.get("date_posted") or "",
        "is_remote": bool(row.get("is_remote")),
        "min_amount": row.get("min_amount"),
        "max_amount": row.get("max_amount"),
        "currency": row.get("currency") or "",
        "interval": row.get("interval") or "",
        "job_type": row.get("job_type") or "",
        "query_name": query_name,
    }


def main() -> int:
    root = Path(__file__).resolve().parent
    portals = root / "portals.yml"
    queries = load_queries(portals)

    if not queries:
        print(
            "[scan-aggregators.py] no aggregator_queries in portals.yml; "
            "nothing to do.",
            file=sys.stderr,
        )
        sys.stdout.write("[]")
        return 0

    all_rows: list[dict] = []
    errors: list[dict] = []

    for q in queries:
        if not q.get("enabled", True):
            continue
        name = q.get("name", "<unnamed>")
        sites = q.get("sites", ["indeed", "google", "zip_recruiter"])
        try:
            df = scrape_jobs(
                site_name=sites,
                search_term=q["search_term"],
                google_search_term=q.get(
                    "google_search_term", q["search_term"]
                ),
                location=q.get("location", ""),
                is_remote=q.get("is_remote", True),
                results_wanted=q.get("results_wanted", 200),
                hours_old=q.get("hours_old", 24),
                country_indeed=q.get("country_indeed", "USA"),
                verbose=0,
            )
        except Exception as e:
            errors.append({"query": name, "error": repr(e)[:200]})
            continue

        if df is None or df.empty:
            print(
                f"[scan-aggregators.py] '{name}' → 0 raw rows", file=sys.stderr
            )
            continue

        rows = json.loads(df.to_json(orient="records"))
        normalized = [normalize_row(r, name) for r in rows if r.get("job_url")]
        print(
            f"[scan-aggregators.py] '{name}' → {len(normalized)} raw rows",
            file=sys.stderr,
        )
        all_rows.extend(normalized)

    payload = {"jobs": all_rows, "errors": errors}
    sys.stdout.write(json.dumps(payload))
    return 0


if __name__ == "__main__":
    sys.exit(main())
