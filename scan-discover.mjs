#!/usr/bin/env node
// scan-discover.mjs — discovery-focused scrapper.
//
// Purpose: complement scan.mjs by surfacing AI/engineering roles from public
// aggregators that aren't in portals.yml. Pure additive — never edits user data.
//
// Sources (all public, no login, no Playwright):
//   1. RemoteOK    — https://remoteok.com/api    (JSON, programmer-friendly)
//   2. HN "Who's Hiring" — Algolia HN Search     (latest "Who is hiring?" thread)
//   3. WeWorkRemotely — public HTML              (programming + dev-ops categories)
//
// Default behavior:
//   node scan-discover.mjs                    → DRY-RUN: prints findings to stdout, writes nothing
//   node scan-discover.mjs --commit-pipeline  → appends new role URLs to data/pipeline.md
//   node scan-discover.mjs --commit-suggest   → appends company suggestions to data/discover-suggestions.md
//
// Dedup against:
//   - data/scan-history.tsv (URLs already seen by scan.mjs)
//   - data/discover-history.tsv (URLs already seen by this script)
//   - data/applications.md (companies already evaluated)
//   - data/pipeline.md (URLs already pending)
//
// NEVER touches: cv.md, config/profile.yml, modes/*, portals.yml, applications.md.

import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;

const args = process.argv.slice(2);
const COMMIT_PIPELINE = args.includes('--commit-pipeline');
const COMMIT_SUGGEST = args.includes('--commit-suggest');
const DRY = !COMMIT_PIPELINE && !COMMIT_SUGGEST;

const today = new Date().toISOString().slice(0, 10);

// -----------------------------------------------------------------------------
// Title filtering — mirror portals.yml rules. Keep light to avoid bias.
// -----------------------------------------------------------------------------
const POSITIVE = [
  'ai engineer', 'applied ai', 'machine learning engineer', 'ml engineer',
  'llm engineer', 'genai', 'gen ai', 'agentic', 'ai agent', 'rag',
  'forward deployed', 'fde', 'solutions engineer', 'ai/ml',
  'full stack ai', 'fullstack ai', 'senior software engineer, ai',
  'senior software engineer ai', 'ai software engineer', 'ai platform',
  'mlops', 'llmops', 'prompt engineer', 'evaluation engineer',
];
const NEGATIVE = [
  'intern', 'internship', 'junior', 'entry level', 'entry-level',
  'staff accountant', 'recruiter', 'sales development', 'sdr', 'bdr',
  'account executive', 'designer', 'ux', 'marketing', 'content',
  'attorney', 'lawyer', 'paralegal', 'finance manager', 'accounting',
  'hr business', 'people operations', 'office manager',
  // Pre-sales SA pattern (low historical fit per profile)
  'pre-sales solutions architect',
];
const SENIORITY_BOOST = ['senior', 'sr.', 'sr ', 'staff', 'lead', 'principal'];

// -----------------------------------------------------------------------------
// Location filtering — match config/profile.yml § location_policy (acceptable_local_substrings + acceptable_modes).
// LOC_OK is composed at runtime from generic remote signals plus the candidate's local substrings.
// -----------------------------------------------------------------------------
const _profile = yaml.load(readFileSync('config/profile.yml', 'utf8'));
const _lp = _profile.location_policy || {};
const _localSubs = ((_lp.acceptable_local_substrings && _lp.acceptable_local_substrings.length)
  ? _lp.acceptable_local_substrings
  : [_profile.location?.city, _profile.location?.state].filter(Boolean)
).map(s => String(s).toLowerCase());
const LOC_OK = [
  'remote', 'remote (us)', 'remote us', 'united states', 'usa', 'us only',
  ..._localSubs,
  'anywhere', 'global', 'worldwide',
];
const LOC_BAD = [
  'on-site', 'on site', 'onsite only', '5 days', 'in-office only',
  'sf only', 'san francisco only', 'nyc only', 'new york only',
  'london', 'berlin', 'paris', 'tokyo', 'tel aviv', 'singapore',
  'india only', 'remote (eu)', 'remote (uk)', 'remote eu', 'remote uk',
];

function passesTitle(title) {
  if (!title) return false;
  const t = title.toLowerCase();
  if (NEGATIVE.some(n => t.includes(n))) return false;
  return POSITIVE.some(p => t.includes(p));
}

