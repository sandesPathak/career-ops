// scan-core.mjs — shared filter / dedup / write logic for all scanners.
//
// Used by:
//   scan.mjs              (T0 ATS APIs)
//   scan-aggregators.mjs  (T2 JobSpy)
//   scan-curated.mjs      (T3 SimplifyJobs)
//
// scan-discover.mjs intentionally keeps its own filter constants because it
// applies an additional curated-source heuristic (founder/recruiter signals).

import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  existsSync,
  mkdirSync,
} from 'node:fs';
import yaml from 'js-yaml';
import { buildSkipMap } from './company-dedup.mjs';

export const PORTALS_PATH = 'portals.yml';
export const SCAN_HISTORY_PATH = 'data/scan-history.tsv';
export const PIPELINE_PATH = 'data/pipeline.md';
export const APPLICATIONS_PATH = 'data/applications.md';

export const SCAN_HISTORY_HEADER =
  'url\tfirst_seen\tlast_seen\tportal\ttitle\tcompany\tstatus\n';
const OLD_SCAN_HISTORY_HEADER =
  'url\tfirst_seen\tportal\ttitle\tcompany\tstatus';

mkdirSync('data', { recursive: true });

// ── Config ─────────────────────────────────────────────────────────

export function loadPortalsConfig() {
  if (!existsSync(PORTALS_PATH)) {
    throw new Error('portals.yml not found. Run onboarding first.');
  }
  return yaml.load(readFileSync(PORTALS_PATH, 'utf-8'));
}

// ── Migration: 6-col → 7-col scan-history.tsv ───────────────────────

// Idempotent. No-op if already migrated.
export function ensureScanHistorySchema() {
  if (!existsSync(SCAN_HISTORY_PATH)) {
    writeFileSync(SCAN_HISTORY_PATH, SCAN_HISTORY_HEADER, 'utf-8');
    return;
  }
  const text = readFileSync(SCAN_HISTORY_PATH, 'utf-8');
  const firstLine = text.split('\n', 1)[0];
  if (firstLine === SCAN_HISTORY_HEADER.trim()) return;
  if (firstLine !== OLD_SCAN_HISTORY_HEADER) return; // unknown header, leave alone

  const lines = text.split('\n');
  const out = [SCAN_HISTORY_HEADER.trim()];
  for (const line of lines.slice(1)) {
    if (!line) continue;
    const cols = line.split('\t');
    if (cols.length !== 6) {
      out.push(line);
      continue;
    }
    const [url, first_seen, portal, title, company, status] = cols;
    out.push(
      [url, first_seen, first_seen, portal, title, company, status].join('\t')
    );
  }
  writeFileSync(SCAN_HISTORY_PATH, out.join('\n') + '\n', 'utf-8');
}

// ── Title / location filters ────────────────────────────────────────

// Word-boundary keyword matcher. Avoids the classic substring bug where
// "AI" matches "chAIn" or "ML" matches "fulfilLMent". Punctuation and
// whitespace count as word boundaries, so "AI/ML Engineer", "AI-Engineer",
// and "AI Engineer" all match the keyword "AI" cleanly.
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compileKeywordMatcher(keywords) {
  if (!keywords || keywords.length === 0) return null;
  const parts = keywords.map(escapeRegex).join('|');
  // \b doesn't work next to symbols like "+" or "/", so we use a manual
  // boundary that allows start/end of string OR a non-alphanumeric char.
  // Example: matches "AI" inside "AI/ML", "(AI)", "AI,", etc.
  const boundary = '(?:^|[^A-Za-z0-9])';
  const trailing = '(?:[^A-Za-z0-9]|$)';
  return new RegExp(`${boundary}(?:${parts})${trailing}`, 'i');
}

