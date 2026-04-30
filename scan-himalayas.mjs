#!/usr/bin/env node

/**
 * scan-himalayas.mjs — Tier-2b scanner: Himalayas.app remote-job board.
 *
 * Hits https://himalayas.app/jobs/api/search (clean public JSON API, no
 * anti-bot, no proxies, no Python). Reads `himalayas_queries` from
 * portals.yml. Each query is a `q=...` search term plus optional limits.
 *
 * Filters:
 *   - locationRestrictions must include "United States" (or empty/null
 *     remote-everywhere — depends on himalayas_us_strict in portals.yml).
 *   - shared title + company filters from scan-core.
 *   - shared dedup against scan-history.tsv + pipeline.md + applications.md.
 *
 * Pure Node. No new deps. ~80 LOC behavior + filter wiring.
 *
 * Usage:
 *   node scan-himalayas.mjs              # write new survivors to pipeline.md
 *   node scan-himalayas.mjs --dry-run    # preview only
 *   node scan-himalayas.mjs --json-only  # dump raw API JSON to stdout
 */

import {
  appendRefreshToScanHistory,
  appendToPipeline,
  appendToScanHistory,
  buildCompanyFilter,
  buildLocationFilter,
  buildTitleFilter,
  fetchJsonWithTimeout,
  loadPortalsConfig,
  loadSeenCompanyRoles,
  loadSeenUrls,
  normalizeUrl,
} from './scan-core.mjs';

const API_BASE = 'https://himalayas.app/jobs/api/search';
const DEFAULT_LIMIT = 200;
const FETCH_TIMEOUT_MS = 20_000;

// ── Pure functions (testable) ────────────────────────────────────────

// Convert one Himalayas job row to the shape the rest of the pipeline expects.
export function himalayasJobToOffer(j) {
  if (!j || !j.applicationLink || !j.title || !j.companyName) return null;
  // locationRestrictions is an array of strings like ["United States", "Canada"];
  // we keep the full string for the location filter to substring-match.
  const loc = (j.locationRestrictions || []).join(', ');
  return {
    title: (j.title || '').trim(),
    url: normalizeUrl(j.applicationLink.trim()),
    company: (j.companyName || '').trim(),
    location: loc,
    source: 'himalayas-api',
    seniority: (j.seniority || []).join(','),
    pubDate: j.pubDate || '',
    minSalary: j.minSalary,
    maxSalary: j.maxSalary,
    currency: j.currency || '',
  };
}

// Test if a job is genuinely US-eligible: locationRestrictions array contains
// "United States" OR is empty (treat empty as "remote anywhere" — caller may
// want to be stricter via himalayas_us_strict).
export function isUSEligible(job, strict = false) {
  const loc = job.locationRestrictions || [];
  if (loc.length === 0) return !strict; // empty = ambiguous; allow unless strict mode
  return loc.some(
    (l) => /united states|usa|us only/i.test(l) || /^us$/i.test(l.trim())
  );
}

// Filter raw rows down to survivors.
export function processJobs(rawJobs, { strict, titleFilter, locationFilter, companyFilter, seenUrls, seenCompanyRoles }) {
  const out = [];
  const refreshes = [];
  const stats = { invalid: 0, nonUS: 0, title: 0, location: 0, company: 0, dupes: 0, kept: 0 };
  for (const j of rawJobs || []) {
    const offer = himalayasJobToOffer(j);
    if (!offer) {
      stats.invalid++;
      continue;
    }
    if (!isUSEligible(j, strict)) {
      stats.nonUS++;
      continue;
    }
    if (!companyFilter(offer.company)) {
      stats.company++;
      continue;
    }
    if (!titleFilter(offer.title)) {
      stats.title++;
      continue;
    }
    if (!locationFilter(offer.location)) {
      stats.location++;
      continue;
    }
    if (seenUrls.has(offer.url) || seenUrls.has(j.applicationLink)) {
      refreshes.push({ url: offer.url, portal: 'himalayas-api' });
      stats.dupes++;
      continue;
    }
    const key = `${offer.company.toLowerCase()}::${offer.title.toLowerCase()}`;
    if (seenCompanyRoles.has(key)) {
      stats.dupes++;
      continue;
    }
    seenUrls.add(offer.url);
    seenCompanyRoles.add(key);
    out.push(offer);
    stats.kept++;
  }
  return { newOffers: out, refreshedUrls: refreshes, stats };
}

