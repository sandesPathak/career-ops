#!/usr/bin/env node

/**
 * scan-curated.mjs — Tier-3 scanner: SimplifyJobs community lists.
 *
 * Pulls two community-maintained README files from GitHub:
 *   1. SimplifyJobs/New-Grad-Positions    (~2,000 rows of new-grad SWE/AI roles)
 *   2. SimplifyJobs/Summer2026-Internships (~1,000 rows of internships)
 *
 * Both repos store listings as HTML tables inside a markdown file. Format:
 *   <tr>
 *     <td><strong><a href="...">CompanyName</a></strong></td>
 *     <td>Role Title</td>
 *     <td>City, ST</br>City2, ST2</td>
 *     <td><a href="https://apply-url">Apply</a></td>   (or 🔒 if closed)
 *     <td>3d</td>                                       (age — 0d, 5mo, 1y)
 *   </tr>
 *
 * Continuation rows use ↳ in the company cell to indicate "same company
 * as the previous row" — we propagate the last-seen company through them.
 *
 * Listings older than recency.curated_max_age_days (default 14) are dropped.
 * Closed listings are skipped. Apply URL must be a non-simplify.jobs URL
 * (those redirect through Simplify's tracker which is fine but adds latency).
 *
 * Pure Node — no Python, no extra deps.
 *
 * Usage:
 *   node scan-curated.mjs              # write new survivors to pipeline.md
 *   node scan-curated.mjs --dry-run    # preview only
 *   node scan-curated.mjs --raw        # dump parsed rows as JSON, no filter
 */

import {
  appendRefreshToScanHistory,
  appendToPipeline,
  appendToScanHistory,
  buildCompanyFilter,
  buildLocationFilter,
  buildTitleFilter,
  fetchTextWithTimeout,
  loadPortalsConfig,
  loadSeenCompanyRoles,
  loadSeenUrls,
  normalizeUrl,
} from './scan-core.mjs';

const SOURCES = [
  {
    portal: 'simplify-newgrad',
    label: 'NewGrad',
    url: 'https://raw.githubusercontent.com/SimplifyJobs/New-Grad-Positions/dev/README.md',
  },
  {
    portal: 'simplify-intern',
    label: 'Intern',
    url: 'https://raw.githubusercontent.com/SimplifyJobs/Summer2026-Internships/dev/README.md',
  },
];

// ── Parsers ─────────────────────────────────────────────────────────

// Strip all HTML tags and entities from a fragment.
function stripHtml(s) {
  return s
    .replace(/<br\s*\/?>/gi, ' / ')
    .replace(/<\/br>/gi, ' / ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

// Extract company name from cell-1: typically <strong><a href="...">Name</a></strong>.
// Falls back to stripped text if no anchor.
function extractCompany(cellHtml) {
  const m = cellHtml.match(/<a[^>]*>([\s\S]*?)<\/a>/);
  if (m) return stripHtml(m[1]);
  return stripHtml(cellHtml);
}

// Extract apply URL from cell-4. The cell typically has 1-2 <a href> links:
// the first to the company's ATS, the second to simplify.jobs/p/{uuid}.
// We want the first non-simplify URL.
function extractApplyUrl(cellHtml) {
  const re = /<a[^>]+href="([^"]+)"/g;
  const candidates = [];
  for (const m of cellHtml.matchAll(re)) {
    const url = m[1];
    if (url.includes('simplify.jobs/p/')) continue;
    if (url.includes('simplify.jobs/c/')) continue; // company landing
    candidates.push(url);
  }
  if (candidates.length === 0) return null;
  // Strip Simplify utm/ref tracking params for cleaner dedup keys
  return candidates[0].replace(/[?&](utm_source|ref)=[^&]*/g, '');
}

function isClosed(cellHtml) {
  return /🔒/.test(cellHtml);
}

// SimplifyJobs legend:
//   🇺🇸 = Requires U.S. Citizenship   → AUTO-DISCARD when config/profile.yml § work_authorization.status != "US Citizen"
//   🛂 = Does NOT offer sponsorship    → OK with EAD (no sponsorship needed)
//   🎓 = Advanced degree required     → informational only (eval pipeline decides)
//   🔥 = FAANG+                        → informational only
function requiresUSCitizenship(rowText) {
  return /🇺🇸/.test(rowText);
}