export function buildTitleFilter(titleFilter) {
  const posMatcher = compileKeywordMatcher(titleFilter?.positive || []);
  const negMatcher = compileKeywordMatcher(titleFilter?.negative || []);
  return (title) => {
    const t = title || '';
    const hasPositive = posMatcher === null ? true : posMatcher.test(t);
    const hasNegative = negMatcher !== null && negMatcher.test(t);
    return hasPositive && !hasNegative;
  };
}

// Company-level blocklist. Used to drop postings from companies that fail
// hard eligibility rules at discovery (federal/defense contractors), or
// from companies whose postings are perpetual noise (staffing firms with
// hundreds of duplicate listings).
//
// Matched by case-insensitive substring against the company field, with
// word-boundary semantics to avoid false positives ("CACI" inside another
// word, etc.).
export function buildCompanyFilter(companyFilter) {
  const negMatcher = compileKeywordMatcher(companyFilter?.negative || []);
  return (company) => {
    if (negMatcher === null) return true;
    return !negMatcher.test(company || '');
  };
}

export function buildLocationFilter(locationFilter) {
  // Locations stay as substring match — they're long phrases ("United States",
  // "San Francisco") where boundaries aren't ambiguous, and substring is
  // forgiving of capitalization / punctuation in raw scrape outputs.
  const positive = (locationFilter?.positive || []).map((k) => k.toLowerCase());
  const negative = (locationFilter?.negative || []).map((k) => k.toLowerCase());
  return (location) => {
    if (!location) return true;
    const lower = location.toLowerCase();
    if (negative.some((k) => lower.includes(k))) return false;
    if (positive.length === 0) return true;
    return positive.some((k) => lower.includes(k));
  };
}

// Auto-skip filter built from applications.md history (company-dedup.mjs).
// Returns a predicate that returns false for companies with sticky-reason
// discards in the last 30 days. Lazy-loaded so scanners that don't need it
// don't pay the parse cost.
//
// Example call from a scanner:
//   const dedupFilter = buildCompanyDedupFilter();
//   if (!dedupFilter(company)) continue;  // skip known-bad
let _dedupMapCache = null;
export function buildCompanyDedupFilter() {
  if (!_dedupMapCache) _dedupMapCache = buildSkipMap();
  const map = _dedupMapCache;
  return (company) => {
    if (!company) return true;
    const e = map.get(company.toLowerCase());
    return !(e && e.action === 'skip');
  };
}

export function resetCompanyDedupCache() {
  _dedupMapCache = null;
}

// ── URL normalization ───────────────────────────────────────────────
// Strip tracking params so the same job posting dedupes consistently
// regardless of which scanner / source first surfaced it.

const URL_DROP_PREFIXES = ['utm_', 'rx_'];
const URL_DROP_EXACT = new Set([
  'ref', 'src', 'source', 'lever-source',
  'cmpid', 'tm_event', 'tm_company', 'tm_job',
]);

export function normalizeUrl(raw) {
  if (!raw) return raw;
  try {
    const u = new URL(raw);
    const keep = [];
    for (const [k, v] of u.searchParams.entries()) {
      if (URL_DROP_PREFIXES.some((p) => k.startsWith(p))) continue;
      if (URL_DROP_EXACT.has(k)) continue;
      keep.push([k, v]);
    }
    u.search = '';
    for (const [k, v] of keep) u.searchParams.set(k, v);
    // Drop trailing slash on root paths to harmonize "/job/123" vs "/job/123/"
    let s = u.toString();
    if (u.pathname.endsWith('/') && u.pathname !== '/') {
      s = s.replace(/\/(\?|$)/, '$1');
    }
    return s;
  } catch {
    return raw;
  }
}

// ── Dedup loaders ───────────────────────────────────────────────────

