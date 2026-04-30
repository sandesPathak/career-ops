#!/usr/bin/env node
// apply-ashby-essays.mjs — fill + submit an Ashby form, including open-ended
// essay answers loaded from a per-application JSON file.
//
// Usage:
//   node apply-ashby-essays.mjs <url> --resume <pdf> --company "<Co>" --role "<Role>" --essays <json-path>
//
// essays.json shape:
//   {
//     "labelSubstring": "essay answer text",
//     ...
//   }
// labelSubstring is matched against the question label (case-insensitive,
// substring). First match wins — order keys most-specific first.
//
// Also handles per-company overrides for combo + radio fields:
//   {
//     "_combobox": [
//       { "label": "country", "option": "United States" }
//     ],
//     "_radio": [
//       { "label": "current age", "option": "I prefer not to answer" },
//       { "label": "gender identity", "option": "Man" }
//     ],
//     ...essay keys above...
//   }

import { chromium } from 'playwright';
import { resolve, basename } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { fillAshbyStandardFields } from './apply-ashby.mjs';
import { assertNotAlreadyApplied } from './dup-guard.mjs';
import { loadFullProfile, connectToBrave } from './apply-shared.mjs';

const PROFILE = loadFullProfile();
const AD = PROFILE.application_defaults || {};
const HOME_FULL = AD.location_full || [AD.location_city, [AD.location_state, AD.location_zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
const IS_CITIZEN = ((AD.visa_status || '').toLowerCase().includes('citizen')) && !(AD.visa_status || '').toLowerCase().includes('not');
const NEEDS_SPONSORSHIP = (AD.requires_sponsorship || 'No');
const AUTHORIZED_US = (AD.authorized_to_work_us || 'Yes');
// willing_to_relocate is a free-text answer in profile.yml (e.g., "No — Remote-US only"); use first token for Y/N.
const RELOCATE_YN = /^yes/i.test(String(AD.willing_to_relocate || 'No')) ? 'Yes' : 'No';

const PLAYBOOK = [
  [/require .*sponsorship|require .*visa|require employment visa/i, 'yn', NEEDS_SPONSORSHIP],
  [/located in the United States|currently in the (us|united states)|live in the AMER/i, 'yn', 'Yes'],
  [/authorized to work|legally authorized|legally entitled/i, 'yn', AUTHORIZED_US],
  [/willing to relocate/i, 'yn', RELOCATE_YN],
  [/are you a us citizen|U\.S\. citizen/i, 'yn', IS_CITIZEN ? 'Yes' : 'No'],
  [/protected veteran|veteran status/i, 'yn', 'No'],
  [/have a disability|disabled/i, 'yn', 'No'],
  [/(in-person|onsite) interview|attend.*interview/i, 'yn', 'Yes'],
  [/background checks?/i, 'yn', 'Yes'],
  [/4\+? years of experience|four \+? years/i, 'yn', (AD.total_yoe || 0) >= 4 ? 'Yes' : 'No'],
  [/city, state.*zip|current city|city and state/i, 'text', HOME_FULL],
  [/years of (relevant )?experience|years.*professional/i, 'text', String(AD.total_yoe || '')],
  [/salary expectation|expected (base )?salary|compensation expectation|desired salary|target salary/i, 'text', String(AD.base_salary_expectation_anchor || '')],
  [/notice period/i, 'text', AD.notice_period || '2 weeks'],
  [/how did you hear|where did you hear/i, 'text', AD.how_did_you_hear || 'LinkedIn'],
];

function lookupAnswer(question) {
  for (const [re, kind, val] of PLAYBOOK) if (re.test(question)) return { kind, val };
  return null;
}

function lookupEssay(question, essayMap) {
  for (const [substr, ans] of Object.entries(essayMap)) {
    if (substr.startsWith('_')) continue;
    if (question.toLowerCase().includes(substr.toLowerCase())) return ans;
  }
  return null;
}

async function fillByLabel(page, labelText, kind, value) {
  const lbl = page.locator('label[for]').filter({ hasText: labelText.slice(0, 60) }).first();
  if (!(await lbl.count())) return { ok: false, reason: 'label-not-found' };
  if (kind === 'yn') {
    // Use document-order proximity: the first Yes/No button AFTER the label
    // is the right one, regardless of how the question is nested.
    const btn = lbl.locator(`xpath=following::button[normalize-space()="${value}"][1]`).first();
    if (!(await btn.count())) return { ok: false, reason: 'btn-not-found' };
    await btn.scrollIntoViewIfNeeded();
    await btn.click();
    return { ok: true };
  }
  if (kind === 'text') {
    // Resolve target via label's `for` so we hit THIS question's input,
    // not "the next text field in document order" (which collides when the
    // error banner re-renders the question text at the top of the form).
    const forId = await lbl.getAttribute('for');
    let tb;
    if (forId) tb = page.locator(`[id="${forId}"]`).first();
    if (!tb || !(await tb.count())) {
      tb = lbl.locator('xpath=following::input[@type="text" or @type="number" or not(@type)][1] | following::textarea[1]').first();
    }
    if (!(await tb.count())) return { ok: false, reason: 'input-not-found' };
    // Idempotent: if already filled with our target value, skip; if filled
    // with garbage from a prior retry, clear first.
    const cur = (await tb.inputValue().catch(() => '')) || '';
    if (cur === String(value)) return { ok: true, reason: 'already-filled' };
    await tb.scrollIntoViewIfNeeded();
    await tb.click();
    if (cur) await tb.fill('');
    await tb.pressSequentially(String(value), { delay: 25 });
    return { ok: true };
  }
  if (kind === 'essay') {
    // Same anti-collision fix: prefer the for=id resolved control, fall back
    // to following:: only if no for attribute. Idempotent — skip if already
    // matches; clear if garbage.
    const forId = await lbl.getAttribute('for');
    let tb;
    if (forId) tb = page.locator(`[id="${forId}"]`).first();
    if (!tb || !(await tb.count())) {
      tb = lbl.locator('xpath=following::textarea[1] | following::input[@type="text"][1]').first();
    }
    if (!(await tb.count())) return { ok: false, reason: 'textarea-not-found' };
    const cur = (await tb.inputValue().catch(() => '')) || '';
    if (cur === String(value)) return { ok: true, reason: 'already-filled' };
    await tb.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
    await tb.click({ timeout: 5000 }).catch(() => {});
    if (!(await tb.isVisible().catch(() => false))) return { ok: false, reason: 'not-visible' };
    if (cur) await tb.fill('');
    await tb.pressSequentially(String(value), { delay: 8 });
    return { ok: true };
  }
  return { ok: false, reason: `unknown-kind:${kind}` };
}

async function fillCombobox(page, labelSubstr, optionText) {
  const lbl = page.locator('label').filter({ hasText: labelSubstr }).first();
  if (!(await lbl.count())) return { ok: false, reason: 'label-not-found' };
  const cb = lbl.locator('xpath=following::*[@role="combobox"][1]').first();
  if (!(await cb.count())) return { ok: false, reason: 'combo-not-found' };
  await cb.scrollIntoViewIfNeeded();
  await cb.click();
  await cb.pressSequentially(optionText, { delay: 30 });
  await page.waitForTimeout(400);
  const opt = page.getByRole('option', { name: new RegExp(optionText, 'i') }).first();
  if (await opt.count()) { await opt.click(); return { ok: true }; }
  return { ok: false, reason: 'option-not-found' };
}

async function fillRadio(page, labelSubstr, optionText) {
  // Ashby radios: visible TEXT for the option is clickable
  const groupLbl = page.locator('label').filter({ hasText: labelSubstr }).first();
  if (!(await groupLbl.count())) return { ok: false, reason: 'group-label-not-found' };
  // Click the option text after the group label, scoped roughly
  const optEl = page.getByText(optionText, { exact: true }).first();
  if (!(await optEl.count())) return { ok: false, reason: 'option-text-not-found' };
  await optEl.scrollIntoViewIfNeeded();
  await optEl.click();
  return { ok: true };
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
  await page.waitForTimeout(2500);
  // Some Ashby tenants no-op the first submit click. Click again if the form
  // is still showing the Submit button.
  const stillThere = await page.getByRole('button', { name: /submit application/i }).count();
  if (stillThere) {
    await sub.click().catch(() => {});
  }
  await Promise.race([
    page.locator('text=/successfully submitted|application (was )?(received|submitted)/i').first().waitFor({ timeout: 10000 }).catch(() => {}),
    page.locator('[role="alert"]').first().waitFor({ timeout: 10000 }).catch(() => {}),
    page.waitForTimeout(8000),
  ]);
  const successPanel = page.locator('[id="form"], [class*="success"], [class*="Success"]').filter({
    hasText: /successfully submitted|application (was )?(received|submitted)/i
  });
  const hasSubmitBtn = await page.getByRole('button', { name: /submit application/i }).count();
  return { submitted: (await successPanel.count()) > 0 && hasSubmitBtn === 0 };
}

function parseArgs(argv) {
  const args = { url: null, resume: null, company: null, role: null, essaysFile: null, dryFill: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--resume') args.resume = argv[++i];
    else if (a === '--company') args.company = argv[++i];
    else if (a === '--role') args.role = argv[++i];
    else if (a === '--essays') args.essaysFile = argv[++i];
    else if (a === '--no-submit') args.dryFill = true;
    else if (a.startsWith('http')) args.url = a;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.url || !args.resume || !args.company) {
    console.error('Usage: node apply-ashby-essays.mjs <url> --resume <pdf> --company "<Co>" --role "<Role>" --essays <json>');
    process.exit(2);
  }
  const resumePath = resolve(args.resume);
  if (!existsSync(resumePath)) throw new Error(`resume not found: ${resumePath}`);
  let essayMap = {};
  if (args.essaysFile) {
    essayMap = JSON.parse(readFileSync(args.essaysFile, 'utf8'));
  }

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

  const browser = await connectToBrave('http://localhost:9222');
  const ctx = browser.contexts()[0];

  // Close stale tabs for this slug
  const slug = new URL(args.url).pathname.split('/')[1] || '';
  for (const p of ctx.pages()) {
    if (p.url().toLowerCase().includes(slug.toLowerCase()) && p.url() !== 'about:blank') {
      try { await p.close(); } catch {}
    }
  }

  const page = await ctx.newPage();
  await page.goto(args.url, { waitUntil: 'domcontentloaded' });
  console.log(`[ashby-essays] navigated to ${args.url}`);

  await fillAshbyStandardFields(page, { resumePath });
  console.log(`[ashby-essays] standard fields filled`);

  // Pre-fill any provided combobox + radio answers
  for (const cfg of (essayMap._combobox || [])) {
    const r = await fillCombobox(page, cfg.label, cfg.option);
    console.log(`  combo "${cfg.label}" → ${cfg.option}: ${r.ok ? 'ok' : r.reason}`);
  }
  for (const cfg of (essayMap._radio || [])) {
    const r = await fillRadio(page, cfg.label, cfg.option);
    console.log(`  radio "${cfg.label}" → ${cfg.option}: ${r.ok ? 'ok' : r.reason}`);
  }

  // Pre-fill: walk every <label> that's directly associated with a textarea
  // or text input. Skip labels that wrap radio/checkbox options (their
  // for-target is type=radio|checkbox).
  const labelsWithTargets = await page.locator('label').evaluateAll(els =>
    els.map(el => {
      const forId = el.getAttribute('for');
      let target = null;
      if (forId) target = document.getElementById(forId);
      if (!target) target = el.querySelector('input, textarea');
      return {
        text: el.textContent?.replace(/\s+/g, ' ').trim() || '',
        targetTag: target?.tagName?.toLowerCase() || null,
        targetType: target?.type || null,
      };
    })
  );
  const fillable = labelsWithTargets.filter(l =>
    l.text.length >= 6 &&
    l.targetTag &&
    (l.targetTag === 'textarea' || (l.targetTag === 'input' && !['radio', 'checkbox', 'file'].includes(l.targetType)))
  );
  console.log(`[ashby-essays] pre-fill pass over ${fillable.length} text-style labels (of ${labelsWithTargets.length} total)`);
  for (const { text: lblTxt } of fillable) {
    const essay = lookupEssay(lblTxt, essayMap);
    if (essay) {
      const out = await fillByLabel(page, lblTxt, 'essay', essay);
      if (out.ok) console.log(`  ✓ pre-essay "${lblTxt.slice(0, 50)}..."`);
      continue;
    }
    const ans = lookupAnswer(lblTxt);
    if (ans && ans.kind === 'text') {
      const out = await fillByLabel(page, lblTxt, ans.kind, ans.val);
      if (out.ok) console.log(`  ✓ pre "${lblTxt.slice(0, 50)}" with ${ans.kind}=${ans.val}`);
    }
  }

  // Separately: walk labels whose target is NOT a text input (group labels
  // for Yes/No question rows) and apply yn-playbook answers via doc-order
  // following-button.
  const groupLabels = labelsWithTargets.filter(l => l.text.length >= 6 && !l.targetTag);
  console.log(`[ashby-essays] yn pass over ${groupLabels.length} group labels`);
  for (const { text: lblTxt } of groupLabels) {
    const ans = lookupAnswer(lblTxt);
    if (ans && ans.kind === 'yn') {
      const out = await fillByLabel(page, lblTxt, ans.kind, ans.val);
      if (out.ok) console.log(`  ✓ yn "${lblTxt.slice(0, 50)}" → ${ans.val}`);
    }
  }

  await page.waitForTimeout(500);

  if (args.dryFill) { console.log('--no-submit set, exiting'); await browser.close(); return; }

  for (let attempt = 1; attempt <= 5; attempt++) {
    console.log(`\n[ashby-essays] submit attempt ${attempt}`);
    const r = await trySubmit(page);
    if (r.submitted) {
      console.log(`✅ SUBMITTED ${args.company} — ${args.role}`);
      await browser.close();
      return;
    }
    const missing = await parseMissing(page);
    if (!missing.length) {
      console.log('❌ submit blocked but no parsed missing-field errors. Snippet:');
      const body = await page.locator('body').textContent();
      console.log(body.slice(0, 400));
      await browser.close();
      process.exit(1);
    }
    console.log('  missing:', missing);
    let fixed = 0;
    for (const q of missing) {
      // Check essay map first (most specific)
      const essay = lookupEssay(q, essayMap);
      if (essay) {
        const out = await fillByLabel(page, q, 'essay', essay);
        if (out.ok) { console.log(`  ✓ essay "${q.slice(0, 50)}..."`); fixed++; continue; }
        else console.log(`  ✗ essay "${q.slice(0, 50)}" — ${out.reason}`);
      }
      // Then playbook
      const ans = lookupAnswer(q);
      if (ans) {
        const out = await fillByLabel(page, q, ans.kind, ans.val);
        if (out.ok) { console.log(`  ✓ "${q.slice(0, 50)}" with ${ans.kind}=${ans.val}`); fixed++; continue; }
        else console.log(`  ✗ "${q.slice(0, 50)}" — ${out.reason}`);
      } else {
        console.log(`  ⚠ no match: "${q.slice(0, 80)}"`);
      }
    }
    if (fixed === 0) {
      console.log('❌ no progress — aborting');
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
