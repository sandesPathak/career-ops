#!/usr/bin/env node
// apply-greenhouse-essays.mjs — fill + submit a Greenhouse form, including
// open-ended essay answers and per-tenant screening questions.
//
// Modeled on apply-ashby-essays.mjs. Greenhouse differences:
//   • Yes/No is a react-select COMBOBOX (clickable, lists options on focus),
//     not button-row.
//   • Essay textareas live inside .field/.application-question wrappers.
//   • Submit button text is "Submit Application".
//   • Errors render inline next to each field (.error or [class*="error"]),
//     no consolidated banner — so we walk question wrappers to find errored ones.
//
// Usage:
//   node apply-greenhouse-essays.mjs <url> --resume <pdf> --company "<Co>"
//     --role "<Role>" --essays <json>

import { chromium } from 'playwright';
import { resolve, basename } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { fillGreenhouseStandardFields } from './apply-greenhouse.mjs';
import { assertNotAlreadyApplied } from './dup-guard.mjs';
import { loadFullProfile, connectToBrave } from './apply-shared.mjs';

const PROFILE = loadFullProfile();
const AD = PROFILE.application_defaults || {};
const HOME_CITY = AD.location_city || '';
const HOME_STATE = AD.location_state || '';
const HOME_FULL = AD.location_full || [HOME_CITY, [HOME_STATE, AD.location_zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
const HOME_REMOTE = AD.why_remote_us_when_form_says_hybrid || (HOME_CITY ? `${HOME_CITY}, ${HOME_STATE} (Remote-US)` : 'Remote-US');

const PLAYBOOK_YN = [
  // Each entry: regex over question label → 'Yes' | 'No'
  [/authorized to work|legally authorized|legally entitled/i, 'Yes'],
  [/require .*sponsorship|require .*visa|require employment visa|commence.*sponsor.*immigration|sponsor.*immigration case/i, 'No'],
  [/H[-]?1.?B (transfer|visa)|require .*H[-]?1.?B/i, 'No'],
  [/non.?compete|restrictive agreement/i, 'No'],
  [/willing to relocate/i, 'No'],
  [/are you a us citizen|U\.S\. citizen/i, 'No'],
  [/protected veteran|veteran status/i, 'No'],
  [/have a disability|disabled|disability status/i, 'No'],
  [/have you (ever )?been employed by|previously (employed|worked) for|worked at .+ before/i, 'No'],
  [/(in-person|onsite) interview|attend.*interview/i, 'Yes'],
  [/background checks?/i, 'Yes'],
  [/4\+? years of experience|four \+? years/i, 'Yes'],
  [/agile/i, 'Yes'],
  [/bachelor.+(stem|computer science|engineering)/i, 'Yes'],
];

const PLAYBOOK_TEXT = [
  [/^Location \(City\)/i, HOME_CITY],
  [/city, state.*zip|current city|city and state/i, HOME_FULL],
  [/which state.+reside|currently reside|state of residence/i, HOME_STATE],
  [/years of (relevant )?experience|years.*professional/i, String(AD.total_yoe || '')],
  [/salary expectation|expected (base )?salary|compensation expectation|desired salary|target salary/i, String(AD.base_salary_expectation_anchor || '')],
  [/notice period/i, AD.notice_period || '2 weeks'],
  [/how did you hear|how'?d you hear|where did you hear/i, AD.how_did_you_hear || 'LinkedIn'],
  [/current or most recent company|current company|recent company/i, AD.current_company || ''],
  [/primary backend language/i, AD.primary_backend_language || 'Python'],
  [/where do you intend to work|from where.*work|specify city.*state/i, HOME_REMOTE],
];

function lookupYN(question) {
  for (const [re, val] of PLAYBOOK_YN) if (re.test(question)) return val;
  return null;
}
function lookupText(question) {
  for (const [re, val] of PLAYBOOK_TEXT) if (re.test(question)) return val;
  return null;
}
function lookupEssay(question, essayMap) {
  for (const [substr, ans] of Object.entries(essayMap)) {
    if (substr.startsWith('_')) continue;
    if (question.toLowerCase().includes(substr.toLowerCase())) return ans;
  }
  return null;
}

async function fillCombo(page, labelText, optionRegex) {
  const lbl = page.locator('label[for]').filter({ hasText: labelText.slice(0, 60) }).first();
  if (!(await lbl.count())) return { ok: false, reason: 'label-not-found' };
  const cb = lbl.locator('xpath=following::*[@role="combobox"][1]').first();
  if (!(await cb.count())) return { ok: false, reason: 'combo-not-found' };
  await cb.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
  await cb.click();
  await page.waitForTimeout(350);
  const opt = page.getByRole('option', { name: optionRegex }).first();
  if (!(await opt.count())) {
    await page.keyboard.press('Escape').catch(() => {});
    return { ok: false, reason: 'option-not-found' };
  }
  await opt.click({ force: true });
  await page.waitForTimeout(200);
  // Verify the single-value text reflects the choice
  const verified = await cb.evaluate(e => {
    let cur = e.parentElement;
    for (let i = 0; i < 8; i++) {
      if (!cur) break;
      const sv = cur.querySelector('[class*="single-value"], [class*="singleValue"]');
      if (sv) return sv.textContent || '';
      cur = cur.parentElement;
    }
    return '';
  });
  return { ok: optionRegex.test(verified), reason: optionRegex.test(verified) ? '' : `verify-failed (got "${verified}")` };
}

async function fillTextOrEssay(page, labelText, value) {
  const lbl = page.locator('label[for]').filter({ hasText: labelText.slice(0, 60) }).first();
  if (!(await lbl.count())) return { ok: false, reason: 'label-not-found' };
  // Inspect the target: combobox? text? textarea?
  const forId = await lbl.getAttribute('for');
  let target;
  if (forId) target = page.locator(`[id="${forId}"]`).first();
  if (!target || !(await target.count())) {
    target = lbl.locator('xpath=following::*[@role="combobox" or self::input or self::textarea][1]').first();
  }
  if (!(await target.count())) return { ok: false, reason: 'control-not-found' };
  const role = await target.getAttribute('role').catch(() => null);

  // If it's a combobox, treat the value as the option text to select.
  if (role === 'combobox') {
    return fillCombo(page, labelText, new RegExp(`^${String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i'));
  }

  // Otherwise it's a text/textarea: fill it
  try { await target.fill(String(value), { timeout: 8000 }); }
  catch {
    await target.evaluate((el, v) => {
      const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
    }, String(value));
  }
  await target.evaluate((el) => {
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.focus(); el.blur();
  });
  return { ok: true };
}

// Find all question-wrapper labels (those associated with a form control).
async function listFormLabels(page) {
  return page.locator('label').evaluateAll(els =>
    els.map(el => {
      const forId = el.getAttribute('for');
      let target = null;
      if (forId) target = document.getElementById(forId);
      return {
        text: el.textContent?.replace(/\s+/g, ' ').trim() || '',
        forId,
        targetTag: target?.tagName?.toLowerCase() || null,
        targetType: target?.type || null,
      };
    }).filter(l => l.text.length >= 6)
  );
}

async function trySubmit(page) {
  const sub = page.getByRole('button', { name: /^Submit Application|^Submit$/i }).first();
  if (!(await sub.count())) return { submitted: false };
  await sub.scrollIntoViewIfNeeded();
  await sub.click();
  await page.waitForTimeout(2500);
  const still = await page.getByRole('button', { name: /^Submit Application|^Submit$/i }).count();
  if (still) await sub.click().catch(() => {});
  await Promise.race([
    page.waitForURL(/confirmation|thank-?you|thanks/i, { timeout: 10000 }).catch(() => {}),
    page.locator('text=/(thank you|application (was )?(received|submitted)|received your application)/i').first().waitFor({ timeout: 10000 }).catch(() => {}),
    page.waitForTimeout(8000),
  ]);
  // Greenhouse signals success either by URL change OR by explicit text panel
  const submitGone = (await page.getByRole('button', { name: /^Submit Application|^Submit$/i }).count()) === 0;
  const successText = (await page.locator('text=/(thank you|application (was )?(received|submitted)|received your application)/i').count()) > 0;
  const url = page.url();
  const urlSignals = /confirmation|thank-?you|\/thanks/i.test(url);
  return { submitted: (submitGone && (successText || urlSignals)) || urlSignals };
}

// Walk required question labels, fill any that are still empty using
// essayMap → playbook YN → playbook text fallback.
async function prefillRequired(page, essayMap) {
  const labels = await listFormLabels(page);
  // Filter to labels that look required (text contains *).
  const required = labels.filter(l => /\*/.test(l.text) || /required/i.test(l.text));
  console.log(`  prefill: ${required.length} required labels found`);
  let filled = 0;
  for (const lbl of required) {
    const cleanText = lbl.text.replace(/\*/g, '').trim();

    // Skip standard fields that fillGreenhouseStandardFields already handled
    if (/^(First Name|Last Name|Email|Phone|Country|Resume|LinkedIn Profile|Web\/Blog\/Portfolio Link)/i.test(cleanText)) continue;

    // Essay first
    const essay = lookupEssay(cleanText, essayMap);
    if (essay) {
      const out = await fillTextOrEssay(page, cleanText, essay);
      if (out.ok) { console.log(`    ✓ essay "${cleanText.slice(0, 60)}"`); filled++; continue; }
      console.log(`    ✗ essay fill "${cleanText.slice(0, 50)}" — ${out.reason}`);
    }

    // Combobox Yes/No
    const yn = lookupYN(cleanText);
    if (yn) {
      const out = await fillCombo(page, cleanText, new RegExp(`^${yn}$`, 'i'));
      if (out.ok) { console.log(`    ✓ yn "${cleanText.slice(0, 60)}" → ${yn}`); filled++; continue; }
    }

    // Plain text
    const txt = lookupText(cleanText);
    if (txt) {
      const out = await fillTextOrEssay(page, cleanText, txt);
      if (out.ok) { console.log(`    ✓ text "${cleanText.slice(0, 60)}" → ${txt}`); filled++; continue; }
    }

    console.log(`    ⚠ unmatched required: "${cleanText.slice(0, 80)}"`);
  }
  return filled;
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
    console.error('Usage: node apply-greenhouse-essays.mjs <url> --resume <pdf> --company "<Co>" --role "<Role>" [--essays <json>]');
    process.exit(2);
  }
  const resumePath = resolve(args.resume);
  if (!existsSync(resumePath)) throw new Error(`resume not found: ${resumePath}`);
  let essayMap = {};
  if (args.essaysFile) essayMap = JSON.parse(readFileSync(args.essaysFile, 'utf8'));

  try {
    assertNotAlreadyApplied({ url: args.url, company: args.company, role: args.role });
  } catch (e) {
    if (e.code === 'E_ALREADY_APPLIED') { console.error('❌ DUP-GUARD:', e.message); process.exit(2); }
    throw e;
  }

  const browser = await connectToBrave('http://localhost:9222');
  const ctx = browser.contexts()[0];

  // Close stale tabs
  const slug = args.company.toLowerCase().replace(/[^a-z]/g, '').slice(0, 8);
  for (const p of ctx.pages()) {
    if (p.url().toLowerCase().includes(slug) || p.url().includes('greenhouse')) {
      try { await p.close(); } catch {}
    }
  }

  const page = await ctx.newPage();
  await page.goto(args.url, { waitUntil: 'domcontentloaded' });
  console.log(`[gh-essays] navigated to ${args.url}`);
  await page.waitForTimeout(1500);

  await fillGreenhouseStandardFields(page, { resumePath });
  console.log(`[gh-essays] standard fields filled with ${basename(resumePath)}`);

  // Pre-fill the rest from essayMap + playbooks
  console.log('[gh-essays] pre-fill required:');
  await prefillRequired(page, essayMap);

  if (args.dryFill) { console.log('--no-submit, exiting'); await browser.close(); return; }

  for (let attempt = 1; attempt <= 4; attempt++) {
    console.log(`\n[gh-essays] submit attempt ${attempt}`);
    const r = await trySubmit(page);
    if (r.submitted) {
      console.log(`✅ SUBMITTED ${args.company} — ${args.role}`);
      console.log(`   URL: ${page.url()}`);
      await browser.close();
      return;
    }
    console.log('  not submitted; pre-filling again from current label state');
    const filled = await prefillRequired(page, essayMap);
    if (filled === 0) {
      console.log('  no progress — checking inline errors near required fields');
      const errs = await page.locator('.error, [class*="error"]').allTextContents();
      console.log('  errors:', errs.filter(e=>e.trim()).slice(0,8).map(e=>e.slice(0,200)));
      await browser.close();
      process.exit(1);
    }
  }
  console.log('❌ exhausted attempts');
  await browser.close();
  process.exit(1);
}

main().catch(e => { console.error('fatal:', e.message); process.exit(1); });