// ── Main ────────────────────────────────────────────────────────────

async function fetchQuery(q, limit) {
  const url = `${API_BASE}?q=${encodeURIComponent(q)}&limit=${limit}`;
  return await fetchJsonWithTimeout(url, FETCH_TIMEOUT_MS);
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const jsonOnly = args.includes('--json-only');

  const config = loadPortalsConfig();
  const queries = config.himalayas_queries || [];
  const strict = config.himalayas_us_strict !== false; // default strict
  if (!queries.length) {
    console.error(
      '[scan-himalayas] no himalayas_queries in portals.yml; nothing to do.'
    );
    return;
  }

  const titleFilter = buildTitleFilter(config.title_filter);
  const locationFilter = buildLocationFilter(config.location_filter);
  const companyFilter = buildCompanyFilter(config.company_filter);
  const seenUrls = loadSeenUrls();
  const seenCompanyRoles = loadSeenCompanyRoles();

  const allRaw = [];
  const errors = [];
  for (const q of queries) {
    if (q.enabled === false) continue;
    const limit = q.limit || DEFAULT_LIMIT;
    try {
      const json = await fetchQuery(q.q, limit);
      const jobs = json.jobs || [];
      console.error(
        `[scan-himalayas] '${q.name || q.q}' → ${jobs.length} raw rows (totalCount: ${json.totalCount})`
      );
      allRaw.push(...jobs);
    } catch (err) {
      errors.push({ query: q.name || q.q, error: err.message });
    }
  }

  if (jsonOnly) {
    process.stdout.write(JSON.stringify({ jobs: allRaw, errors }, null, 2));
    return;
  }

  const { newOffers, refreshedUrls, stats } = processJobs(allRaw, {
    strict,
    titleFilter,
    locationFilter,
    companyFilter,
    seenUrls,
    seenCompanyRoles,
  });

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

  console.log(
    `Himalayas: +${newOffers.length} new, ${refreshedUrls.length} refreshed, ${errors.length} errors`
  );

  if (process.env.SCAN_VERBOSE) {
    console.log(
      `\n  raw rows: ${allRaw.length}\n` +
        `  invalid: ${stats.invalid}\n` +
        `  non-US: ${stats.nonUS}\n` +
        `  company-culled: ${stats.company}\n` +
        `  title-culled: ${stats.title}\n` +
        `  location-culled: ${stats.location}\n` +
        `  duplicates: ${stats.dupes}\n` +
        `  added: ${stats.kept}`
    );
    if (errors.length) {
      console.log('\n  errors:');
      for (const e of errors) console.log(`    - ${e.query}: ${e.error}`);
    }
  }

  if (dryRun && newOffers.length > 0) {
    console.log('(dry run — nothing written)\n\nWould add:');
    for (const o of newOffers.slice(0, 30)) {
      console.log(
        `  + [${o.source}] [${o.seniority || '?'}] ${o.company} | ${o.title} | ${o.location}`
      );
    }
    if (newOffers.length > 30)
      console.log(`  …and ${newOffers.length - 30} more`);
  }
}

import { fileURLToPath as _fileURLToPath } from 'node:url';
const _isMain = process.argv[1] === _fileURLToPath(import.meta.url);
if (_isMain) {
  main().catch((err) => {
    console.error('Fatal:', err.message);
    process.exit(1);
  });
}