// Convert age string ("0d", "3d", "5mo", "1y") to days.
function parseAgeDays(s) {
  if (!s) return null;
  const m = s.trim().match(/^(\d+)\s*(d|mo|y)$/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const unit = m[2].toLowerCase();
  if (unit === 'd') return n;
  if (unit === 'mo') return n * 30;
  if (unit === 'y') return n * 365;
  return null;
}

// Parse all <tr>...</tr> rows from a README. Returns an array of:
//   { company, title, location, applyUrl, ageDays, closed }
// Rows with ↳ in cell-1 inherit the previous row's company.
export function parseSimplifyReadme(text) {
  const rows = [];
  const rowRe = /<tr>([\s\S]*?)<\/tr>/g;
  const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/g;
  let lastCompany = null;
  for (const rowMatch of text.matchAll(rowRe)) {
    const inner = rowMatch[1];
    const cells = [];
    for (const cellMatch of inner.matchAll(cellRe)) {
      cells.push(cellMatch[1]);
    }
    if (cells.length < 5) continue;

    let company;
    const companyText = stripHtml(cells[0]);
    if (companyText === '↳' || companyText === '↳' || companyText === '') {
      if (!lastCompany) continue;
      company = lastCompany;
    } else {
      company = extractCompany(cells[0]);
      lastCompany = company;
    }

    const title = stripHtml(cells[1]);
    const location = stripHtml(cells[2]);
    const closed = isClosed(cells[3]);
    const applyUrl = closed ? null : extractApplyUrl(cells[3]);
    const ageDays = parseAgeDays(stripHtml(cells[4]));
    // 🇺🇸 typically lives in the title cell per the README legend.
    const usCitizenOnly = requiresUSCitizenship(cells[1] + cells[2]);

    if (!company || !title) continue;

    rows.push({
      company,
      title,
      location,
      applyUrl,
      ageDays,
      closed,
      usCitizenOnly,
    });
  }
  return rows;
}

// ── Main ────────────────────────────────────────────────────────────

async function fetchSource(src) {
  try {
    const text = await fetchTextWithTimeout(src.url, 15_000);
    return { ...src, text };
  } catch (err) {
    return { ...src, error: err.message };
  }
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const rawDump = args.includes('--raw');

  const config = loadPortalsConfig();
  const titleFilter = buildTitleFilter(config.title_filter);
  const locationFilter = buildLocationFilter(config.location_filter);
  const companyFilter = buildCompanyFilter(config.company_filter);
  const maxAgeDays = config.recency?.curated_max_age_days ?? 14;

  const fetched = await Promise.all(SOURCES.map(fetchSource));

  const allRows = [];
  for (const src of fetched) {
    if (src.error) {
      console.error(`✗ ${src.label}: fetch failed — ${src.error}`);
      continue;
    }
    const rows = parseSimplifyReadme(src.text);
    console.error(`[scan-curated] ${src.label} → ${rows.length} raw rows`);
    for (const r of rows) {
      r.portal = src.portal;
      r.sourceLabel = src.label;
    }
    allRows.push(...rows);
  }

  if (rawDump) {
    process.stdout.write(JSON.stringify(allRows, null, 2));
    return;
  }

  const seenUrls = loadSeenUrls();
  const seenCompanyRoles = loadSeenCompanyRoles();

  const newOffers = [];
  const refreshedUrls = [];
  let closedCulled = 0;
  let noUrlCulled = 0;
  let oldCulled = 0;
  let titleCulled = 0;
  let locationCulled = 0;
  let companyCulled = 0;
  let citizenCulled = 0;
  let dupes = 0;
  const perSource = {};
  for (const src of SOURCES) perSource[src.label] = 0;

  for (const r of allRows) {
    if (r.closed) {
      closedCulled++;
      continue;
    }
    if (!r.applyUrl) {
      noUrlCulled++;
      continue;
    }
    if (r.usCitizenOnly) {
      // Auto-discard per CLAUDE.md eligibility rule when config/profile.yml § work_authorization.status != "US Citizen".
      citizenCulled++;
      continue;
    }
    if (!companyFilter(r.company)) {
      companyCulled++;
      continue;
    }
    if (r.ageDays !== null && r.ageDays > maxAgeDays) {
      oldCulled++;
      continue;
    }
    if (!titleFilter(r.title)) {
      titleCulled++;
      continue;
    }
    if (!locationFilter(r.location)) {
      locationCulled++;
      continue;
    }
    const cleanUrl = normalizeUrl(r.applyUrl);
    if (seenUrls.has(cleanUrl) || seenUrls.has(r.applyUrl)) {
      refreshedUrls.push({ url: cleanUrl, portal: r.portal });
      dupes++;
      continue;
    }
    const key = `${r.company.toLowerCase()}::${r.title.toLowerCase()}`;
    if (seenCompanyRoles.has(key)) {
      dupes++;
      continue;
    }
    seenUrls.add(cleanUrl);
    seenCompanyRoles.add(key);

    newOffers.push({
      title: r.title,
      url: cleanUrl,
      company: r.company,
      location: r.location,
      source: r.portal,
      ageDays: r.ageDays,
    });
    perSource[r.sourceLabel]++;
  }

  const date = new Date().toISOString().slice(0, 10);
  if (!dryRun && newOffers.length > 0) {
    appendToPipeline(newOffers);
    appendToScanHistory(newOffers, date);
  }
  if (!dryRun) {
    for (const r of refreshedUrls) {
      appendRefreshToScanHistory(r.url, date, r.portal);
    }
  }

  const summary =
    `Curated: +${newOffers.length} new, ${refreshedUrls.length} refreshed ` +
    `(NewGrad: ${perSource.NewGrad || 0} / Intern: ${perSource.Intern || 0})`;
  console.log(summary);

  if (process.env.SCAN_VERBOSE) {
    console.log(
      `\n  raw rows: ${allRows.length}\n` +
        `  closed: ${closedCulled}\n` +
        `  no-url: ${noUrlCulled}\n` +
        `  US-citizen-only: ${citizenCulled}\n` +
        `  company-culled: ${companyCulled}\n` +
        `  too-old (>${maxAgeDays}d): ${oldCulled}\n` +
        `  title-culled: ${titleCulled}\n` +
        `  location-culled: ${locationCulled}\n` +
        `  duplicates: ${dupes}\n` +
        `  added: ${newOffers.length}`
    );
  }

  if (dryRun && newOffers.length > 0) {
    console.log('(dry run — nothing written)\n\nWould add:');
    for (const o of newOffers.slice(0, 30)) {
      console.log(
        `  + [${o.source}] ${o.company} | ${o.title} | ${o.location} (${o.ageDays}d ago)`
      );
    }
    if (newOffers.length > 30)
      console.log(`  …and ${newOffers.length - 30} more`);
  }
}

// Only run main() when invoked as a script — not when imported by tests.
import { fileURLToPath as _fileURLToPath } from 'node:url';
const _isMain = process.argv[1] === _fileURLToPath(import.meta.url);
if (_isMain) {
  main().catch((err) => {
    console.error('Fatal:', err.message);
    process.exit(1);
  });
}
