#!/usr/bin/env node
// prefilter.mjs — Item 1: pre-tailor location + YoE + eligibility gate.
//
// Goal: in ~5 sec, decide if a JD URL is worth tailoring a CV for. Most
// Listings expose Location, Location Type, and YoE in the visible header —
// we extract those, run hard rules, and return PASS/DISCARD before any
// agent burns 60+ seconds reading the JD body and building a tailored PDF.
//
// Usage:
//   const verdict = await prefilter(url, profile);
//   if (verdict.action === 'discard') return verdict;
//   // proceed to tailor + apply
//
// CLI:
//   node prefilter.mjs <url>
//   node prefilter.mjs --batch <urls.txt>
//
// Hard rules (any failure → DISCARD, no CV built):
//   • Location must match config/profile.yml § location_policy (Remote-US, plus the candidate's local substrings)
//   • No clearance / US-citizen-only / federal-customer language in header (when config/profile.yml § work_authorization.status != "US Citizen")
//   • YoE floor ≤ profile.yoe_ceiling
//   • Company not in dedup auto-skip list
//
// We do not parse the full JD body here — only the listing header + form
// preamble. If we can't reach the page in 5 sec, return UNKNOWN (let the
// downstream eval agent decide).

import { chromium } from 'playwright';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { loadProfile, matchScreening, logStep } from './apply-shared.mjs';
import { shouldSkipCompany } from './company-dedup.mjs';

const __dirname_pf = dirname(fileURLToPath(import.meta.url));
const TRACKER_PF = resolve(__dirname_pf, 'data/applications.md');

// Returns the list of {company, role} already in Applied/Interview/Offer state.
// Cached on first call.
let _appliedCache = null;
function loadAppliedRoles() {
  if (_appliedCache) return _appliedCache;
  if (!existsSync(TRACKER_PF)) { _appliedCache = []; return _appliedCache; }
  const out = [];
  const lines = readFileSync(TRACKER_PF, 'utf-8').split('\n').filter(l => l.startsWith('|'));
  for (const line of lines) {
    const cols = line.split('|').slice(1, -1).map(c => c.trim());
    if (cols.length < 6) continue;
    const [num, date, company, role, score, status] = cols;
    if (!company || !role) continue;
    if (/^applied|^interview|^offer|^responded/i.test(status)) {
      out.push({ company: company.toLowerCase(), role: role.toLowerCase(), num, date });
    }
  }
  _appliedCache = out;
  return _appliedCache;
}

function findExistingApplication(company, role) {
  if (!company) return null;
  const c = company.toLowerCase();
  const r = (role || '').toLowerCase();
  for (const e of loadAppliedRoles()) {
    if (e.company !== c) continue;
    if (!r) return e;                 // any applied role at this company
    // Fuzzy role match: same words ignoring order/case
    const ew = new Set(e.role.split(/\W+/).filter(w => w.length > 2));
    const rw = new Set(r.split(/\W+/).filter(w => w.length > 2));
    const overlap = [...rw].filter(w => ew.has(w)).length;
    if (overlap >= Math.max(2, Math.min(rw.size, ew.size) - 1)) return e;
  }
  return null;
}

const STAGE = 'prefilter';
const TIMEOUT_MS = 8000;

// Sticky red flags that appear in JD/listing headers — short circuit to DISCARD.
const ELIG_BLOCKERS = [
  /us[- ]citizen(ship)?\s*(only|required)/i,
  /must be (a )?us citizen/i,
  /us person required/i,
  /itar[- ]restricted|export[- ]control(led)?/i,
  /active (security )?clearance/i,
  /ts[\/ ]sci|top secret|secret clearance|public trust/i,
  /federal contractor.*citizen/i,
];

// Hybrid postings anchored to a city other than the candidate's local area (config/profile.yml § location_policy.acceptable_local_substrings).
// The negative lookahead in the last entry is a hint — the eval agent / form-stage gate makes the final call.
const HYBRID_NON_LOCAL = [
  /san francisco|sf bay|sunnyvale|palo alto|mountain view|redwood city|menlo park/i,
  /\b(nyc|new york)\b.*(hybrid|on[- ]site|onsite|3 days|days a week)/i,
  /seattle.*hybrid/i,
  /boston.*hybrid/i,
  /\bhybrid\b(?!.*remote)/i,
];

