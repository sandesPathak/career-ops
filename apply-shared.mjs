// apply-shared.mjs — shared helpers for ATS-typed apply handlers.
//
// Exports:
//   loadProfile()        — parses config/profile.yml#application_defaults
//   loadScreeningBank()  — parses screening-questions.json
//   matchScreening(q)    — fuzzy-match a form question to a known honest answer
//   pickStdAnswer(q, p)  — generic Yes/No/text dispatcher for common Q's
//
// Goal: every ATS handler reads the same canonical profile and screening bank
// so we never re-type the candidate's name, phone, eligibility, or salary again.

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Tiny YAML parser — only handles the leaf scalars in profile.yml#application_defaults.
// Avoids adding a yaml dep; existing scripts in the repo all hand-parse too.
function parseSimpleYaml(text) {
  const out = {};
  const stack = [{ indent: -1, obj: out }];
  for (const raw of text.split('\n')) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const indent = raw.match(/^ */)[0].length;
    const line = raw.trim();
    const m = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!m) continue;
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const parent = stack[stack.length - 1].obj;
    let [, key, val] = m;
    val = val.trim();
    if (!val) {
      const child = {};
      parent[key] = child;
      stack.push({ indent, obj: child });
    } else {
      // strip quotes
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      // numeric coercion for salary / YoE fields
      if (/^-?\d+(\.\d+)?$/.test(val)) val = Number(val);
      parent[key] = val;
    }
  }
  return out;
}

export function loadProfile() {
  const path = resolve(__dirname, 'config/profile.yml');
  const yaml = parseSimpleYaml(readFileSync(path, 'utf-8'));
  const defs = yaml.application_defaults;
  if (!defs) throw new Error('profile.yml is missing application_defaults block');
  return defs;
}

// Full profile (candidate, location_policy, work_authorization, application_defaults, etc.)
// Use this when you need fields outside application_defaults (city/state/zip for forms).
export function loadFullProfile() {
  const path = resolve(__dirname, 'config/profile.yml');
  return parseSimpleYaml(readFileSync(path, 'utf-8'));
}

// Convenience: "City, ST ZIP" formatted for forms that ask for city+state+zip in one field.
export function formatHomeAddress(profile = loadFullProfile()) {
  const lp = profile.location_policy || {};
  const city = lp.primary_city || profile.candidate?.location || '';
  const state = lp.primary_state || '';
  const zip = lp.primary_zip || '';
  return [city, [state, zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
}

export function loadScreeningBank() {
  const path = resolve(__dirname, 'screening-questions.json');
  return JSON.parse(readFileSync(path, 'utf-8'));
}

// Normalize a form question to a fuzzy-match key.
function norm(q) {
  return q
    .toLowerCase()
    .replace(/[*?.,;:!()'"]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Match a free-form form question against the screening bank.
// Returns { honest_answer, action, confidence } or null.
//
// action values:
//   'fill'         — fill verbatim, proceed to submit
//   'fill_and_flag' — fill but flag to user (honest answer may auto-reject)
//   'discard'      — DO NOT submit; the honest answer is a hard disqualifier
// A pattern is regex-like if it contains regex metachars typical for our bank.
function isRegexPattern(p) {
  return /[.*+?^$(){}|\\\[\]]/.test(p);
}

export function matchScreening(question, bank = loadScreeningBank()) {
  const nq = norm(question);
  if (!nq || nq.length < 8) return null; // empty/too-short text never matches
  let best = null;
  for (const entry of bank.questions) {
    for (const pattern of entry.patterns) {
      let hit = false;
      let conf = 0;
      if (isRegexPattern(pattern)) {
        try {
          const re = new RegExp(pattern, 'i');
          if (re.test(nq) || re.test(question.toLowerCase())) {
            hit = true;
            // confidence ≈ how much of the question the pattern covers
            const m = nq.match(re);
            conf = m ? m[0].length / nq.length : 0.6;
          }
        } catch { /* invalid regex — fall through to literal */ }
      }
      if (!hit) {
        const np = norm(pattern);
        if (nq.includes(np) || np.includes(nq)) {
          hit = true;
          conf = Math.min(np.length, nq.length) / Math.max(np.length, nq.length);
        }
      }
      if (hit && (!best || conf > best.confidence)) {
        best = {
          honest_answer: entry.honest_answer,
          action: entry.action || 'fill',
          confidence: conf,
          matched_pattern: pattern,
          note: entry.note || '',
        };
      }
    }
  }
  return best;
}

// Convenience: fast Yes/No dispatcher for the universal eligibility quartet.
// Returns 'Yes' / 'No' / null when the question doesn't fit a known pattern.
export function pickStdYesNo(question, profile = loadProfile()) {
  const nq = norm(question);
  if (/authorized to work/.test(nq)) return profile.authorized_to_work_us;
  if (/sponsorship.*h1.?b|h1.?b.*sponsorship/.test(nq)) return profile.requires_h1b_sponsorship;
  if (/require.*sponsorship|sponsorship.*employment/.test(nq)) return profile.requires_sponsorship;
  if (/non.?compete|restrictive agreement/.test(nq)) return profile.has_non_compete;
  if (/worked (for|at).+(before|previously)/.test(nq)) return profile.worked_for_company_before_default;
  if (/bachelor.*(stem|computer science|cs|engineering)/.test(nq)) return profile.has_bachelors_stem;
  if (/agile/.test(nq)) return 'Yes';
  if (/(at least|minimum) 3 years.*python/.test(nq)) return 'Yes';
  return null;
}

// Convenience: standard text-field dispatcher (returns null if no match).
export function pickStdText(question, profile = loadProfile()) {
  const nq = norm(question);
  if (/first name/.test(nq)) return profile.first_name;
  if (/last name|surname|family name/.test(nq)) return profile.last_name;
  if (/preferred (first )?name/.test(nq)) return profile.preferred_first_name;
  if (/^email/.test(nq) || /email address/.test(nq)) return profile.email;
  if (/phone/.test(nq)) return profile.phone_us_no_country;
  if (/linkedin/.test(nq)) return profile.linkedin_url;
  if (/github/.test(nq)) return profile.github_url;
  if (/^website|other website|portfolio|other url/.test(nq)) return profile.github_url;
  if (/salary|compensation expectation|expected (base|salary)/.test(nq))
    return String(profile.base_salary_expectation_anchor);
  if (/specify city.*state|city and state/.test(nq)) return profile.location_full;
  if (/intend to work|where.*work from|work location/.test(nq))
    return `${profile.location_full} (Remote-US)`;
  if (/how did you hear/.test(nq)) return profile.how_did_you_hear;
  if (/countries.*right to work|countries.*authorized/.test(nq)) return 'United States';
  return null;
}

// Tiny structured logger so every ATS handler logs the same shape.
export function logStep(stage, msg, extra = {}) {
  const tags = Object.entries(extra).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ');
  process.stderr.write(`[apply ${stage}] ${msg}${tags ? ' ' + tags : ''}\n`);
}
