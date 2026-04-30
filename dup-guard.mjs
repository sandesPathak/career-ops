#!/usr/bin/env node
// dup-guard.mjs — HARD RUNTIME GUARD: prevent any duplicate submission.
//
// This is the last-line defense. Even if prefilter is bypassed, even if the
// agent doesn't check, even if I forget — every apply path MUST call
// assertNotAlreadyApplied() before navigating to a Submit URL.
//
// Layers of defense (today's failure was that only layer 1 existed and it
// was added AFTER the dup; this file makes layers 2-4 enforceable):
//
//   1. prefilter.mjs                 — pre-tailor gate (best-effort, fast)
//   2. assertNotAlreadyApplied()     — HARD throw before any browser nav
//   3. apply-runner.mjs              — wraps assertNotAlreadyApplied() into runApply()
//   4. tracker_lock                  — written to data/.applying.lock during a fill;
//                                      checked by other processes / future wakeups
//
// Matching policy:
//   - Same Greenhouse/Ashby/Lever job URL (after URL normalization) → ALWAYS DUP
//   - Same company (case-insensitive) AND fuzzy role-token overlap ≥ 70% → DUP
//   - Statuses that count as "already applied": Applied, Interview, Offer,
//     Responded, Rejected. (Rejected counts because re-applying after rejection
//     within ~6 months is a red flag at most ATS recruiters.)
//
// This file is intentionally small and dependency-free so it can be
// imported by any future apply path including agents that don't read CLAUDE.md.

import { readFileSync, existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TRACKER = resolve(__dirname, 'data/applications.md');
const LOCK = resolve(__dirname, 'data/.applying.lock');

// Same logic as scan-core.mjs#normalizeUrl, kept local to avoid the dep cycle.
function normalizeUrl(raw) {
  if (!raw) return '';
  try {
    const u = new URL(raw);
    const keep = [];
    for (const [k, v] of u.searchParams.entries()) {
      if (k.startsWith('utm_') || k.startsWith('rx_')) continue;
      if (['ref', 'src', 'source', 'lever-source', 'cmpid', 'tm_event', 'tm_company', 'tm_job'].includes(k)) continue;
      keep.push([k, v]);
    }
    u.search = '';
    for (const [k, v] of keep) u.searchParams.set(k, v);
    let s = u.toString();
    if (u.pathname.endsWith('/') && u.pathname !== '/') s = s.replace(/\/(\?|$)/, '$1');
    return s.toLowerCase();
  } catch {
    return raw.toLowerCase();
  }
}

const APPLIED_STATUSES = /^(applied|interview|offer|responded|rejected)/i;

let _cache = null;
function loadAppliedSet() {
  if (_cache) return _cache;
  if (!existsSync(TRACKER)) { _cache = { byUrl: new Map(), byCompany: new Map(), all: [] }; return _cache; }
  const byUrl = new Map();
  const byCompany = new Map();
  const all = [];
  for (const line of readFileSync(TRACKER, 'utf-8').split('\n')) {
    if (!line.startsWith('|')) continue;
    const cols = line.split('|').slice(1, -1).map(c => c.trim());
    if (cols.length < 6) continue;
    const [num, date, company, role, score, status, , , notes = ''] = cols;
    if (!company || !role) continue;
    if (!APPLIED_STATUSES.test(status)) continue;
    const entry = { num, date, company, role, status, notes };
    all.push(entry);
    // Pull every URL out of notes/report column (we URL-match for hardest dedup)
    for (const m of (notes + ' ' + (cols[7] || '')).matchAll(/https?:\/\/[^\s|)]+/g)) {
      byUrl.set(normalizeUrl(m[0]), entry);
    }
    const key = company.toLowerCase();
    if (!byCompany.has(key)) byCompany.set(key, []);
    byCompany.get(key).push(entry);
  }
  _cache = { byUrl, byCompany, all };
  return _cache;
}

export function resetCache() { _cache = null; }

