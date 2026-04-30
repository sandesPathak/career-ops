#!/usr/bin/env node
// finish-ashby.mjs — generic post-fill recovery + submit for Ashby forms.
//
// Use after running apply-with-brave.mjs --cdp on an Ashby URL: that gets
// resume + name/email/phone/links in. This script then tries to Submit, and
// for each "Missing entry for required field: <Q>" error, looks up the
// answer (Yes/No or text) from a lightweight playbook keyed on regex
// against the question text. Retries up to 3 times.
//
// Usage:
//   node finish-ashby.mjs <url-substring-to-target-tab>
//
// Example:
//   node finish-ashby.mjs drata
//   node finish-ashby.mjs sardine
//
// The playbook below covers questions commonly seen on Ashby forms.
// Values are pulled from config/profile.yml (location_policy + work_authorization
// + application_defaults) so this script works for any contributor without edits.

import { chromium } from 'playwright';
import { loadFullProfile, connectToBrave } from './apply-shared.mjs';

const PROFILE = loadFullProfile();
const AD = PROFILE.application_defaults || {};
const HOME_FULL = AD.location_full || [AD.location_city, [AD.location_state, AD.location_zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
const IS_CITIZEN = ((AD.visa_status || '').toLowerCase().includes('citizen')) && !(AD.visa_status || '').toLowerCase().includes('not');
const NEEDS_SPONSORSHIP = (AD.requires_sponsorship || 'No');
const AUTHORIZED_US = (AD.authorized_to_work_us || 'Yes');
const RELOCATE_YN = /^yes/i.test(String(AD.willing_to_relocate || 'No')) ? 'Yes' : 'No';

const PLAYBOOK = [
  // [matcher, kind, value]
  // Yes/No questions (kind: 'yn')
  [/require .*sponsorship|require .*visa|require employment visa/i, 'yn', NEEDS_SPONSORSHIP],
  [/located in the United States|currently in the (us|united states)/i, 'yn', 'Yes'],
  [/authorized to work|legally authorized|legally entitled/i, 'yn', AUTHORIZED_US],
  [/willing to relocate/i, 'yn', RELOCATE_YN],
  [/are you a us citizen|U\.S\. citizen/i, 'yn', IS_CITIZEN ? 'Yes' : 'No'],
  [/protected veteran|veteran status/i, 'yn', 'No'],
  [/disability|disabled/i, 'yn', 'No'],
  // Text questions (kind: 'text')
  [/city, state.*zip|current city|city and state/i, 'text', HOME_FULL],
  [/years of (relevant )?experience|years.*professional/i, 'text', String(AD.total_yoe || '')],
  [/salary expectation|expected (base )?salary|compensation expectation/i, 'text', String(AD.base_salary_expectation_anchor || '')],
  [/notice period/i, 'text', AD.notice_period || '2 weeks'],
  [/how did you hear|where did you hear/i, 'text', AD.how_did_you_hear || 'LinkedIn'],
];

function lookupAnswer(question) {
  for (const [re, kind, val] of PLAYBOOK) {
    if (re.test(question)) return { kind, val };
  }
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
  await page.waitForTimeout(4500);
  // Ashby success: page swaps the form for a "Success" panel. Scope the
  // check to the form region, not the whole body (JD copy can contain
  // "thank you" / "successfully" verbiage that produces false positives).
  const successPanel = page.locator('[id="form"], [class*="success"], [class*="Success"]').filter({ hasText: /successfully submitted|application (was )?(received|submitted)/i });
  const submitBtnGone = !(await page.getByRole('button', { name: /submit application/i }).count());
  const successHit = await successPanel.count();
  return { submitted: successHit > 0 && submitBtnGone };
}

async function main() {
  const urlNeedle = (process.argv[2] || '').toLowerCase();
  if (!urlNeedle) { console.error('Usage: node finish-ashby.mjs <url-substring>'); process.exit(2); }

  const browser = await connectToBrave('http://localhost:9222');
  const ctx = browser.contexts()[0];
  const pages = ctx.pages();
  const page = pages.find(p => p.url().toLowerCase().includes(urlNeedle)) || pages.at(-1);
  console.log('targeting:', page.url());

  for (let attempt = 1; attempt <= 4; attempt++) {
    console.log(`\n--- attempt ${attempt} ---`);
    const result = await trySubmit(page);
    if (result.submitted) {
      console.log('✅ SUBMITTED:', page.url());
      await browser.close();
      return;
    }
    const missing = await parseMissing(page);
    if (!missing.length) {
      console.log('❌ submit failed but no parsed errors. Body snippet:');
      const body = await page.locator('body').textContent();
      console.log(body.slice(0, 500));
      await browser.close();
      process.exit(1);
    }
    console.log('missing fields:', missing);
    let fixed = 0;
    for (const q of missing) {
      const ans = lookupAnswer(q);
      if (!ans) { console.log('  ⚠ no playbook match:', q); continue; }
      const out = await fillByLabel(page, q, ans.kind, ans.val);
      if (out.ok) { console.log(`  ✓ filled "${q.slice(0, 60)}" with ${ans.kind}=${ans.val}`); fixed++; }
      else { console.log(`  ✗ failed "${q.slice(0, 60)}" — ${out.reason}`); }
    }
    if (!fixed) {
      console.log('❌ no progress this round — aborting to avoid loop.');
      await browser.close();
      process.exit(1);
    }
    await page.waitForTimeout(500);
  }

  console.log('❌ exhausted 4 attempts, giving up');
  await browser.close();
  process.exit(1);
}

main().catch(e => { console.error('fatal:', e.message); process.exit(1); });
