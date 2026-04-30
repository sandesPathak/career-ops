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

// Already-applied companies (skip these companies to avoid double-applying)
const appliedCompanies = new Set();
for (const line of applications.split('\n')) {
  const m = line.match(/\| \d+ \| \d{4}-\d{2}-\d{2} \| ([^|]+) \|.*\| Applied \|/);
  if (m) appliedCompanies.add(m[1].trim().toLowerCase());
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

// Senior-IC level: exclude Staff/Principal/Director/Manager/Head/VP/Founding/Lead-as-mgr
const EXCLUDE_LEVEL_RE = /\b(staff|principal|director|head of|vice president|vp|chief|founding|distinguished|fellow|manager)\b/i;

// Match any engineering title with AI/ML/LLM/agent context, OR Forward Deployed Engineer
const AI_ENGINEER_RE = /\b(ai|ml|llm|agent|agentic|genai|gen ?ai|machine learning|applied ml|applied ai|forward deployed)\b[^|]*\b(engineer|architect|developer|builder|scientist)\b|\b(engineer|architect|developer|builder)\b[^|]*\b(ai|ml|llm|agent|agentic|genai|machine learning|forward deployed)\b/i;

// Hard exclusions: research-only, hardware, non-eng
const HARD_EXCLUDE_RE = /\b(research scientist|research lead|hardware engineer|silicon|firmware|driver developer|policy|legal counsel|sales engineer|account executive|marketing|recruiter|talent acquisition|business development|gtm representative|customer success)\b/i;

const matches = [];
const companies = (portals.tracked_companies || []).filter(c => c.enabled !== false);

await Promise.all(companies.map(async c => {
  const api = detectApi(c);
  if (!api) return;
  if (appliedCompanies.has(c.name.toLowerCase())) return;
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
      if (EXCLUDE_LEVEL_RE.test(title)) continue;
      if (HARD_EXCLUDE_RE.test(title)) continue;
      if (!AI_ENGINEER_RE.test(title)) continue;
      const lc = loc.toLowerCase();
      const isRemoteUS = lc.includes('remote') &&
        (lc.includes('us') || lc.includes('united states') || lc.includes('america') ||
         lc.includes('texas') || lc.includes('north america')) &&
        !lc.match(/\b(uk|emea|europe|india|apac|canada|australia|mexico|brazil|argentina|colombia|buenos aires|spain)\b/);
      const isRemoteOnly = lc.trim() === 'remote' || /^us \| remote|usa \| remote/.test(lc);
      if (isRemoteUS || isRemoteOnly) {
        matches.push({ company: c.name, title, location: loc, url });
      }
    }
  } catch (e) {}
}));

matches.sort((a, b) => a.company.localeCompare(b.company) || a.title.localeCompare(b.title));
console.log(`Found ${matches.length} AI/ML Engineer Remote-US roles (Senior IC, no Staff/Mgr, excluding companies already applied):\n`);
for (const m of matches) {
  console.log(`  + ${m.company} | ${m.title} | ${m.location}`);
  console.log(`    ${m.url}`);
}