// Fuzzy role match: token overlap of role tokens length>2.
function rolesMatch(a, b) {
  const ta = new Set((a || '').toLowerCase().split(/\W+/).filter(w => w.length > 2));
  const tb = new Set((b || '').toLowerCase().split(/\W+/).filter(w => w.length > 2));
  if (ta.size === 0 || tb.size === 0) return false;
  const overlap = [...ta].filter(t => tb.has(t)).length;
  const minSize = Math.min(ta.size, tb.size);
  return overlap / minSize >= 0.7;
}

/**
 * Check if a (url, company, role) tuple has already been applied to.
 * Returns null if safe; returns {existing, match_kind} if duplicate.
 */
export function findDuplicate({ url, company, role } = {}) {
  const idx = loadAppliedSet();
  if (url) {
    const hit = idx.byUrl.get(normalizeUrl(url));
    if (hit) return { existing: hit, match_kind: 'url' };
  }
  if (company) {
    const candidates = idx.byCompany.get(company.toLowerCase()) || [];
    for (const c of candidates) {
      if (rolesMatch(c.role, role || '')) return { existing: c, match_kind: 'company+role' };
    }
    // If only company is given (role unknown), block as safe default if 1+ Applied exists.
    if (!role && candidates.length > 0) {
      return { existing: candidates[0], match_kind: 'company_only', soft: true };
    }
  }
  return null;
}

/**
 * HARD GUARD — call this from every apply path BEFORE navigating to a Submit URL.
 * Throws on duplicate; safe to swallow with try/catch only if caller has explicit
 * user authorization to resubmit (e.g., "yes, re-apply after rejection").
 */
export function assertNotAlreadyApplied({ url, company, role } = {}) {
  const dup = findDuplicate({ url, company, role });
  if (!dup) return;
  if (dup.soft) {
    // Company-only match (role unknown) — log but don't throw.
    process.stderr.write(`[dup-guard] WARN: ${company} has a prior Applied entry (#${dup.existing.num}, role=${dup.existing.role}). Verify role differs before submitting.\n`);
    return;
  }
  const e = dup.existing;
  const err = new Error(
    `DUP-GUARD: refusing to apply — already applied to ${e.company}/${e.role} on ${e.date} (#${e.num}, status=${e.status}). Match: ${dup.match_kind}.`
  );
  err.code = 'E_ALREADY_APPLIED';
  err.existing = e;
  throw err;
}

// File-lock helpers — prevent two apply paths racing on the same role.
export function acquireApplyLock(payload) {
  if (existsSync(LOCK)) {
    const text = readFileSync(LOCK, 'utf-8');
    throw new Error(`E_LOCK_HELD: another apply path holds ${LOCK}: ${text}`);
  }
  writeFileSync(LOCK, JSON.stringify({ ...payload, started_at: new Date().toISOString() }), 'utf-8');
}
export function releaseApplyLock() {
  try { unlinkSync(LOCK); } catch { /* already gone */ }
}

// CLI ─────────────────────────────────────────────────────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
  const cmd = process.argv[2];
  if (cmd === 'check') {
    const url = process.argv[3];
    const company = process.argv[4];
    const role = process.argv.slice(5).join(' ');
    try {
      assertNotAlreadyApplied({ url, company, role });
      console.log(JSON.stringify({ ok: true, msg: 'safe to apply' }));
    } catch (e) {
      console.log(JSON.stringify({ ok: false, code: e.code, error: e.message, existing: e.existing }, null, 2));
      process.exit(1);
    }
  } else if (cmd === 'list') {
    const idx = loadAppliedSet();
    console.log(`${idx.all.length} applied/interview/offer/rejected/responded entries.`);
    for (const e of idx.all.slice(-15)) {
      console.log(`  #${e.num.padEnd(4)} ${e.date}  ${e.company.padEnd(24)} ${e.status.padEnd(11)} — ${e.role}`);
    }
  } else {
    console.log('Usage:');
    console.log('  node dup-guard.mjs check <url|""> <company> <role>');
    console.log('  node dup-guard.mjs list');
  }
}
