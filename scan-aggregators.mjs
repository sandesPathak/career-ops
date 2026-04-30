#!/usr/bin/env node

/**
 * scan-aggregators.mjs — Tier-2 scanner powered by JobSpy.
 *
 * Spawns scan-aggregators.py inside .venv/, parses JSON, applies the
 * shared title + location filters, dedupes against scan-history.tsv,
 * and appends survivors to pipeline.md.
 *
 * Zero LLM token cost — pure HTTP scraping under the hood.
 *
 * Usage:
 *   node scan-aggregators.mjs                # run all enabled queries, write
 *   node scan-aggregators.mjs --dry-run      # preview, don't write
 *   node scan-aggregators.mjs --json-only    # dump raw JobSpy JSON to stdout
 */

import { existsSync, statSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  appendRefreshToScanHistory,
  appendToPipeline,
  appendToScanHistory,
  buildCompanyFilter,
  buildLocationFilter,
  buildTitleFilter,
  loadPortalsConfig,
  loadSeenCompanyRoles,
  loadSeenUrls,
  normalizeUrl,
} from './scan-core.mjs';

const execFileAsync = promisify(execFile);

const ROOT = dirname(fileURLToPath(import.meta.url));
const VENV_PYTHON = join(ROOT, '.venv', 'bin', 'python3');
const SIDECAR = join(ROOT, 'scan-aggregators.py');
const SIDECAR_TIMEOUT_MS = 10 * 60 * 1000; // 10 min — JobSpy can be slow on Indeed

