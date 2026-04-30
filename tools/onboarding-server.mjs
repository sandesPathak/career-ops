#!/usr/bin/env node
// onboarding-server.mjs — one-shot local HTTP server that collects new-user
// profile data via a single-page HTML form, writes config/profile.yml + cv.md,
// copies the *.example.* templates to their real names, then exits.
//
// Triggered by the /start-career slash command.
//
// Listens on http://localhost:7331. Auto-opens the browser. Exits after one POST.
// Zero npm dependencies beyond js-yaml (already in package.json).

import { createServer } from 'node:http';
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { exec } from 'node:child_process';
import yaml from 'js-yaml';

const PORT = 7331;
const ROOT = process.cwd();

const FORM_HTML = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>career-ops · setup</title>
<style>
  body { font: 15px/1.5 -apple-system, system-ui, sans-serif; max-width: 580px; margin: 40px auto; padding: 0 20px; color: #1a1a1a; }
  h1 { font-size: 24px; margin-bottom: 4px; }
  p.lede { color: #666; margin-top: 0; margin-bottom: 28px; }
  label { display: block; font-weight: 600; margin-top: 18px; margin-bottom: 4px; font-size: 14px; }
  small { color: #888; font-weight: 400; display: block; margin-top: 2px; line-height: 1.3; }
  input, select, textarea { width: 100%; padding: 9px 11px; border: 1px solid #ccc; border-radius: 6px; font-size: 14px; box-sizing: border-box; font-family: inherit; }
  input:focus, select:focus, textarea:focus { outline: 0; border-color: #111; }
  textarea { min-height: 220px; resize: vertical; font-family: ui-monospace, Menlo, monospace; font-size: 12.5px; line-height: 1.5; }
  .row { display: flex; gap: 12px; }
  .row > div { flex: 1; }
  button { margin-top: 28px; padding: 11px 22px; font-size: 15px; font-weight: 600; background: #111; color: #fff; border: 0; border-radius: 6px; cursor: pointer; }
  button:hover { background: #333; }
  .ok { background: #f0fdf4; border: 1px solid #16a34a; color: #166534; padding: 18px; border-radius: 6px; margin-top: 30px; }
  .ok h2 { margin: 0 0 8px; font-size: 18px; }
  .ok ul { margin: 8px 0; padding-left: 20px; }
  .ok code { background: #dcfce7; padding: 1px 5px; border-radius: 3px; font-size: 13px; }
</style>
</head><body>
<h1>career-ops · setup</h1>
<p class="lede">~2 minutes. All data stays on your machine — gitignored, never pushed.</p>

<form method="POST" action="/submit">
  <label>Full name <small>e.g., "Jane Smith"</small>
    <input name="name" required autocomplete="name">
  </label>

  <label>Email <small>used in cover letters</small>
    <input type="email" name="email" required autocomplete="email">
  </label>

  <div class="row">
    <div><label>City <input name="city" required></label></div>
    <div><label>State / region <input name="state" required></label></div>
  </div>

  <label>Work authorization
    <select name="work_auth" required>
      <option value="US Citizen">US Citizen</option>
      <option value="Green Card">Green Card (LPR)</option>
      <option value="GC-EAD">GC-EAD (pending green card)</option>
      <option value="H1B">H1B</option>
      <option value="F1-OPT">F1 OPT / STEM-OPT</option>
      <option value="TN">TN visa</option>
      <option value="L2-EAD">L2-EAD</option>
      <option value="Other">Other</option>
    </select>
    <small>Drives auto-discard on citizenship-required postings.</small>
  </label>

  <label>Primary target role <small>add more later in modes/_profile.md</small>
    <input name="target_role" required placeholder="Senior AI Engineer">
  </label>

  <label>Salary anchor (USD base) <small>optional — used in form fields asking salary expectation</small>
    <input type="number" name="salary_anchor" placeholder="175000" min="0" step="1000">
  </label>

  <label>Paste your resume <small>markdown or plain text — saved as cv.md, the canonical source for all tailoring</small>
    <textarea name="cv" required placeholder="# Jane Smith&#10;## Summary&#10;..."></textarea>
  </label>

  <button type="submit">Save and start</button>
</form>
</body></html>`;

const SUCCESS_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>career-ops · ready</title>
<style>body { font: 15px/1.5 -apple-system, system-ui, sans-serif; max-width: 580px; margin: 60px auto; padding: 0 20px; color: #1a1a1a; }
h1 { font-size: 24px; } code { background: #f3f4f6; padding: 1px 6px; border-radius: 3px; font-size: 13px; }
ul { padding-left: 20px; } .ok { background: #f0fdf4; border: 1px solid #16a34a; color: #166534; padding: 20px; border-radius: 6px; }</style>
</head><body>
<h1>✅ You're set</h1>
<div class="ok">
<p>Files written to <code>{ROOT}</code>:</p>
<ul>
<li><code>config/profile.yml</code> — your personal data</li>
<li><code>cv.md</code> — your resume</li>
<li><code>modes/_profile.md</code>, <code>portals.yml</code>, <code>screening-questions.json</code>, <code>cv-do-not-claim.txt</code> — copied from templates</li>
<li><code>.env</code> — copied from .env.example (add API keys later if needed)</li>
</ul>
<p>You can close this tab and return to Claude Code. Try pasting a job URL, or run <code>/career-ops scan</code>.</p>
</div>
</body></html>`;

function parseFormBody(body) {
  const out = {};
  for (const pair of body.split('&')) {
    const [k, v] = pair.split('=');
    out[decodeURIComponent(k)] = decodeURIComponent((v || '').replace(/\+/g, ' '));
  }
  return out;
}

function workAuthDefaults(status) {
  // Returns { authorized_to_work_us, requires_sponsorship, requires_h1b_sponsorship, visa_status_text }
  const s = String(status || '').toLowerCase();
  if (s === 'us citizen' || s === 'green card' || s === 'gc-ead' || s === 'l2-ead') {
    return { authorized_to_work_us: 'Yes', requires_sponsorship: 'No', requires_h1b_sponsorship: 'No', visa_status_text: status };
  }
  if (s === 'h1b' || s === 'f1-opt' || s === 'tn') {
    return { authorized_to_work_us: 'Yes', requires_sponsorship: 'Yes', requires_h1b_sponsorship: s === 'h1b' ? 'Yes' : 'No', visa_status_text: status };
  }
  return { authorized_to_work_us: 'Yes', requires_sponsorship: 'Yes', requires_h1b_sponsorship: 'No', visa_status_text: status };
}

function buildProfile(form) {
  const examplePath = `${ROOT}/config/profile.example.yml`;
  if (!existsSync(examplePath)) throw new Error(`Missing ${examplePath} — run from repo root`);
  const profile = yaml.load(readFileSync(examplePath, 'utf-8'));
  const wa = workAuthDefaults(form.work_auth);
  const [first, ...rest] = (form.name || '').trim().split(/\s+/);
  const last = rest.join(' ') || '';
  const salary = parseInt(form.salary_anchor, 10) || profile.application_defaults?.base_salary_expectation_anchor || 175000;

  profile.candidate.full_name = form.name;
  profile.candidate.email = form.email;
  profile.candidate.location = `${form.city}, ${form.state}`;

  profile.target_roles.primary = [form.target_role];

  profile.location.city = form.city;
  profile.location.state = form.state;
  profile.location.visa_status = wa.visa_status_text;

  // location_policy drives prefilter.mjs / filter-*.mjs / scan-discover.mjs. Replace example
  // SF defaults with substrings derived from the user's city (lowercased). State is not
  // included by default — it would over-match (e.g. "TX" appears in "TX, USA" but also "auTXk"
  // edge cases); user can edit profile.yml later to add nearby cities/regions.
  profile.location_policy = profile.location_policy || {};
  profile.location_policy.primary_city = form.city;
  profile.location_policy.primary_state = form.state;
  profile.location_policy.acceptable_local_substrings = [form.city.toLowerCase()];
  // Keep willing_to_relocate at its example default (false) unless user explicitly opts in later.

  profile.compensation.target_range = `$${Math.round(salary * 0.85 / 1000)}K-${Math.round(salary * 1.15 / 1000)}K`;
  profile.compensation.minimum = `$${Math.round(salary * 0.85 / 1000)}K`;

  profile.application_defaults = profile.application_defaults || {};
  Object.assign(profile.application_defaults, {
    first_name: first,
    last_name: last,
    preferred_first_name: first,
    email: form.email,
    location_city: form.city,
    location_state: form.state,
    location_full: `${form.city}, ${form.state}`,
    location_combo_search: form.city,
    location_combo_pick: `${form.city}, ${form.state}, United States`,
    visa_status: wa.visa_status_text,
    authorized_to_work_us: wa.authorized_to_work_us,
    requires_sponsorship: wa.requires_sponsorship,
    requires_h1b_sponsorship: wa.requires_h1b_sponsorship,
    base_salary_expectation_anchor: salary,
    base_salary_expectation_min: Math.round(salary * 0.85),
    base_salary_expectation_max: Math.round(salary * 1.15),
  });

  return profile;
}

function copyTemplate(src, dst) {
  if (existsSync(dst)) return false;
  if (!existsSync(src)) return false;
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(src, dst);
  return true;
}

function buildScreeningBank(form) {
  // Read the example template, fill its {placeholder} honest_answer fields with
  // concrete answers derived from the form. Falls back to the raw example if the
  // file is missing or malformed.
  const examplePath = `${ROOT}/screening-questions.example.json`;
  if (!existsSync(examplePath)) return null;
  const bank = JSON.parse(readFileSync(examplePath, 'utf-8'));
  const wa = workAuthDefaults(form.work_auth);
  const isCitizen = (form.work_auth || '').toLowerCase() === 'us citizen';
  const where = `${form.city}, ${form.state}`;
  const salary = parseInt(form.salary_anchor, 10) || 175000;
  const fills = {
    us_citizen_required: {
      honest_answer: isCitizen ? 'Yes' : `No — work authorization is "${form.work_auth}", not US citizenship.`,
      action: isCitizen ? 'fill' : 'discard',
    },
    active_security_clearance: { honest_answer: 'No clearance.', action: 'discard' },
    nyc_hybrid_required: {
      honest_answer: `No — based in ${where} with no relocation. Applying for the Remote-US option listed in the posting.`,
      action: 'fill_and_flag',
    },
    sf_bay_or_nyc_only: {
      honest_answer: `No — ${where}. Not a fit for SF/NYC-required posting.`,
      action: 'discard',
    },
    us_only_timezone: { honest_answer: `I am in the United States (${where}).`, action: 'discard' },
    h1b_sponsorship_required: { honest_answer: wa.requires_sponsorship, action: 'fill' },
    authorized_us: { honest_answer: wa.authorized_to_work_us, action: 'fill' },
    non_compete: { honest_answer: 'No', action: 'fill' },
    yoe_floor_exceeded: {
      honest_answer: 'Compare the JD floor to your total YoE in config/profile.yml § application_defaults.total_yoe; if it exceeds, action=discard.',
      action: 'discard',
    },
    salary_expectation: {
      honest_answer: `\$${salary.toLocaleString()} base; flexible based on total comp + equity.`,
      action: 'fill',
    },
    fed_govt_customer_acknowledgement: {
      honest_answer: isCitizen ? 'Yes' : `No — work authorization is "${form.work_auth}", not US citizenship; federal/DoD contract roles typically require citizenship.`,
      action: isCitizen ? 'fill' : 'discard',
    },
    worked_at_company_before: { honest_answer: 'No', action: 'fill' },
    bachelors_stem: { honest_answer: 'Yes', action: 'fill' },
  };
  for (const q of bank.questions || []) {
    const f = fills[q.id];
    if (f) {
      q.honest_answer = f.honest_answer;
      if (f.action) q.action = f.action;
    }
  }
  return bank;
}

function writeFiles(form) {
  const created = [];

  // 1. config/profile.yml
  const profile = buildProfile(form);
  mkdirSync(`${ROOT}/config`, { recursive: true });
  if (existsSync(`${ROOT}/config/profile.yml`)) {
    copyFileSync(`${ROOT}/config/profile.yml`, `${ROOT}/config/profile.yml.bak`);
    created.push('config/profile.yml.bak (existing backed up)');
  }
  writeFileSync(`${ROOT}/config/profile.yml`, yaml.dump(profile, { lineWidth: 120, noRefs: true }));
  created.push('config/profile.yml');

  // 2. cv.md
  if (existsSync(`${ROOT}/cv.md`)) {
    copyFileSync(`${ROOT}/cv.md`, `${ROOT}/cv.md.bak`);
    created.push('cv.md.bak (existing backed up)');
  }
  writeFileSync(`${ROOT}/cv.md`, form.cv);
  created.push('cv.md');

  // 3. screening-questions.json — fill placeholders from form data, don't just copy
  if (!existsSync(`${ROOT}/screening-questions.json`)) {
    const bank = buildScreeningBank(form);
    if (bank) {
      writeFileSync(`${ROOT}/screening-questions.json`, JSON.stringify(bank, null, 2));
      created.push('screening-questions.json');
    }
  }

  // 4. Other templates — straight copy if not present
  const copies = [
    ['modes/_profile.template.md', 'modes/_profile.md'],
    ['templates/portals.example.yml', 'portals.yml'],
    ['cv-do-not-claim.example.txt', 'cv-do-not-claim.txt'],
    ['.env.example', '.env'],
  ];
  for (const [src, dst] of copies) {
    if (copyTemplate(`${ROOT}/${src}`, `${ROOT}/${dst}`)) created.push(dst);
  }

  return created;
}

const server = createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(FORM_HTML);
    return;
  }
  if (req.method === 'POST' && req.url === '/submit') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try {
        const form = parseFormBody(body);
        const created = writeFiles(form);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(SUCCESS_HTML.replace('{ROOT}', ROOT));
        console.log(`✅ wrote ${created.length} files:`);
        for (const f of created) console.log(`   - ${f}`);
        setTimeout(() => { server.close(); process.exit(0); }, 250);
      } catch (e) {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end(`Error: ${e.message}\n\nFix it and refresh the form.`);
        console.error(`❌ ${e.message}`);
      }
    });
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
});

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://localhost:${PORT}/`;
  console.log(`Onboarding form: ${url}`);
  console.log(`Waiting for submission... (Ctrl-C to abort)`);
  // Auto-open browser. macOS: `open`, Linux: `xdg-open`, Windows: `start`.
  const cmd = process.platform === 'darwin' ? `open "${url}"`
    : process.platform === 'win32' ? `start "" "${url}"`
    : `xdg-open "${url}"`;
  exec(cmd, () => {});
});

// Safety: exit after 30 minutes idle
setTimeout(() => { console.log('Timeout — closing server.'); process.exit(1); }, 30 * 60 * 1000).unref();
