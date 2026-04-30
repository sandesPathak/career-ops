#!/usr/bin/env node
// apply-lever.mjs — typed Lever form filler.
//
// Lever pattern (verified Eliza/SuperAnnotate 2026-04-28):
//   • Plain HTML form, easier than Ashby/Greenhouse — most fields are <input> / <textarea>.
//   • Resume input: `input[name="resume"]` directly accepts files.
//   • Visa-sponsorship and "current location" are <select> dropdowns.
//   • Free-form essay textareas for company-specific Q's (programming languages,
//     data pipelines, "years managing technical projects").
//
// What's auto-filled here:
//   • name / email / phone / location-input / org / urls (LinkedIn/GitHub/Portfolio/Other)
//   • Visa-sponsorship select
//
// What's NOT auto-filled (per-role):
//   • Essay textareas
//   • Custom screening questions (run matchScreening on each label)

import { loadProfile, matchScreening, logStep } from './apply-shared.mjs';

const STAGE = 'lever';

async function fillByName(page, fieldName, value, opts = {}) {
  if (value == null) return false;
  const sel = page.locator(`[name="${fieldName}"]`);
  if (!(await sel.count())) {
    if (opts.optional) return false;
    throw new Error(`field not found: ${fieldName}`);
  }
  await sel.first().fill(String(value));
  return true;
}

async function attachResume(page, resumePath) {
  const input = page.locator('input[type="file"][name="resume"]');
  if (!(await input.count())) throw new Error('resume input not found');
  await input.first().setInputFiles(resumePath);
  await page.waitForTimeout(300);
}

export async function fillLeverStandardFields(page, { resumePath, profile = loadProfile(), overrides = {} } = {}) {
  const filled = [];
  const p = { ...profile, ...overrides };

  await fillByName(page, 'name', `${p.first_name} ${p.last_name}`, { optional: true }).then(ok => ok && filled.push('name'));
  await fillByName(page, 'email', p.email, { optional: true }).then(ok => ok && filled.push('email'));
  await fillByName(page, 'phone', p.phone_pretty, { optional: true }).then(ok => ok && filled.push('phone'));
  await fillByName(page, 'location-input', p.location_full, { optional: true }).then(ok => ok && filled.push('location'));
  await fillByName(page, 'org', '', { optional: true }); // optional current-company

  await fillByName(page, 'urls[LinkedIn]', p.linkedin_url, { optional: true }).then(ok => ok && filled.push('linkedin'));
  await fillByName(page, 'urls[GitHub]', p.github_url, { optional: true }).then(ok => ok && filled.push('github'));
  await fillByName(page, 'urls[Portfolio]', p.portfolio_url, { optional: true });

  await attachResume(page, resumePath).then(() => filled.push('resume'));

  // Visa-sponsorship select — Lever uses native <select>; profile says No.
  try {
    const sel = page.locator('select').filter({ hasText: /visa|sponsorship/i });
    if (await sel.count()) {
      await sel.first().selectOption({ label: p.requires_sponsorship });
      filled.push('visa_select');
    }
  } catch (e) { logStep(STAGE, `visa select: ${e.message}`); }

  return { filled };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes('--selftest')) {
    const p = loadProfile();
    console.log('Lever profile ready:', { first: p.first_name, location: p.location_full, visa: p.requires_sponsorship });
  }
}