export function loadSeenUrls() {
  const seen = new Set();
  const add = (u) => {
    if (!u) return;
    seen.add(u);
    seen.add(normalizeUrl(u));
  };

  if (existsSync(SCAN_HISTORY_PATH)) {
    const lines = readFileSync(SCAN_HISTORY_PATH, 'utf-8').split('\n');
    for (const line of lines.slice(1)) {
      const url = line.split('\t')[0];
      add(url);
    }
  }

  if (existsSync(PIPELINE_PATH)) {
    const text = readFileSync(PIPELINE_PATH, 'utf-8');
    for (const match of text.matchAll(/- \[[ x]\] (https?:\/\/\S+)/g)) {
      add(match[1]);
    }
  }

  if (existsSync(APPLICATIONS_PATH)) {
    const text = readFileSync(APPLICATIONS_PATH, 'utf-8');
    for (const match of text.matchAll(/https?:\/\/[^\s|)]+/g)) {
      add(match[0]);
    }
  }

  return seen;
}

export function loadSeenCompanyRoles() {
  const seen = new Set();
  if (existsSync(APPLICATIONS_PATH)) {
    const text = readFileSync(APPLICATIONS_PATH, 'utf-8');
    for (const match of text.matchAll(
      /\|[^|]+\|[^|]+\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|/g
    )) {
      const company = match[1].trim().toLowerCase();
      const role = match[2].trim().toLowerCase();
      if (company && role && company !== 'company') {
        seen.add(`${company}::${role}`);
      }
    }
  }
  return seen;
}

// ── Writers ─────────────────────────────────────────────────────────

export function appendToPipeline(offers) {
  if (offers.length === 0) return;

  let text = readFileSync(PIPELINE_PATH, 'utf-8');

  const marker = '## Pendientes';
  const idx = text.indexOf(marker);
  if (idx === -1) {
    const procIdx = text.indexOf('## Procesadas');
    const insertAt = procIdx === -1 ? text.length : procIdx;
    const block =
      `\n${marker}\n\n` +
      offers
        .map((o) => `- [ ] ${o.url} | ${o.company} | ${o.title}`)
        .join('\n') +
      '\n\n';
    text = text.slice(0, insertAt) + block + text.slice(insertAt);
  } else {
    const afterMarker = idx + marker.length;
    const nextSection = text.indexOf('\n## ', afterMarker);
    const insertAt = nextSection === -1 ? text.length : nextSection;
    const block =
      '\n' +
      offers
        .map((o) => `- [ ] ${o.url} | ${o.company} | ${o.title}`)
        .join('\n') +
      '\n';
    text = text.slice(0, insertAt) + block + text.slice(insertAt);
  }

  writeFileSync(PIPELINE_PATH, text, 'utf-8');
}

export function appendToScanHistory(offers, date) {
  ensureScanHistorySchema();
  const lines =
    offers
      .map(
        (o) =>
          `${o.url}\t${date}\t${date}\t${o.source}\t${o.title}\t${o.company}\tadded`
      )
      .join('\n') + '\n';
  appendFileSync(SCAN_HISTORY_PATH, lines, 'utf-8');
}

// Append a "refreshed" audit row when a scanner re-sees an already-known URL.
// Empty fields for first_seen/title/company because they don't change on refresh;
// the source-of-truth row is the original "added" entry.
export function appendRefreshToScanHistory(url, date, portal) {
  ensureScanHistorySchema();
  appendFileSync(
    SCAN_HISTORY_PATH,
    `${url}\t\t${date}\t${portal}\t\t\trefreshed\n`,
    'utf-8'
  );
}

// ── HTTP helpers ────────────────────────────────────────────────────

const DEFAULT_FETCH_TIMEOUT_MS = 10_000;

export async function fetchJsonWithTimeout(
  url,
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchTextWithTimeout(
  url,
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

// ── Concurrency ─────────────────────────────────────────────────────

export async function parallelFetch(tasks, limit) {
  const results = [];
  let i = 0;
  async function next() {
    while (i < tasks.length) {
      const task = tasks[i++];
      results.push(await task());
    }
  }
  const workers = Array.from(
    { length: Math.min(limit, tasks.length) },
    () => next()
  );
  await Promise.all(workers);
  return results;
}
