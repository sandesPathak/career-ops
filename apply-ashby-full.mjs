#!/usr/bin/env node
// apply-ashby-full.mjs — combined fill + finish + submit for Ashby in one CDP session.
//
// Replaces the apply-with-brave + finish-ashby chain when we want a single
// tab and clean state. Closes any existing tabs matching the URL slug before
// opening a fresh one.
//
// Usage:
//   node apply-ashby-full.mjs <apply-url> --resume <pdf> --company "<Co>" --role "<Role>" [--no-submit]

import { chromium } from 'playwright';
import { resolve, basename } from 'node:path';
import { existsSync } from 'node:fs';
import { fillAshbyStandardFields } from './apply-ashby.mjs';
import { assertNotAlreadyApplied } from './dup-guard.mjs';
import { loadFullProfile } from './apply-shared.mjs';

const PROFILE = loadFullProfile();
const AD = PROFILE.application_defaults || {};
const HOME_FULL = AD.location_full || [AD.location_city, [AD.location_state, AD.location_zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
const IS_CITIZEN = ((AD.visa_status || '').toLowerCase().includes('citizen')) && !(AD.visa_status || '').toLowerCase().includes('not');
const NEEDS_SPONSORSHIP = (AD.requires_sponsorship || 'No');
const AUTHORIZED_US = (AD.authorized_to_work_us || 'Yes');
const RELOCATE_YN = /^yes/i.test(String(AD.willing_to_relocate || 'No')) ? 'Yes' : 'No';

const PLAYBOOK = [
  [/require .*sponsorship|require .*visa|require employment visa/i, 'yn', NEEDS_SPONSORSHIP],
  [/located in the United States|currently in the (us|united states)/i, 'yn', 'Yes'],
  [/authorized to work|legally authorized|legally entitled/i, 'yn', AUTHORIZED_US],
  [/willing to relocate/i, 'yn', RELOCATE_YN],
  [/are you a us citizen|U\.S\. citizen/i, 'yn', IS_CITIZEN ? 'Yes' : 'No'],
  [/protected veteran|veteran status/i, 'yn', 'No'],
  [/have a disability|disabled/i, 'yn', 'No'],
  [/(in-person|onsite) interview|attend.*interview/i, 'yn', 'Yes'],
  [/background checks?/i, 'yn', 'Yes'],
  [/city, state.*zip|current city|city and state/i, 'text', HOME_FULL],
  [/years of (relevant )?experience|years.*professional/i, 'text', String(AD.total_yoe || '')],
  [/salary expectation|expected (base )?salary|compensation expectation/i, 'text', String(AD.base_salary_expectation_anchor || '')],
  [/notice period/i, 'text', AD.notice_period || '2 weeks'],
  [/how did you hear|where did you hear/i, 'text', AD.how_did_you_hear || 'LinkedIn'],
];

function lookupAnswer(question) {
  for (const [re, kind, val] of PLAYBOOK) if (re.test(question)) return { kind, val };
  return null;
}

async function fillByLabel(page, labelText, kind, value) {
  const lbl = page.locator('label').filter({ hasText: labelText.slice(0, 60) }).first();
  if (!(await lbl.count())) return { ok: false, reason: 'label-not-found' };
  if (kind === 'yn') {
    const group = lbl.locator(
      'xpath=ancestor::*[descendant::button[normalize-space()="Yes"] and descendant::button[normalize-space()="No"]][1]'
    );
    if (!(await group.count())) return { ok: false, reason: 'no-yn-group' };
    const btn = group.getByRole('button', { name: new RegExp(`^${value}$`, 'i') }).first();
    if (!(await btn.count())) return { ok: false, reason: 'btn-not-found' };
    await btn.scrollIntoViewIfNeeded();
    await btn.click();
    return { ok: true };
  }
  if (kind === 'text') {
    const tb = lbl.locator('xpath=following::input[@type="text" or @type="number" or not(@type)][1] | following::textarea[1]').first();
    if (!(await tb.count())) return { ok: false, reason: 'input-not-found' };
    await tb.scrollIntoViewIfNeeded();
    await tb.click();
    await tb.pressSequentially(String(value), { delay: 35 });
    return { ok: true };
  }
  return { ok: false, reason: `unknown-kind:${kind}` };
}

async function parseMissing(page) {
  const errs = await page.locator('[role="alert"], [class*="error"]').allTextContents();
  const missing = new Set();
  for (const e of errs) {
    const matches = e.matchAll(/Missing entry for required field:\s*([^|]+?)(?=Missing entry for|$)/g);
    for (const m of matches) {
      const q = m[1].trim();
      if (q) missing.add(q);
    }
  }
  return [...missing];
}

async function trySubmit(page) {
  const sub = page.getByRole('button', { name: /submit application/i }).first();
  if (!(await sub.count())) return { submitted: false, reason: 'no-submit-btn' };
  await sub.scrollIntoViewIfNeeded();
  await sub.click();
  await page.waitForTimeout(5000);
  const successPanel = page.locator('[id="form"], [class*="success"], [class*="Success"]').filter({
    hasText: /successfully submitted|application (was )?(received|submitted)/i
  });
  const hasSubmitBtn = await page.getByRole('button', { name: /submit application/i }).count();
  return { submitted: (await successPanel.count()) > 0 && hasSubmitBtn === 0 };
}

function parseArgs(argv) {
  const args = { url: null, resume: null, company: null, role: null, autoSubmit: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--resume') args.resume = argv[++i];
    else if (a === '--company') args.company = argv[++i];
    else if (a === '--role') args.role = argv[++i];
    else if (a === '--no-submit') args.autoSubmit = false;
    else if (a.startsWith('http')) args.url = a;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.url || !args.resume || !args.company) {
    console.error('Usage: node apply-ashby-full.mjs <url> --resume <pdf> --company "<Co>" --role "<Role>" [--no-submit]');
    process.exit(2);
  }
  const resumePath = resolve(args.resume);
  if (!existsSync(resumePath)) throw new Error(`resume not found: ${resumePath}`);

  // Hard dup-guard
  try {
    assertNotAlreadyApplied({ url: args.url, company: args.company, role: args.role });
  } catch (e) {
    if (e.code === 'E_ALREADY_APPLIED') {
      console.error('❌ DUP-GUARD:', e.message);
      process.exit(2);
    }
    throw e;
  }

  const browser = await chromium.connectOverCDP('http://localhost:9222');
  const ctx = browser.contexts()[0];

  // Close any stale tabs already on this URL slug — multi-tab races caused
  // earlier "form-empty after fill" surprises.
  const slug = new URL(args.url).pathname.split('/')[1] || '';
  for (const p of ctx.pages()) {
    if (p.url().toLowerCase().includes(slug.toLowerCase()) && p.url() !== 'about:blank') {
      try { await p.close(); } catch {}
    }
  }

  const page = await ctx.newPage();
  await page.goto(args.url, { waitUntil: 'domcontentloaded' });
  console.log(`[ashby-full] navigated to ${args.url}`);

  await fillAshbyStandardFields(page, { resumePath });
  console.log(`[ashby-full] standard fields filled with ${basename(resumePath)}`);

  if (!args.autoSubmit) {
    console.log('[ashby-full] --no-submit set; leaving for manual finish.');
    await browser.close();
    return;
  }

  // Submit-with-recovery loop
  for (let attempt = 1; attempt <= 4; attempt++) {
    console.log(`\n[ashby-full] submit attempt ${attempt}`);
    const r = await trySubmit(page);
    if (r.submitted) {
      console.log(`✅ SUBMITTED ${args.company} — ${args.role}`);
      await browser.close();
      return;
    }
    const missing = await parseMissing(page);
    if (!missing.length) {
      console.log('❌ submit blocked but no parsed missing-field errors. Body snippet:');
      const body = await page.locator('body').textContent();
      console.log(body.slice(0, 400));
      await browser.close();
      process.exit(1);
    }
    console.log('  missing:', missing);
    let fixed = 0;
    let unmatchedEssay = false;
    for (const q of missing) {
      const ans = lookupAnswer(q);
      if (!ans) {
        if (q.length > 80 || /\?/.test(q)) {
          console.log(`  ⚠ open-ended question, no playbook match: "${q.slice(0, 80)}..."`);
          unmatchedEssay = true;
        } else {
          console.log(`  ⚠ no playbook match: "${q}"`);
        }
        continue;
      }
      const out = await fillByLabel(page, q, ans.kind, ans.val);
      if (out.ok) { console.log(`  ✓ filled "${q.slice(0, 60)}" with ${ans.kind}=${ans.val}`); fixed++; }
      else { console.log(`  ✗ failed "${q.slice(0, 60)}" — ${out.reason}`); }
    }
    if (unmatchedEssay && fixed === 0) {
      console.log('❌ open-ended question(s) without playbook match — cannot auto-answer essays.');
      await browser.close();
      process.exit(3);
    }
    if (fixed === 0) {
      console.log('❌ no progress this round — aborting.');
      await browser.close();
      process.exit(1);
    }
    await page.waitForTimeout(500);
  }
  console.log('❌ exhausted attempts');
  await browser.close();
  process.exit(1);
}

main().catch(e => { console.error('fatal:', e.message); process.exit(1); });