function passesLocation(location) {
  if (!location) return true; // benefit of the doubt; rescue at JD-time
  const l = String(location).toLowerCase();
  if (LOC_BAD.some(b => l.includes(b))) return false;
  if (LOC_OK.some(g => l.includes(g))) return true;
  // Unknown location → soft-pass; JD will resolve
  return false;
}

function isSeniorish(title) {
  const t = (title || '').toLowerCase();
  return SENIORITY_BOOST.some(s => t.includes(s));
}

// -----------------------------------------------------------------------------
// Dedup sources
// -----------------------------------------------------------------------------
function loadSeenUrls() {
  const seen = new Set();
  const sources = [
    'data/scan-history.tsv',
    'data/discover-history.tsv',
    'data/pipeline.md',
  ];
  for (const path of sources) {
    const full = join(ROOT, path);
    if (!existsSync(full)) continue;
    const text = readFileSync(full, 'utf8');
    const matches = text.match(/https?:\/\/\S+/g) || [];
    for (const u of matches) seen.add(u.replace(/[)\],.;]+$/, ''));
  }
  return seen;
}

function loadSeenCompanies() {
  const seen = new Set();
  const apps = join(ROOT, 'data/applications.md');
  if (!existsSync(apps)) return seen;
  const text = readFileSync(apps, 'utf8');
  for (const line of text.split('\n')) {
    const m = line.match(/^\|\s*\d+\s*\|\s*\d{4}-\d{2}-\d{2}\s*\|\s*([^|]+?)\s*\|/);
    if (m) seen.add(m[1].toLowerCase().trim());
  }
  return seen;
}

