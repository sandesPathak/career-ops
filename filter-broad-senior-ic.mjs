#!/usr/bin/env node
import { readFileSync } from 'fs';
import yaml from 'js-yaml';

const portals = yaml.load(readFileSync('portals.yml', 'utf8'));
const pipeline = readFileSync('data/pipeline.md', 'utf8');
const applications = readFileSync('data/applications.md', 'utf8');

const pendingUrls = new Set();
for (const line of pipeline.split('\n')) {
  const m = line.match(/^- \[ \] (https?:\/\/\S+)/);
  if (m) pendingUrls.add(m[1]);
}

const engagedCompanies = new Set();
for (const line of applications.split('\n')) {
  const m = line.match(/\| \d+ \| \d{4}-\d{2}-\d{2} \| ([^|]+) \|/);
  if (m) engagedCompanies.add(m[1].trim().toLowerCase());
}

function detectApi(c) {
  if (c.api && c.api.includes('greenhouse')) return { type: 'greenhouse', url: c.api };
  const u = c.careers_url || '';
  let m = u.match(/jobs\.ashbyhq\.com\/([^/?#]+)/);
  if (m) return { type: 'ashby', url: `https://api.ashbyhq.com/posting-api/job-board/${m[1]}?includeCompensation=true` };
  m = u.match(/jobs\.lever\.co\/([^/?#]+)/);
  if (m) return { type: 'lever', url: `https://api.lever.co/v0/postings/${m[1]}` };
  m = u.match(/job-boards(?:\.eu)?\.greenhouse\.io\/([^/?#]+)/);
  if (m) return { type: 'greenhouse', url: `https://boards-api.greenhouse.io/v1/boards/${m[1]}/jobs` };
  return null;
}

function getLocation(j, type) {
  if (type === 'greenhouse') return j.location?.name || '';
  if (type === 'ashby') return j.location || (j.locations || []).map(l => l.locationName || l).join('; ');
  if (type === 'lever') return j.categories?.location || (j.categories?.allLocations || []).join('; ') || '';
  return '';
}
function getLocationType(j, type) {
  if (type === 'ashby') return j.workplaceType || j.locationType || '';
  return '';
}
function getUrl(j, type, slug) {
  if (type === 'greenhouse') return j.absolute_url;
  if (type === 'ashby') return j.jobUrl || j.applyUrl || `https://jobs.ashbyhq.com/${slug}/${j.id}`;
  if (type === 'lever') return j.hostedUrl || j.applyUrl;
  return '';
}

const EXCLUDE_LEVEL_RE = /\b(staff|principal|director|head of|vice president|vp|chief|founding|distinguished|fellow|manager|lead engineer)\b/i;
// BROADER role match: any IC engineering role (level filter handled separately)
const ROLE_RE = /\b(software engineer|backend engineer|full[- ]?stack engineer|frontend engineer|product engineer|platform engineer|infrastructure engineer|application engineer|api engineer|ai engineer|ml engineer|machine learning engineer|llm engineer|forward deployed engineer|deployed engineer|developer experience engineer|technical architect[ -].*ai)\b/i;
const HARD_EXCLUDE_RE = /\b(research scientist|hardware|silicon|firmware|sales engineer|account|recruiter|talent|gtm representative|customer success|legal|policy|finance|founding|game|3d|graphics|embedded|driver|kernel|compiler|gpu)\b/i;

// Build the local-friendly matcher from config/profile.yml § location_policy.acceptable_local_substrings,
// with a fallback to location.city/location.state when that section isn't set yet.
const _profile = yaml.load(readFileSync('config/profile.yml', 'utf8'));
const _lp = _profile.location_policy || {};
const LOCAL_SUBSTRINGS = ((_lp.acceptable_local_substrings && _lp.acceptable_local_substrings.length)
  ? _lp.acceptable_local_substrings
  : [_profile.location?.city, _profile.location?.state].filter(Boolean)
).map(s => String(s).toLowerCase());
const LOCAL_LABEL = LOCAL_SUBSTRINGS.length ? LOCAL_SUBSTRINGS[0].toUpperCase() : 'LOCAL';
const LOCAL_RE = LOCAL_SUBSTRINGS.length ? new RegExp(`\\b(${LOCAL_SUBSTRINGS.map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'i') : null;
const NON_LOCAL_CITIES = /\b(san francisco|sf bay|bay area|new york|nyc|brooklyn|manhattan|seattle|bellevue|redmond|boston|cambridge|los angeles|la,? ca|chicago|denver|miami|atlanta|austin,?\s*tx|plano|dallas|frisco|irving|dfw|toronto|sao paulo)\b/i;
const NON_US_REGIONS = /\b(uk|emea|europe|india|apac|canada|australia|mexico|brazil|argentina|colombia|buenos aires|spain|germany|france|netherlands|tokyo|singapore|tel aviv|amsterdam|berlin|london|dublin|hong kong|chengdu|beijing|shanghai|sao paulo|mexico city|toronto|vancouver|ontario)\b/i;

function isAcceptableLocation(loc, locType) {
  const lc = loc.toLowerCase();
  const lt = (locType || '').toLowerCase();
  if (NON_US_REGIONS.test(lc)) return { ok: false };
  if (LOCAL_RE && LOCAL_RE.test(lc)) return { ok: true, kind: LOCAL_LABEL };
  if (NON_LOCAL_CITIES.test(lc) && (!LOCAL_RE || !LOCAL_RE.test(lc))) return { ok: false };
  if (lt === 'on-site' || lt === 'hybrid' || lt === 'in-office') return { ok: false };
  if (/remote\s*-?\s*(us|united states|americas?|north america)/i.test(lc)) return { ok: true, kind: 'REMOTE-US' };
  if (/^remote$/i.test(lc.trim())) return { ok: true, kind: 'REMOTE' };
  if (/\bremote\b/i.test(lc) && /\b(us|united states|america|texas|north america)\b/i.test(lc)) return { ok: true, kind: 'REMOTE-US' };
  return { ok: false };
}

const matches = [];
const companies = (portals.tracked_companies || []).filter(c => c.enabled !== false);

await Promise.all(companies.map(async c => {
  if (engagedCompanies.has(c.name.toLowerCase())) return;
  const api = detectApi(c);
  if (!api) return;
  let slug = '';
  const m = (c.careers_url || '').match(/jobs\.ashbyhq\.com\/([^/?#]+)/);
  if (m) slug = m[1];
  try {
    const r = await fetch(api.url, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) return;
    const j = await r.json();
    let jobs = [];
    if (api.type === 'greenhouse') jobs = j.jobs || [];
    else if (api.type === 'ashby') jobs = j.jobs || [];
    else if (api.type === 'lever') jobs = j;
    for (const job of jobs) {
      const title = (job.title || job.text || '').trim();
      const loc = getLocation(job, api.type);
      const locType = getLocationType(job, api.type);
      const url = getUrl(job, api.type, slug);
      if (!url || !pendingUrls.has(url)) continue;
      if (EXCLUDE_LEVEL_RE.test(title)) continue;
      if (HARD_EXCLUDE_RE.test(title)) continue;
      if (!ROLE_RE.test(title)) continue;
      const check = isAcceptableLocation(loc, locType);
      if (!check.ok) continue;
      matches.push({ company: c.name, title, location: loc, locType, url, kind: check.kind });
    }
  } catch (e) {}
}));

matches.sort((a, b) => a.kind.localeCompare(b.kind) || a.company.localeCompare(b.company));
console.log(`Found ${matches.length} Senior IC engineering roles, location-verified, no engaged companies:\n`);
let last = '';
for (const m of matches) {
  if (m.kind !== last) { console.log(`\n## ${m.kind}\n`); last = m.kind; }
  console.log(`  + ${m.company} | ${m.title} | ${m.location}${m.locType ? ` [${m.locType}]` : ''}`);
  console.log(`    ${m.url}`);
}
