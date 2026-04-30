#!/usr/bin/env node
// apply-greenhouse.mjs — typed Greenhouse form filler.
//
// Usage (programmatic, called from Playwright session that already has a page):
//   import { fillGreenhouseStandardFields, screenGreenhouseQuestions } from './apply-greenhouse.mjs';
//   await fillGreenhouseStandardFields(page, { resumePath, profile });
//   const screen = await screenGreenhouseQuestions(page);
//   if (screen.discard) { ...abort... }
//
// What's typed here (once, reused across every Greenhouse form the candidate sees):
//   Pattern verified working across multiple Greenhouse tenants.
//   • First/Last/Email/Phone/Country combobox/Location (City) combobox/Resume upload
//   • LinkedIn/GitHub/Other URL
//   • The eligibility quartet: Authorized / Sponsorship / H1-B transfer / Non-compete
//   • Worked-at-company-before
//   • Bachelor's STEM
//   • Salary expectation
//   • "From where do you intend to work?" / "Specify city + state"
//
// What's NOT done here (require per-role attention):
//   • Why-X essays (use cv-tailor pipeline + essay library)
//   • Custom screening questions (apply-shared.mjs#matchScreening checks the bank,
//     surfaces unknown ones for operator review)
//
// Pattern verified across multiple Greenhouse tenants on the 2026-04 schema.

import { loadProfile, matchScreening, pickStdYesNo, pickStdText, logStep } from './apply-shared.mjs';

const STAGE = 'greenhouse';

// Click a react-select combobox by aria-label, type-search optionally, click matching option.
//
// For binary Yes/No or short option lists, omit `searchText` — listbox shows all options on click.
// For database-backed dropdowns (Country, Location), pass `searchText` to filter.
async function fillCombobox(page, ariaLabelMatcher, optionMatcher, { searchText = null, optional = false } = {}) {
  const combo = page.getByRole('combobox', { name: ariaLabelMatcher });
  const exists = await combo.count();
  if (!exists) {
    if (optional) return false;
    throw new Error(`combobox not found: ${ariaLabelMatcher}`);
  }
  await combo.first().click();
  if (searchText) {
    await combo.first().pressSequentially(searchText, { delay: 30 });
  }
  // Wait briefly for listbox to populate
  await page.waitForTimeout(150);
  const opt = page.getByRole('option', { name: optionMatcher });
  const optCount = await opt.count();
  if (!optCount) {
    if (optional) return false;
    throw new Error(`option not found in combobox '${ariaLabelMatcher}': ${optionMatcher}`);
  }
  await opt.first().click();
  return true;
}

async function fillTextbox(page, nameMatcher, value, { optional = true } = {}) {
  if (value == null) return false;
  const tb = page.getByRole('textbox', { name: nameMatcher });
  const c = await tb.count();
  if (!c) {
    if (optional) return false;
    throw new Error(`textbox not found: ${nameMatcher}`);
  }
  await tb.first().fill(String(value));
  return true;
}

// Greenhouse resume attach — prefer direct setInputFiles, fall back to button-click.
async function attachResume(page, resumePath) {
  const fileInput = page.locator('input[type="file"]').first();
  if (await fileInput.count()) {
    await fileInput.setInputFiles(resumePath);
    await page.waitForTimeout(500);
    return;
  }
  const fcPromise = page.waitForEvent('filechooser', { timeout: 10000 });
  // Greenhouse exposes the Attach inside a Resume/CV* group.
  await page.locator('button').filter({ hasText: /^(Attach|Upload|Choose File|Attach Resume|Attach CV|Attach Resume\/CV)$/ }).first().click();
  const fc = await fcPromise;
  await fc.setFiles(resumePath);
  await page.waitForTimeout(300);
}

// Public API ─────────────────────────────────────────────────────────────────

/**
 * Fill all standard Greenhouse fields from the canonical profile.
 * Caller has already navigated `page` to the apply URL.
 *
 * @param {import('playwright').Page} page
 * @param {object} opts
 * @param {string} opts.resumePath  absolute path to tailored PDF
 * @param {object} [opts.profile]   override profile (default: loadProfile())
 * @param {object} [opts.overrides] per-app overrides (e.g., { salary: 170000 })
 * @returns {Promise<{filled: string[], skipped: string[]}>}
 */