// -----------------------------------------------------------------------------
// Source 1: RemoteOK
// -----------------------------------------------------------------------------
async function fetchRemoteOK() {
  try {
    const res = await fetch('https://remoteok.com/api', {
      headers: { 'User-Agent': 'career-ops-discover/1.0' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    // First element is metadata; rest are jobs
    const jobs = Array.isArray(data) ? data.slice(1) : [];
    return jobs.map(j => ({
      title: j.position || j.title || '',
      company: j.company || '',
      url: j.url || j.apply_url || `https://remoteok.com/remote-jobs/${j.id}`,
      location: j.location || (j.tags || []).join(', '),
      tags: j.tags || [],
      source: 'RemoteOK',
    })).filter(j => j.title && j.url);
  } catch (e) {
    return { error: `RemoteOK: ${e.message}` };
  }
}

// -----------------------------------------------------------------------------
// Source 2: HN "Who's Hiring" — via Algolia HN Search (public, no auth)
// -----------------------------------------------------------------------------
async function fetchHNWhoIsHiring() {
  try {
    // Find the latest "Ask HN: Who is hiring?" submission
    const search = await fetch(
      'https://hn.algolia.com/api/v1/search?query=Ask+HN+Who+is+hiring&tags=story&hitsPerPage=5'
    );
    if (!search.ok) throw new Error(`HN search HTTP ${search.status}`);
    const sj = await search.json();
    const thread = (sj.hits || []).find(h => /who is hiring/i.test(h.title || ''));
    if (!thread) throw new Error('No Who-is-hiring thread found');

    // Fetch all comments (top-level only — those are the postings)
    const item = await fetch(`https://hn.algolia.com/api/v1/items/${thread.objectID}`);
    if (!item.ok) throw new Error(`HN item HTTP ${item.status}`);
    const ij = await item.json();
    const comments = ij.children || [];

    // Each top-level comment is one job. Extract URLs and a snippet.
    const jobs = [];
    for (const c of comments) {
      const text = (c.text || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
      if (!text || text.length < 30) continue;
      // Pull URLs
      const urls = (c.text || '').match(/https?:\/\/[^\s"<>]+/g) || [];
      // Best-effort: first line is usually "Company | Role | Location | Remote"
      const firstLine = text.split(/[.|]/)[0].slice(0, 200);
      // Heuristic: extract company name (first |-separated token)
      const parts = text.split('|').map(s => s.trim());
      const company = parts[0]?.slice(0, 80) || '';
      // Try to find role keyword in the first 300 chars
      const blurb = text.slice(0, 300);

      for (const url of urls) {
        const cleanUrl = url.replace(/[)\],.;]+$/, '');
        // Skip generic links
        if (/news\.ycombinator\.com|github\.com\/[^/]+$|twitter\.com|linkedin\.com\/in\//.test(cleanUrl)) continue;
        jobs.push({
          title: blurb.slice(0, 120),
          company,
          url: cleanUrl,
          location: '',
          source: `HN-WhoIsHiring (${thread.title})`,
          context: firstLine,
        });
      }
    }
    return jobs;
  } catch (e) {
    return { error: `HN: ${e.message}` };
  }
}

// -----------------------------------------------------------------------------
// Source 3: WeWorkRemotely — programming + dev-ops categories (RSS)
// -----------------------------------------------------------------------------
async function fetchWWR() {
  const feeds = [
    'https://weworkremotely.com/categories/remote-programming-jobs.rss',
    'https://weworkremotely.com/categories/remote-devops-sysadmin-jobs.rss',
    'https://weworkremotely.com/categories/remote-full-stack-programming-jobs.rss',
    'https://weworkremotely.com/categories/remote-back-end-programming-jobs.rss',
    'https://weworkremotely.com/categories/remote-front-end-programming-jobs.rss',
    'https://weworkremotely.com/categories/all-other-remote-jobs.rss',
  ];
  const results = [];
  for (const feedUrl of feeds) {
    try {
      const res = await fetch(feedUrl, {
        headers: { 'User-Agent': 'career-ops-discover/1.0' },
      });
      if (!res.ok) {
        results.push({ error: `WWR ${feedUrl}: HTTP ${res.status}` });
        continue;
      }
      const xml = await res.text();
      // Lightweight RSS parser
      const items = xml.split('<item>').slice(1);
      for (const raw of items) {
        const title = (raw.match(/<title><!\[CDATA\[([^\]]+)\]\]><\/title>/) || raw.match(/<title>([^<]+)<\/title>/) || [])[1] || '';
        const link = (raw.match(/<link>([^<]+)<\/link>/) || [])[1] || '';
        const region = (raw.match(/<region><!\[CDATA\[([^\]]*)\]\]><\/region>/) || [])[1] || '';
        // WWR title format: "Company: Role"
        const parts = title.split(':').map(s => s.trim());
        const company = parts[0] || '';
        const role = parts.slice(1).join(': ') || title;
        if (!link) continue;
        results.push({
          title: role,
          company,
          url: link.trim(),
          location: region || 'Remote',
          source: 'WeWorkRemotely',
        });
      }
    } catch (e) {
      results.push({ error: `WWR ${feedUrl}: ${e.message}` });
    }
  }
  return results;
}

// -----------------------------------------------------------------------------
// Source 4: Reddit r/forhire — public JSON, "[Hiring]" tagged posts
// -----------------------------------------------------------------------------
async function fetchReddit() {
  const subs = ['forhire', 'remotejs'];
  const results = [];
  for (const sub of subs) {
    try {
      const res = await fetch(`https://www.reddit.com/r/${sub}/new.json?limit=100`, {
        headers: { 'User-Agent': 'career-ops-discover/1.0 (by /u/anon)' },
      });
      if (!res.ok) {
        results.push({ error: `Reddit r/${sub}: HTTP ${res.status}` });
        continue;
      }
      const json = await res.json();
      const posts = json.data?.children || [];
      for (const p of posts) {
        const d = p.data || {};
        const title = d.title || '';
        // r/forhire convention: "[HIRING] Role - Description"
        // r/remotejs less structured — accept both
        if (sub === 'forhire' && !/\[hiring\]/i.test(title)) continue;
        const cleanTitle = title.replace(/^\s*\[hiring\]\s*/i, '').slice(0, 200);
        // Permalink is the canonical URL
        const url = `https://www.reddit.com${d.permalink || ''}`;
        // Selftext often contains a real apply URL — prefer that if present
        const externalUrls = (d.selftext || '').match(/https?:\/\/[^\s)\]"<>]+/g) || [];
        const applyUrl = externalUrls.find(u =>
          /greenhouse|ashby|lever|workable|breezy|workday|smartrecruit|jobvite|bamboo|teamtailor|recruitee|jazzhr|notion\.site/i.test(u)
        );
        results.push({
          title: cleanTitle,
          company: '',
          url: applyUrl || url,
          location: 'Remote', // r/forhire and r/remotejs are remote-by-default
          source: `Reddit r/${sub}`,
          context: (d.selftext || '').slice(0, 200),
        });
      }
    } catch (e) {
      results.push({ error: `Reddit r/${sub}: ${e.message}` });
    }
  }
  return results;
}

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------
async function main() {
  console.log(`Discover scan — ${today}`);
  console.log('━'.repeat(50));

  const [remoteok, hn, wwr, reddit] = await Promise.all([
    fetchRemoteOK(),
    fetchHNWhoIsHiring(),
    fetchWWR(),
    fetchReddit(),
  ]);

  const sources = [];
  if (Array.isArray(remoteok)) sources.push(...remoteok);
  else console.log(`✗ ${remoteok.error}`);
  if (Array.isArray(hn)) sources.push(...hn);
  else console.log(`✗ ${hn.error}`);
  for (const w of (Array.isArray(wwr) ? wwr : [])) {
    if (w.error) console.log(`✗ ${w.error}`);
    else sources.push(w);
  }
  for (const r of (Array.isArray(reddit) ? reddit : [])) {
    if (r.error) console.log(`✗ ${r.error}`);
    else sources.push(r);
  }

  console.log(`Total raw findings:    ${sources.length}`);

  // Filter
  const seenUrls = loadSeenUrls();
  const seenCompanies = loadSeenCompanies();

  let droppedTitle = 0, droppedLocation = 0, droppedDup = 0, droppedCompany = 0;
  const survivors = [];
  for (const j of sources) {
    if (!passesTitle(j.title)) { droppedTitle++; continue; }
    if (!passesLocation(j.location)) { droppedLocation++; continue; }
    if (seenUrls.has(j.url.replace(/[)\],.;]+$/, ''))) { droppedDup++; continue; }
    if (j.company && seenCompanies.has(j.company.toLowerCase().trim())) { droppedCompany++; continue; }
    survivors.push(j);
  }

  // Sort: senior-ish first
  survivors.sort((a, b) => Number(isSeniorish(b.title)) - Number(isSeniorish(a.title)));

  console.log(`Filtered by title:     ${droppedTitle}`);
  console.log(`Filtered by location:  ${droppedLocation}`);
  console.log(`Already-seen URLs:     ${droppedDup}`);
  console.log(`Already-seen company:  ${droppedCompany}`);
  console.log(`New candidates:        ${survivors.length}`);
  console.log('');

  if (survivors.length === 0) {
    console.log('No new findings.');
    return;
  }

  // Group by source
  const bySource = {};
  for (const j of survivors) {
    bySource[j.source] = bySource[j.source] || [];
    bySource[j.source].push(j);
  }

  for (const [src, list] of Object.entries(bySource)) {
    console.log(`\n## ${src} (${list.length})`);
    for (const j of list.slice(0, 30)) {
      console.log(`  + ${j.company || '(unknown)'} | ${j.title.slice(0, 80)} | ${j.location || '?'}`);
      console.log(`    ${j.url}`);
    }
    if (list.length > 30) console.log(`  ... and ${list.length - 30} more`);
  }

  // Commit modes
  if (COMMIT_PIPELINE) {
    const pipelinePath = join(ROOT, 'data/pipeline.md');
    const lines = ['', `<!-- discover-scan ${today} -->`];
    for (const j of survivors) {
      lines.push(`- [ ] ${j.url} | ${j.company || '(unknown)'} | ${j.title.slice(0, 120)}`);
    }
    appendFileSync(pipelinePath, lines.join('\n') + '\n');
    console.log(`\n✓ Appended ${survivors.length} entries to data/pipeline.md`);

    // Also write to discover-history so we don't re-suggest next run
    const histPath = join(ROOT, 'data/discover-history.tsv');
    const histLines = survivors.map(j =>
      [j.url, today, j.source, j.title.slice(0, 120), j.company || '', 'added'].join('\t')
    );
    appendFileSync(histPath, histLines.join('\n') + '\n');
  }

  if (COMMIT_SUGGEST) {
    // Group by company → suggest portal additions
    const byCompany = {};
    for (const j of survivors) {
      if (!j.company) continue;
      byCompany[j.company] = (byCompany[j.company] || 0) + 1;
    }
    const suggestPath = join(ROOT, 'data/discover-suggestions.md');
    const lines = [`\n## Discover scan ${today}`, ''];
    for (const [c, n] of Object.entries(byCompany).sort((a, b) => b[1] - a[1])) {
      lines.push(`- **${c}** — ${n} matching role${n > 1 ? 's' : ''}`);
    }
    appendFileSync(suggestPath, lines.join('\n') + '\n');
    console.log(`\n✓ Wrote company suggestions to data/discover-suggestions.md`);
  }

  if (DRY) {
    console.log(`\n(dry-run — pass --commit-pipeline to append to pipeline.md, or --commit-suggest for company suggestions)`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
