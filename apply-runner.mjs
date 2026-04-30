#!/usr/bin/env node
// apply-runner.mjs — orchestration glue for autonomous apply loops.
//
// Pipeline:
//   1. Prefilter URL (location/eligibility/YoE/dedup, 5 sec, no CV build)
//   2. If pass → dispatch eval-agent (caller's job; not done here)
//   3. On READY response from eval-agent → pickAtsKind(url) → call right handler
//   4. Pre-submit: screen all visible questions; if any 'discard' action → abort
//   5. Caller does Submit + tracker update
//
// What this file gives you:
//   • detectAts(url) — 'greenhouse' | 'ashby' | 'lever' | null
//   • runApply({ page, url, company, resumePath, profile, autoSubmit })
//       — runs prefilter → fill → screen; returns verdict for caller
//
// Caller still owns: agent dispatch, CV tailoring, the actual Submit click,
// and tracker / memory updates. This is a tools layer, not a top-level loop.

import { fillGreenhouseStandardFields, screenGreenhouseQuestions } from './apply-greenhouse.mjs';
import { fillAshbyStandardFields } from './apply-ashby.mjs';
import { fillLeverStandardFields } from './apply-lever.mjs';
import { prefilter } from './prefilter.mjs';
import { loadProfile, logStep } from './apply-shared.mjs';
import { assertNotAlreadyApplied, acquireApplyLock, releaseApplyLock } from './dup-guard.mjs';

export function detectAts(url) {
  if (!url) return null;
  const u = url.toLowerCase();
  if (u.includes('greenhouse.io') || u.includes('boards.greenhouse')) return 'greenhouse';
  if (u.includes('ashbyhq.com')) return 'ashby';
  if (u.includes('lever.co')) return 'lever';
  return null;
}

/**
 * Run prefilter → fill standard fields → screen → return verdict.
 * Caller has already navigated `page` to the apply URL and tailored a PDF.
 *
 * @param {object} args
 * @param {import('playwright').Page} args.page
 * @param {string} args.url             apply URL (used for ATS detection + prefilter)
 * @param {string} args.company         company name (for dedup short-circuit)
 * @param {string} args.resumePath      absolute path to tailored PDF
 * @param {object} [args.profile]       override profile (default: loadProfile())
 * @param {boolean} [args.runPrefilter] default true — caller can skip if already prefiltered
 * @returns {Promise<{verdict: 'fill_done'|'discard'|'flag', why: string, details: object}>}
 */
export async function runApply(args) {
  const { page, url, company, role, resumePath, profile = loadProfile(), runPrefilter = true, allowResubmit = false } = args;
  const ats = detectAts(url);
  if (!ats) return { verdict: 'discard', why: 'unknown_ats', details: { url } };

  // ── HARD DUP GATE — runs BEFORE any prefilter / browser nav / fill.
  // Caller can pass allowResubmit:true if user has explicitly authorized a
  // re-application (e.g., after rejection + new role posted at same co).
  if (!allowResubmit) {
    try {
      assertNotAlreadyApplied({ url, company, role });
    } catch (e) {
      if (e.code === 'E_ALREADY_APPLIED') {
        return { verdict: 'discard', why: 'already_applied', details: { error: e.message, existing: e.existing } };
      }
      throw e;
    }
  }

  if (runPrefilter) {
    const pre = await prefilter(url, { profile, company, role });
    if (pre.action === 'discard') {
      return { verdict: 'discard', why: `prefilter:${pre.gate}`, details: pre };
    }
    logStep('runner', `prefilter passed (${ats})`, { url, gate: 'prefilter' });
  }

  // Acquire file-lock so concurrent apply paths can't race on the same URL.
  try {
    acquireApplyLock({ url, company, role });
  } catch (e) {
    return { verdict: 'discard', why: 'lock_held', details: { error: e.message } };
  }

  let fillResult;
  try {
    if (ats === 'greenhouse') {
      fillResult = await fillGreenhouseStandardFields(page, { resumePath, profile });
    } else if (ats === 'ashby') {
      fillResult = await fillAshbyStandardFields(page, { resumePath, profile });
    } else if (ats === 'lever') {
      fillResult = await fillLeverStandardFields(page, { resumePath, profile });
    }
    logStep('runner', `${ats} fill done`, { filled: fillResult.filled?.length, skipped: fillResult.skipped?.length || 0 });
  } finally {
    releaseApplyLock();
  }

  // Pre-submit screen: only Greenhouse exposes labels in a stable structure right now.
  let screen = { discard: false, flags: [], unknowns: [] };
  if (ats === 'greenhouse') {
    screen = await screenGreenhouseQuestions(page);
    if (screen.discard) {
      return { verdict: 'discard', why: 'screening_bank_match', details: { fillResult, screen } };
    }
    if (screen.flags.some(f => f.action === 'fill_and_flag')) {
      // Honest fill, but warn — the honest answer may auto-reject downstream
      return { verdict: 'flag', why: 'fill_and_flag_questions', details: { fillResult, screen } };
    }
  }

  return { verdict: 'fill_done', why: 'all_gates_passed', details: { fillResult, screen } };
}

// CLI smoke-test (no Playwright; just the wiring layer)
if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes('--selftest')) {
    const tests = [
      'https://job-boards.greenhouse.io/figma/jobs/5691886004',
      'https://jobs.ashbyhq.com/elevenlabs/abc',
      'https://jobs.lever.co/superannotate/123',
      'https://example.com/whatever',
    ];
    for (const u of tests) console.log(`${u} → ${detectAts(u)}`);
  }
}