// Build a "local-friendly" regex from config/profile.yml § location_policy.acceptable_local_substrings.
// Falls back to location.city/location.state when that section isn't set.
const LOCAL_RE = (() => {
  try {
    const p = yaml.load(readFileSync('config/profile.yml', 'utf8'));
    const lp = p.location_policy || {};
    const subs = ((lp.acceptable_local_substrings && lp.acceptable_local_substrings.length)
      ? lp.acceptable_local_substrings
      : [p.location?.city, p.location?.state].filter(Boolean)).map(s => String(s).toLowerCase());
    if (!subs.length) return null;
    return new RegExp(`\\b(${subs.map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'i');
  } catch { return null; }
})();

const REMOTE_OK = [
  /\bremote[- ](us|usa|united states|north america)\b/i,
  /\bdistributed[- ]us/i,
  /\bremote\s*\(us\b/i,
  /\bdistributed locations?:\s*united states\b/i,
  /\bremote\b.*\bus\b/i,
  ...(LOCAL_RE ? [LOCAL_RE] : []),
];

// Look for YoE floor in header
function extractYoeFloor(text) {
  const m = text.match(/(\d{1,2})\+?\s*(?:years|yrs)\s*(?:of\s*)?(?:experience|professional|software|engineering)/i);
  return m ? Number(m[1]) : null;
}

async function fetchHeaderText(url) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ userAgent: 'Mozilla/5.0 (Macintosh) AppleWebKit/537 Chrome/130 Safari/537' });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
    // SPAs (Ashby, Lever) often render empty body until JS hydrates — wait briefly.
    for (let i = 0; i < 5; i++) {
      const t = await page.evaluate(() => (document.body?.innerText || '').length);
      if (t > 200) break;
      await page.waitForTimeout(400);
    }
    const text = await page.evaluate(() => (document.body?.innerText || '').slice(0, 3000));
    return text;
  } finally {
    await browser.close();
  }
}

export async function prefilter(url, opts = {}) {
  const profile = opts.profile || loadProfile();
  const company = opts.company || null;
  const reasons = [];

  // 1a. Already-applied gate — don't re-submit roles already in Applied/Interview/Offer.
  if (company) {
    const existing = findExistingApplication(company, opts.role);
    if (existing) {
      return {
        action: 'discard',
        gate: 'already_applied',
        reason: `Already applied to ${existing.company}/${existing.role} on ${existing.date} (#${existing.num})`,
        existing,
      };
    }
  }

  // 1b. Company-level dedup gate (sticky DISCARDs in last 30d)
  if (company) {
    const dedup = shouldSkipCompany(company);
    if (dedup.skip) {
      return { action: 'discard', gate: 'company_dedup', reason: dedup.why, history: dedup.history };
    }
  }

  let header;
  try {
    header = await fetchHeaderText(url);
  } catch (e) {
    return { action: 'unknown', gate: 'fetch_failed', reason: e.message };
  }

  // 2. Eligibility blockers
  for (const re of ELIG_BLOCKERS) {
    const m = header.match(re);
    if (m) return { action: 'discard', gate: 'eligibility', reason: `Eligibility blocker: ${m[0]}`, header_snippet: header.slice(0, 200) };
  }

  // 3. Location: must have Remote-US signal OR match the candidate's local cities (config/profile.yml § location_policy.acceptable_local_substrings)
  const remoteSignal = REMOTE_OK.some(re => re.test(header));
  for (const re of HYBRID_NON_LOCAL) {
    if (re.test(header) && !remoteSignal) {
      const m = header.match(re);
      return { action: 'discard', gate: 'location', reason: `Hybrid/on-site non-local: ${m[0]}`, header_snippet: header.slice(0, 200) };
    }
  }
  if (!remoteSignal) {
    reasons.push('no explicit Remote-US signal in header — let downstream eval agent verify');
  }

  // 4. YoE floor
  const yoeFloor = extractYoeFloor(header);
  if (yoeFloor != null && yoeFloor > (profile.yoe_ceiling || 5)) {
    return { action: 'discard', gate: 'yoe_floor', reason: `JD asks ${yoeFloor}+ years, candidate's ceiling is ${profile.yoe_ceiling}`, header_snippet: header.slice(0, 200) };
  }

  // 5. Run screening-bank patterns over the header — catches "located in SF Bay or NYC" etc.
  const screen = matchScreening(header);
  if (screen?.action === 'discard') {
    return { action: 'discard', gate: 'screening_bank', reason: `Bank match: ${screen.matched_pattern} → ${screen.honest_answer}`, header_snippet: header.slice(0, 200) };
  }

  return {
    action: 'pass',
    yoe_floor: yoeFloor,
    remote_signal: remoteSignal,
    notes: reasons,
  };
}

// CLI ─────────────────────────────────────────────────────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  if (!args.length) {
    console.log('Usage: node prefilter.mjs <url> [--company "Name"]');
    console.log('       node prefilter.mjs --batch <urls.txt>');
    process.exit(0);
  }
  const company = (() => {
    const i = args.indexOf('--company');
    return i >= 0 ? args[i + 1] : null;
  })();
  const url = args.find(a => a.startsWith('http'));
  if (!url) { console.error('No URL provided'); process.exit(2); }
  prefilter(url, { company }).then(v => {
    console.log(JSON.stringify(v, null, 2));
    process.exit(v.action === 'discard' ? 1 : 0);
  }).catch(e => { console.error(e); process.exit(2); });
}