export async function fillGreenhouseStandardFields(page, { resumePath, profile = loadProfile(), overrides = {} } = {}) {
  const filled = [];
  const skipped = [];
  const p = { ...profile, ...overrides };

  const steps = [
    () => fillTextbox(page, /^First Name$/i, p.first_name).then(ok => ok && filled.push('first_name')),
    () => fillTextbox(page, /^Last Name$/i, p.last_name).then(ok => ok && filled.push('last_name')),
    () => fillTextbox(page, /^Email$/i, p.email).then(ok => ok && filled.push('email')),
    () => fillTextbox(page, /^Phone$/i, p.phone_us_no_country).then(ok => ok && filled.push('phone')),
    () => fillCombobox(page, /^Country$/i, /United States/i, { searchText: 'United States', optional: true })
      .then(ok => ok ? filled.push('country') : skipped.push('country')),
    () => fillCombobox(page, /Location \(City\)/i, p.location_combo_pick, { searchText: p.location_combo_search, optional: true })
      .then(ok => ok ? filled.push('location_city') : skipped.push('location_city')),
    () => attachResume(page, resumePath).then(() => filled.push('resume')),
    () => fillTextbox(page, /LinkedIn/i, p.linkedin_url).then(ok => ok && filled.push('linkedin')),
    () => fillTextbox(page, /^Website$|^Other Website$|^GitHub$|Other URL/i, p.github_url).then(ok => ok && filled.push('github_or_website')),
    () => fillTextbox(page, /Where do you intend to work|From where.*work|specify city.*state/i, `${p.location_full} (Remote-US)`)
      .then(ok => ok && filled.push('intend_to_work')),
    () => fillTextbox(page, /salary expectation|expected base|compensation expectation/i, p.base_salary_expectation_anchor)
      .then(ok => ok && filled.push('salary')),
    () => fillTextbox(page, /how did you hear/i, p.how_did_you_hear).then(ok => ok && filled.push('how_did_you_hear')),
  ];

  for (const step of steps) {
    try { await step(); } catch (e) { logStep(STAGE, `step error: ${e.message}`); }
  }

  // Eligibility comboboxes — Yes/No + standard variants
  const yesno = [
    [/authorized to work/i, p.authorized_to_work_us],
    [/h1.?b.*sponsorship|require.*h1.?b/i, p.requires_h1b_sponsorship],
    [/require.*sponsorship|sponsorship.*employment/i, p.requires_sponsorship],
    [/non.?compete|restrictive agreement/i, p.has_non_compete],
    [/worked for.+before|worked at.+before|previously employed/i, p.worked_for_company_before_default],
    [/bachelor.+(stem|computer science|engineering)/i, p.has_bachelors_stem],
    [/agile/i, 'Yes'],
    [/(at least|minimum) 3 years.+python/i, 'Yes'],
  ];
  for (const [labelMatcher, value] of yesno) {
    try {
      const ok = await fillCombobox(page, labelMatcher, new RegExp(`^${value}$`, 'i'), { optional: true });
      if (ok) filled.push(`yesno:${value}`);
    } catch (e) { logStep(STAGE, `yesno step error: ${e.message}`); }
  }

  return { filled, skipped };
}

/**
 * Scan all visible required questions on the form, match them against the
 * screening bank, and return a verdict. Call this BEFORE submit.
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<{discard: boolean, flags: object[], unknowns: string[]}>}
 */
export async function screenGreenhouseQuestions(page) {
  // Pull every label + the asterisk-required marker from the application section
  const labels = await page.evaluate(() => {
    const out = [];
    const required = document.querySelectorAll('label, .field-label, [class*="label"]');
    for (const el of required) {
      const txt = (el.textContent || '').trim();
      if (txt.length < 5 || txt.length > 400) continue;
      if (!/[?*]/.test(txt) && !/\b(experience|years|do you|have you|are you)\b/i.test(txt)) continue;
      out.push(txt);
    }
    return out;
  });
  const flags = [];
  const unknowns = [];
  let discard = false;
  for (const q of labels) {
    const m = matchScreening(q);
    if (!m) {
      // Unknown question; only flag if it looks like a screening Q
      if (/\?|\bare you\b|\bdo you\b|\bhave you\b/i.test(q)) unknowns.push(q);
      continue;
    }
    if (m.action === 'discard') discard = true;
    flags.push({ question: q, ...m });
  }
  return { discard, flags, unknowns };
}

// Allow CLI smoke-test:  node apply-greenhouse.mjs --selftest
if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes('--selftest')) {
    const p = loadProfile();
    console.log('Profile loaded:', { first: p.first_name, email: p.email, city: p.location_full, salary: p.base_salary_expectation_anchor });
    const tests = [
      'Are you authorized to work in the United States?',
      'Will you now or in the future require a H1-B transfer / visa sponsorship for employment at <Company>?',
      'Do you have a minimum of 1 year experience building with the Elastic Stack?',
      'Are you located in San Francisco Bay Area or NYC?',
      'Do you have at least 3 years of Python coding experience shipping code into production?',
      'Have you ever worked for <Company> before, as an employee or a contractor/consultant?',
    ];
    for (const t of tests) {
      const m = matchScreening(t);
      console.log(`Q: ${t}\n  → ${m ? `[${m.action}] ${m.honest_answer}` : '(unknown)'}\n`);
    }
  }
}
