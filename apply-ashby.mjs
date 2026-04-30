#!/usr/bin/env node
// apply-ashby.mjs — typed Ashby form filler.
//
// Usage (programmatic):
//   import { fillAshbyStandardFields } from './apply-ashby.mjs';
//   await fillAshbyStandardFields(page, { resumePath, profile });
//
// Ashby pattern notes (verified ElevenLabs 2026-04-28, Eliza 2026-04-28):
//   • Anti-bot heuristic flags fast typing — use slow type (delay 30-60ms).
//   • Yes/No are BUTTONS not comboboxes; click the label TEXT (not the input).
//   • Resume upload via "Upload File" button, file chooser pattern.
//   • Location is a single combobox — type city, click first option.
//
// Some Ashby tenants reject slow-typed Playwright submits with a "possible spam"
// message — flag for hand-off when that text appears.

import { loadProfile, matchScreening, logStep } from './apply-shared.mjs';

const STAGE = 'ashby';
const SLOW = { delay: 40 };

async function slowFill(page, name, value, opts = {}) {
  if (value == null) return false;
  const tb = page.getByRole('textbox', { name });
  if (!(await tb.count())) {
    if (opts.optional) return false;
    throw new Error(`textbox not found: ${name}`);
  }
  await tb.first().click();
  await tb.first().pressSequentially(String(value), SLOW);
  return true;
}

async function clickLabelText(page, labelText) {
  // Ashby radios: click the visible label, not the hidden input.
  const target = page.getByText(labelText, { exact: true });
  if (!(await target.count())) throw new Error(`label not found: ${labelText}`);
  await target.first().click();
}

async function attachResume(page, resumePath) {
  // Prefer direct input[type=file].setInputFiles — works even when the visible
  // "Upload File" button is decorative or wired to multi-file dropzones.
  const fileInputs = page.locator('input[type="file"]');
  const count = await fileInputs.count();
  if (count > 0) {
    // First file input is conventionally the resume on Ashby.
    await fileInputs.first().setInputFiles(resumePath);
    await page.waitForTimeout(500);
    return;
  }
  // Fallback: click the upload button and catch the file chooser event.
  const fcPromise = page.waitForEvent('filechooser', { timeout: 10000 });
  const btn = page.getByRole('button', { name: /upload file|choose file/i });
  await btn.first().click();
  const fc = await fcPromise;
  await fc.setFiles(resumePath);
  await page.waitForTimeout(300);
}

export async function fillAshbyStandardFields(page, { resumePath, profile = loadProfile(), overrides = {} } = {}) {
  const filled = [];
  const p = { ...profile, ...overrides };

  // Wait for Ashby React form to hydrate (Name textbox is the first standard field).
  // Some Ashby pages put the form below a long JD, so scroll the form into view first.
  try {
    const formAnchor = page.locator('#form, [data-testid="application-form"]').first();
    if (await formAnchor.count()) await formAnchor.scrollIntoViewIfNeeded();
  } catch {}
  await page.getByRole('textbox', { name: /^(Name|Full Name|Full Legal Name|Legal First Name|First Name|Preferred First Name)/i }).first().waitFor({ state: 'visible', timeout: 30000 });

  // Try a single combined Name field first; fall back to First/Last split.
  const filledName = await slowFill(page, /^(Name|Full Name|Full Legal Name)/i, `${p.first_name} ${p.last_name}`, { optional: true });
  if (filledName) filled.push('name');
  else {
    await slowFill(page, /Legal First Name|^First Name|Preferred First Name/i, p.first_name, { optional: true }).then(ok => ok && filled.push('first_name'));
    await slowFill(page, /Legal Last Name|^Last Name|Preferred Last Name/i, p.last_name, { optional: true }).then(ok => ok && filled.push('last_name'));
  }
  await slowFill(page, /^E-?mail/i, p.email, { optional: true }).then(ok => ok && filled.push('email'));
  await slowFill(page, /Phone( Number)?/i, p.phone_pretty, { optional: true }).then(ok => ok && filled.push('phone'));
  await attachResume(page, resumePath).then(() => filled.push('resume'));

  // Location combobox (Ashby uses placeholder "Start typing...")
  try {
    const locCombo = page.getByRole('combobox', { name: /location/i });
    if (await locCombo.count()) {
      await locCombo.first().click();
      await locCombo.first().pressSequentially(p.location_combo_search, SLOW);
      await page.waitForTimeout(300);
      const opt = page.getByRole('option').first();
      if (await opt.count()) { await opt.click(); filled.push('location'); }
    }
  } catch (e) { logStep(STAGE, `location: ${e.message}`); }

  await slowFill(page, /LinkedIn/i, p.linkedin_url, { optional: true }).then(ok => ok && filled.push('linkedin'));
  await slowFill(page, /Github|GitHub/i, p.github_url, { optional: true }).then(ok => ok && filled.push('github'));
  await slowFill(page, /Portfolio/i, p.portfolio_url, { optional: true });

  // Authorized + Sponsorship are usually Yes/No button rows
  for (const [matcher, value] of [
    [/authorized to work/i, p.authorized_to_work_us],
    [/require sponsorship/i, p.requires_sponsorship],
  ]) {
    try {
      const section = page.locator(`text=${matcher.source}`).first();
      if (await section.count()) {
        // Click the button "Yes" or "No" inside that section
        const btn = page.getByRole('button', { name: new RegExp(`^${value}$`, 'i') }).first();
        if (await btn.count()) { await btn.click(); filled.push(`btn:${value}`); }
      }
    } catch (e) { logStep(STAGE, `btn step: ${e.message}`); }
  }

  return { filled };
}

// CLI smoke
if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes('--selftest')) {
    const p = loadProfile();
    console.log('Ashby profile ready:', { first: p.first_name, email: p.email, phone: p.phone_pretty });
  }
}
