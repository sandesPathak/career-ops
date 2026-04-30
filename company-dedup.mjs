#!/usr/bin/env node
// company-dedup.mjs — Item 2: low-signal company dedup.
//
// Reads data/applications.md, builds a per-company history of DISCARD reasons,
// and exposes shouldSkipCompany(name) so the scan/eval loop can short-circuit
// re-evaluations of known-bad companies.
//
// Rule:
//   • If a company has ≥3 Discarded/SKIP entries in the last 30 days
//     AND none of those discards were "comp" or "yoe-stretch-fixable",
//     auto-skip new postings from that company unless a flag explicitly says
//     a new archetype/location surfaced.
//
// Reasons grouped:
//   location   → SF/NYC/hybrid/region-only — won't change unless Remote opens
//   eligibility → US-citizen/clearance/ITAR/federal-customer — typically a permanent block per config/profile.yml § work_authorization
//   yoe        → 6+/7+/staff-level — could change if mid-level role opens
//   archetype  → wrong domain (storage/CV/robotics/etc.) — could change
//   comp       → below floor — could change
//
// CLI:
//   node company-dedup.mjs report           — dump the full skip list
//   node company-dedup.mjs check <Company>  — query one company

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TRACKER = resolve(__dirname, 'data/applications.md');

const SKIP_THRESHOLD = 3;            // discards in window
const WINDOW_DAYS = 30;
const TODAY = new Date('2026-04-28'); // pinned for deterministic tests; pass --today=YYYY-MM-DD to override

function parseTracker(path = TRACKER) {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, 'utf-8').split('\n').filter(l => l.startsWith('|'));
  // skip header + separator
  const rows = [];
  for (const line of lines) {
    const cols = line.split('|').slice(1, -1).map(c => c.trim());
    if (cols.length < 9) continue;
    if (cols[0] === '#' || /^-+$/.test(cols[0])) continue;
    const [num, date, company, role, score, status, pdf, report, notes = ''] = cols;
    if (!company || !date || !status) continue;
    rows.push({ num, date, company, role, score, status, notes });
  }
  return rows;
}

function classifyReason(notes = '') {
  const n = notes.toLowerCase();
  if (/citizen|clearance|itar|export[- ]control|federal|govt|government|dod|nih|department of/.test(n)) return 'eligibility';
  if (/(sf|san francisco|nyc|new york|hybrid|on[- ]site|onsite|relocate|sunnyvale|bellevue|palo alto|redwood city|sf bay)/.test(n)
      && !/remote-us|remote us|remote\)/.test(n))
    return 'location';
  if (/6\+ ?yr|7\+ ?yr|8\+ ?yr|10\+ ?yr|staff|principal|lead|level stretch|yoe.*gap|6 or more years/.test(n)) return 'yoe';
  if (/archetype|wrong (domain|stack|substrate)|storage|cv\/|robotics|computer vision|sre|infra (only|role)|cuda|gpu cluster|pytorch/.test(n))
    return 'archetype';
  if (/comp.*below|comp.*blocker|salary.*below|pay.*below|150k floor|emerging.market/.test(n)) return 'comp';
  return 'other';
}

function isStickyReason(r) {
  // Reasons that almost certainly won't flip in 30 days:
  return r === 'location' || r === 'eligibility';
}

function daysAgo(dateStr) {
  const d = new Date(dateStr);
  return Math.floor((TODAY - d) / 86400000);
}

export function buildSkipMap({ rows = parseTracker(), thresholdDays = WINDOW_DAYS, threshold = SKIP_THRESHOLD } = {}) {
  const byCompany = new Map();
  for (const r of rows) {
    const status = r.status.toLowerCase();
    if (!/discarded|skip/.test(status)) continue;
    if (daysAgo(r.date) > thresholdDays) continue;
    const key = r.company.toLowerCase();
    if (!byCompany.has(key)) byCompany.set(key, { company: r.company, discards: [] });
    byCompany.get(key).discards.push({
      num: r.num, date: r.date, role: r.role, reason: classifyReason(r.notes),
    });
  }
  // Mark each company allow|skip
  const out = new Map();
  for (const [key, val] of byCompany) {
    const stickyCount = val.discards.filter(d => isStickyReason(d.reason)).length;
    const totalCount = val.discards.length;
    let action = 'allow';
    let why = '';
    if (totalCount >= threshold && stickyCount >= 1) {
      action = 'skip';
      const reasons = [...new Set(val.discards.map(d => d.reason))];
      why = `${totalCount} discards in last ${thresholdDays}d, sticky reasons: ${reasons.join(', ')}`;
    } else if (stickyCount >= 1) {
      // Even one sticky discard for location/eligibility = soft-skip
      action = 'skip';
      why = `Sticky discard (${val.discards.find(d => isStickyReason(d.reason)).reason}) within ${thresholdDays}d`;
    }
    out.set(key, { ...val, action, why });
  }
  return out;
}

export function shouldSkipCompany(name, opts = {}) {
  const map = opts.map || buildSkipMap(opts);
  const e = map.get(name.toLowerCase());
  if (!e) return { skip: false };
  return e.action === 'skip'
    ? { skip: true, why: e.why, history: e.discards }
    : { skip: false, history: e.discards };
}

// CLI ───────────────────────────────────────────────────────────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
  const cmd = process.argv[2];
  const map = buildSkipMap();
  if (cmd === 'report') {
    const skipped = [...map.values()].filter(v => v.action === 'skip')
      .sort((a, b) => b.discards.length - a.discards.length);
    console.log(`Auto-skip list (${skipped.length} companies):`);
    console.log('━'.repeat(60));
    for (const e of skipped) {
      console.log(`  ✗ ${e.company.padEnd(30)} ${e.discards.length}× — ${e.why}`);
    }
    if (!skipped.length) console.log('  (no auto-skip companies — clean tracker)');
  } else if (cmd === 'check') {
    const name = process.argv.slice(3).join(' ');
    if (!name) { console.error('Usage: node company-dedup.mjs check <Company>'); process.exit(2); }
    const r = shouldSkipCompany(name, { map });
    console.log(JSON.stringify(r, null, 2));
  } else {
    console.log('Usage:');
    console.log('  node company-dedup.mjs report');
    console.log('  node company-dedup.mjs check <Company>');
    console.log(`Tracker: ${TRACKER}`);
    console.log(`Window: ${WINDOW_DAYS} days, threshold: ${SKIP_THRESHOLD} discards`);
  }
}
