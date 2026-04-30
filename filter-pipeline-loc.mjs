#!/usr/bin/env node
import { readFileSync } from 'fs';
import yaml from 'js-yaml';

const portals = yaml.load(readFileSync('portals.yml', 'utf8'));
const pipeline = readFileSync('data/pipeline.md', 'utf8');
const profile = yaml.load(readFileSync('config/profile.yml', 'utf8'));
const LP = profile.location_policy || {};
// Prefer explicit location_policy.acceptable_local_substrings; fall back to deriving from location.city.
const LOCAL_SUBSTRINGS = ((LP.acceptable_local_substrings && LP.acceptable_local_substrings.length)
  ? LP.acceptable_local_substrings
  : [profile.location?.city, profile.location?.state].filter(Boolean)
).map(s => String(s).toLowerCase());
const LOCAL_LABEL = LOCAL_SUBSTRINGS.length ? LOCAL_SUBSTRINGS[0].toUpperCase() : 'LOCAL';

const pendingUrls = new Set();
for (const line of pipeline.split('\n')) {
  const m = line.match(/^- \[ \] (https?:\/\/\S+)/);
  if (m) pendingUrls.add(m[1]);
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

function locOf(j, type) {
  if (type === 'greenhouse') return j.location?.name || '';
  if (type === 'ashby') return j.location || (j.locations || []).map(l => l.locationName || l).join('; ');
  if (type === 'lever') return j.categories?.location || (j.categories?.allLocations || []).join('; ') || '';
  return '';
}
function urlOf(j, type, slug) {
  if (type === 'greenhouse') return j.absolute_url;
  if (type === 'ashby') return j.jobUrl || j.applyUrl || `https://jobs.ashbyhq.com/${slug}/${j.id}`;
  if (type === 'lever') return j.hostedUrl || j.applyUrl;
  return '';
}

// Exclude titles above Senior IC level or non-engineering leadership
const EXCLUDE_LEVEL_RE = /\b(staff|principal|director|head of|vice president|vp|chief|founding|distinguished|fellow|manager|lead(?!s\b))\b/i;
const EXCLUDE_NON_ENG_RE = /\b(supply chain|procurement|recruiter|talent researcher|business systems|sales|gtm representative|alliance director|legal|policy|contracts|business expert|partnership|consultant|outcomes|strategy|operations,? gtm|ai operations|gtm)\b/i;

function isAllowed(title) {
  const t = title.toLowerCase();
  if (EXCLUDE_LEVEL_RE.test(t)) return false;
  if (EXCLUDE_NON_ENG_RE.test(t)) return false;
  return true;
}

const matches = [];
const companies = (portals.tracked_companies || []).filter(c => c.enabled !== false);

await Promise.all(companies.map(async c => {
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
      const loc = locOf(job, api.type);
      const url = urlOf(job, api.type, slug);
      if (!url || !pendingUrls.has(url)) continue;
      if (!isAllowed(title)) continue;
      const lc = loc.toLowerCase();
      const isLocal = LOCAL_SUBSTRINGS.some(s => lc.includes(s));
      const isRemoteUS = lc.includes('remote') && (lc.includes('us') || lc.includes('united states') || lc.includes('america') || lc.includes('north america')) && !lc.match(/\b(uk|emea|europe|india|apac|canada|australia|mexico|brazil|argentina|colombia|buenos aires)\b/);
      const isRemoteOnly = lc.trim() === 'remote' || /^us \| remote|usa \| remote/.test(lc);
      if (isLocal || isRemoteUS || isRemoteOnly) {
        matches.push({ company: c.name, title, location: loc, url, kind: isLocal ? LOCAL_LABEL : 'REMOTE-US' });
      }
    }
  } catch (e) {}
}));

matches.sort((a, b) => a.kind.localeCompare(b.kind) || a.company.localeCompare(b.company));
console.log(`Found ${matches.length} pending offers (Senior-IC, ${LOCAL_LABEL} or Remote-US):\n`);
let last = '';
for (const m of matches) {
  if (m.kind !== last) { console.log(`\n## ${m.kind}\n`); last = m.kind; }
  console.log(`  + ${m.company} | ${m.title} | ${m.location}`);
}