function abort(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

function preflight() {
  if (!existsSync(VENV_PYTHON)) {
    abort(
      [
        '✗ .venv/bin/python3 not found.',
        '  Run: npm run setup:python',
        '  (creates .venv and installs python-jobspy)',
      ].join('\n'),
      2
    );
  }
  if (!existsSync(SIDECAR)) {
    abort(`✗ ${SIDECAR} not found. Re-run install.`, 2);
  }
  // Sanity check on portals.yml parse (also surfaces early).
  loadPortalsConfig();
}

async function runSidecar() {
  let stdout = '';
  let stderr = '';
  try {
    const result = await execFileAsync(VENV_PYTHON, [SIDECAR], {
      cwd: ROOT,
      timeout: SIDECAR_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024, // 64 MB
    });
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (err) {
    if (err.stderr) stderr = err.stderr;
    if (err.stdout) stdout = err.stdout;
    if (err.code === 2) {
      abort(`✗ sidecar missing deps:\n${stderr}`, 2);
    }
    if (err.killed) {
      abort('✗ sidecar timed out (>10 min). Try fewer queries.', 1);
    }
    abort(`✗ sidecar failed (exit ${err.code}):\n${stderr}`, 1);
  }
  // stderr is informational — print as-is so loop sessions can see per-query yields
  if (stderr.trim()) {
    process.stderr.write(stderr);
  }
  let payload;
  try {
    payload = JSON.parse(stdout);
  } catch (err) {
    abort(
      `✗ sidecar produced non-JSON stdout (first 500 chars):\n${stdout.slice(0, 500)}`,
      1
    );
  }
  return payload;
}

function jobToOffer(job, portal) {
  return {
    title: job.title || '',
    url: job.url || '',
    company: job.company || '',
    location: job.location || '',
    source: portal,
    site: job.site || '',
    date_posted: job.date_posted || '',
    is_remote: !!job.is_remote,
    min_amount: job.min_amount,
    max_amount: job.max_amount,
    currency: job.currency || '',
    interval: job.interval || '',
    query_name: job.query_name || '',
  };
}

function portalForSite(site) {
  switch ((site || '').toLowerCase()) {
    case 'indeed':
      return 'indeed-jobspy';
    case 'google':
      return 'google-jobspy';
    case 'zip_recruiter':
    case 'ziprecruiter':
      return 'zip-jobspy';
    case 'linkedin':
      return 'linkedin-jobspy';
    case 'glassdoor':
      return 'glassdoor-jobspy';
    default:
      return 'unknown-jobspy';
  }
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const jsonOnly = args.includes('--json-only');

  preflight();

  const config = loadPortalsConfig();
  const titleFilter = buildTitleFilter(config.title_filter);
  const locationFilter = buildLocationFilter(config.location_filter);
  const companyFilter = buildCompanyFilter(config.company_filter);

  console.error('Running JobSpy sidecar (this can take a couple of minutes)…');
  const payload = await runSidecar();

  if (jsonOnly) {
    process.stdout.write(JSON.stringify(payload, null, 2));
    return;
  }

  const rawJobs = payload.jobs || [];
  const sidecarErrors = payload.errors || [];

  const seenUrls = loadSeenUrls();
  const seenCompanyRoles = loadSeenCompanyRoles();

  const date = new Date().toISOString().slice(0, 10);
  const newOffers = [];
  const refreshedUrls = [];
  const perSite = { indeed: 0, google: 0, zip_recruiter: 0, other: 0 };
  let titleCulled = 0;
  let locationCulled = 0;
  let companyCulled = 0;
  let invalidCulled = 0;
  let dupes = 0;

  for (const j of rawJobs) {
    if (!j.url || !j.title || !j.company) {
      invalidCulled++;
      continue;
    }
    if (!companyFilter(j.company)) {
      companyCulled++;
      continue;
    }
    if (!titleFilter(j.title)) {
      titleCulled++;
      continue;
    }
    if (!locationFilter(j.location)) {
      locationCulled++;
      continue;
    }
    const cleanUrl = normalizeUrl(j.url);
    if (seenUrls.has(cleanUrl) || seenUrls.has(j.url)) {
      refreshedUrls.push({ url: cleanUrl, portal: portalForSite(j.site) });
      dupes++;
      continue;
    }
    const key = `${j.company.toLowerCase()}::${j.title.toLowerCase()}`;
    if (seenCompanyRoles.has(key)) {
      dupes++;
      continue;
    }
    seenUrls.add(cleanUrl);
    seenCompanyRoles.add(key);
    const portal = portalForSite(j.site);
    const offer = { ...jobToOffer(j, portal), url: cleanUrl };
    newOffers.push(offer);
    if (perSite[j.site] !== undefined) perSite[j.site]++;
    else perSite.other++;
  }

  if (!dryRun && newOffers.length > 0) {
    appendToPipeline(newOffers);
    appendToScanHistory(newOffers, date);
  }
  if (!dryRun) {
    for (const r of refreshedUrls) {
      appendRefreshToScanHistory(r.url, date, r.portal);
    }
  }

  const total =
    perSite.indeed + perSite.google + perSite.zip_recruiter + perSite.other;
  const summary =
    `Aggregators: +${total} new, ${refreshedUrls.length} refreshed, ` +
    `${sidecarErrors.length} errors ` +
    `(Indeed: ${perSite.indeed} / Google: ${perSite.google} / Zip: ${perSite.zip_recruiter})`;
  console.log(summary);

  if (process.env.SCAN_VERBOSE) {
    console.log(
      `\n  raw rows: ${rawJobs.length}\n` +
        `  invalid: ${invalidCulled}\n` +
        `  company-culled: ${companyCulled}\n` +
        `  title-culled: ${titleCulled}\n` +
        `  location-culled: ${locationCulled}\n` +
        `  duplicates: ${dupes}\n` +
        `  added: ${newOffers.length}`
    );
    if (sidecarErrors.length) {
      console.log('\n  sidecar errors:');
      for (const e of sidecarErrors) console.log(`    - ${e.query}: ${e.error}`);
    }
  }

  if (dryRun) {
    console.log('(dry run — nothing written)');
    if (newOffers.length > 0) {
      console.log('\nWould add:');
      for (const o of newOffers.slice(0, 20)) {
        console.log(`  + [${o.source}] ${o.company} | ${o.title} | ${o.location}`);
      }
      if (newOffers.length > 20)
        console.log(`  …and ${newOffers.length - 20} more`);
    }
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
