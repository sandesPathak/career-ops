import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { execFile as _execFile } from 'node:child_process';
const execFile = promisify(_execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const PUBLIC = join(__dirname, 'public');
const PORT = process.env.PORT || 4173;
const SUPPORT_DIR = process.env.CAREER_OPS_SUPPORT_DIR
  || join(process.env.HOME || '', 'Library', 'Application Support', 'career-ops-refresh');
const OVERLAY_DIR = join(SUPPORT_DIR);
const OVERLAY_FILE = join(OVERLAY_DIR, 'tracker-overlay.json');

// LEGACY regex fallback — only used for cache entries written before 0.7.0 that have
// no `intent` field. New refreshes (post-0.7.0) classify at refresh time using Claude's
// natural-language understanding, which catches edge cases like "thank you for your
// interest" appearing in BOTH rejections and applied-acks. See
// tools/email-refresh/prompt.md Step 5 for the canonical classifier.
//
// Order: applied-ack BEFORE rejection — receipt language wins over generic subject
// hints. This was the bug fixed in 0.7.0 (Luxury Presence ack mis-tagged as rejection).
const INTENT_RULES = [
  { intent: 'applied-ack', re: /(thank(?:s)? (?:you )?for (?:applying|your application)|we (?:have )?received your application|application (?:has been )?received|we'?ll be in touch|will be in touch if|team will review your application|we appreciate your interest in joining|we will review your application)/i },
  { intent: 'rejection', re: /(unfortunately[, ]+(?:we|after)|we (?:have|'ve) decided (?:not to|to (?:move forward|pursue))|won['’]t be moving forward|not (?:moving|to move) forward|moving forward with other candidates|decided not to (?:move forward|proceed)|chose to move forward with (?:another|other)|no longer being considered|wasn['’]t selected|cannot move forward at this time)/i },
  { intent: 'offer', re: /(pleased to (?:offer|extend)|offer letter|congratulations[\s\S]{0,40}offer|extending an offer|formal offer|offer of employment)/i },
  // NB: dropped "next steps?" — appears in applied-acks ("get back to you if there are next steps").
  // Now requires explicit scheduling language only.
  { intent: 'interview-request', re: /(schedule (?:a |an )?(?:call|interview|chat)|book a time|calendly|interview availability|find a time(?: that works| on (?:my|the))|set up a (?:call|chat)|let['’]s connect|chat with (?:me|us|the)|invite (?:you )?to (?:interview|chat)|like to (?:set up|schedule))/i },
  { intent: 'recruiter-outreach', re: /(came across your profile|reaching out about|exciting opportunity|saw your background|wanted to connect about a role)/i },
  { intent: 'security-code', re: /security code|verification code|2fa|two-factor/i },
];

const ACTIONS_BY_INTENT = {
  'offer': { label: 'Mark as Offer', target: 'Offer', tone: 'go' },
  'rejection': { label: 'Mark as Rejected', target: 'Rejected', tone: 'stop' },
  'interview-request': { label: 'Mark as Interview', target: 'Interview', tone: 'go' },
  'applied-ack': { label: 'Confirm Applied', target: 'Applied', tone: 'soft' },
  'security-code': { label: 'Open in Gmail', target: null, tone: 'soft' },
  'recruiter-outreach': { label: 'Open in Gmail', target: null, tone: 'soft' },
  'other': { label: 'Open in Gmail', target: null, tone: 'soft' },
};

// Classification source of truth: the cached `intent` field, written at refresh time
// by Claude reading the full body. Falls through to legacy regex only when the cache
// entry has no intent (pre-0.7.0 caches).
function classifyIntent(subject, snippet, body, cachedIntent) {
  if (cachedIntent && typeof cachedIntent === 'string') return cachedIntent;
  const text = `${subject || ''}\n${snippet || ''}\n${body || ''}`;
  for (const { intent, re } of INTENT_RULES) if (re.test(text)) return intent;
  return 'other';
}

async function loadOverlay() {
  try {
    const raw = await readFile(OVERLAY_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return { entries: {} };
  }
}

async function saveOverlay(o) {
  try {
    await mkdir(OVERLAY_DIR, { recursive: true });
    await writeFile(OVERLAY_FILE, JSON.stringify(o, null, 2));
  } catch (e) { console.error('overlay write failed', e); }
}

function applyOverlay(rows, overlay) {
  if (!overlay || !overlay.entries) return rows;
  return rows.map((r) => {
    const o = overlay.entries[r.num];
    if (!o) return r;
    return { ...r, status: o.status || r.status, _overlay: o };
  });
}

function findTrackerMatch(rows, company) {
  if (!company) return null;
  const lc = company.toLowerCase();
  let exact = rows.find((r) => r.company.toLowerCase() === lc);
  if (exact) return exact;
  let fuzzy = rows.find((r) => {
    const rc = r.company.toLowerCase();
    return rc.includes(lc) || lc.includes(rc);
  });
  return fuzzy || null;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

function parseApplications(md) {
  const lines = md.split('\n');
  const rows = [];
  for (const line of lines) {
    if (!line.startsWith('|')) continue;
    if (line.startsWith('| #') || line.startsWith('|---')) continue;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length < 9) continue;
    const [num, date, company, role, score, status, pdf, report, notes] = cells;
    if (!/^\d+$/.test(num)) continue;
    const scoreNum = parseFloat(String(score).replace('/5', '')) || 0;
    let reportMatch = report.match(/\((reports\/[^)]+)\)/);
    if (!reportMatch) {
      const bare = report.match(/^(\d{3})$/);
      if (bare) reportMatch = [null, `__bare__${bare[1]}`];
    }
    rows.push({
      num: Number(num),
      date,
      company,
      role,
      score: scoreNum,
      scoreText: score,
      status,
      pdf: pdf === '✅',
      reportPath: reportMatch ? reportMatch[1] : null,
      notes,
      // URLs we can extract from the notes column. Used by "Open posting" so it
      // works even for rows with no report file (n/a in the report column).
      // Catches both `https://...` and `URL: jobs.ashbyhq.com/...` (scheme-less)
      // patterns common in tracker notes.
      urls: extractUrls(notes),
    });
  }
  return rows;
}

function isoForDate(s) {
  // Tracker dates are YYYY-MM-DD. Pad to ISO so localeCompare sorts cleanly.
  if (!s) return null;
  const m = String(s).match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? `${m[1]}T12:00:00Z` : null;
}

function trackerEventType(status) {
  const s = String(status || '').toLowerCase();
  if (/offer/.test(s)) return 'offer';
  if (/interview|responded/.test(s)) return 'interview';
  if (/^applied/.test(s)) return 'applied';
  if (/rejected/.test(s)) return 'rejection';
  if (/discarded|skip/.test(s)) return 'closed';
  return 'evaluated';
}

function extractUrls(text) {
  if (!text) return [];
  const urls = [];
  const clean = (u) => u.replace(/[.,;:!?)\]'"`]+$/, ''); // strip trailing punctuation
  for (const m of text.matchAll(/https?:\/\/[^\s|)<>"]+/g)) urls.push(clean(m[0]));
  for (const m of text.matchAll(/URL:\s*([^\s|)<>"]+)/gi)) {
    const u = clean(m[1]);
    const withScheme = /^https?:\/\//.test(u) ? u : 'https://' + u;
    if (!urls.includes(withScheme) && !urls.includes(u)) urls.push(withScheme);
  }
  return urls;
}

function safeJoin(base, path) {
  const p = resolve(base, '.' + path);
  if (!p.startsWith(base)) return null;
  return p;
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let pathname = url.pathname === '/' ? '/index.html' : url.pathname;
  const filePath = safeJoin(PUBLIC, pathname);
  if (!filePath) return send(res, 403, 'forbidden');
  try {
    const data = await readFile(filePath);
    res.writeHead(200, { 'content-type': MIME[extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    send(res, 404, 'not found');
  }
}

function send(res, code, body, type = 'text/plain') {
  // No-cache on JSON API responses so the browser doesn't mask server-side fixes.
  const headers = { 'content-type': type };
  if (type && type.includes('application/json')) headers['cache-control'] = 'no-store, must-revalidate';
  res.writeHead(code, headers);
  res.end(body);
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/api/applications') {
    try {
      const md = await readFile(join(ROOT, 'data', 'applications.md'), 'utf8');
      let rows = parseApplications(md);
      const overlay = await loadOverlay();
      rows = applyOverlay(rows, overlay);
      send(res, 200, JSON.stringify({ rows, count: rows.length, overlay }), 'application/json; charset=utf-8');
    } catch (e) {
      send(res, 500, JSON.stringify({ error: e.message }), 'application/json');
    }
    return;
  }

  if (url.pathname === '/api/overlay' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    let payload;
    try { payload = JSON.parse(body); }
    catch { return send(res, 400, JSON.stringify({ error: 'bad json' }), 'application/json'); }
    const { num, status, note, source } = payload || {};
    if (!num || !status) return send(res, 400, JSON.stringify({ error: 'num + status required' }), 'application/json');
    const overlay = await loadOverlay();
    overlay.entries = overlay.entries || {};
    overlay.entries[num] = { status, note: note || null, source: source || 'ui', ts: new Date().toISOString() };
    await saveOverlay(overlay);
    send(res, 200, JSON.stringify({ ok: true, entry: overlay.entries[num] }), 'application/json; charset=utf-8');
    return;
  }

  if (url.pathname === '/api/overlay/reset' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    let payload;
    try { payload = JSON.parse(body); } catch { payload = {}; }
    const overlay = await loadOverlay();
    overlay.entries = overlay.entries || {};
    if (payload.num) delete overlay.entries[payload.num];
    else overlay.entries = {};
    await saveOverlay(overlay);
    send(res, 200, JSON.stringify({ ok: true }), 'application/json; charset=utf-8');
    return;
  }

  if (url.pathname === '/api/report') {
    let p = url.searchParams.get('path') || '';
    if (p.startsWith('__bare__')) {
      const num = p.slice('__bare__'.length);
      try {
        const { readdir } = await import('node:fs/promises');
        const files = await readdir(join(ROOT, 'reports'));
        const match = files.find((f) => f.startsWith(num + '-'));
        if (!match) return send(res, 404, 'not found');
        p = `reports/${match}`;
      } catch { return send(res, 404, 'not found'); }
    }
    if (!p.startsWith('reports/')) return send(res, 400, 'bad path');
    const abs = safeJoin(ROOT, '/' + p);
    if (!abs) return send(res, 403, 'forbidden');
    try {
      const md = await readFile(abs, 'utf8');
      send(res, 200, md, 'text/markdown; charset=utf-8');
    } catch {
      send(res, 404, 'not found');
    }
    return;
  }

  if (url.pathname === '/api/emails') {
    const candidates = [
      join(SUPPORT_DIR, 'emails-cache.json'),
      join(ROOT, 'data', 'emails-cache.json'),
    ];
    let raw = null, source = null;
    for (const path of candidates) {
      try { raw = await readFile(path, 'utf8'); source = path; break; } catch {}
    }
    let parsed;
    try { parsed = raw ? JSON.parse(raw) : { byCompany: {}, fetchedAt: null }; }
    catch { parsed = { byCompany: {}, fetchedAt: null }; }

    const md = await readFile(join(ROOT, 'data', 'applications.md'), 'utf8').catch(() => '');
    const overlay = await loadOverlay();
    const rows = applyOverlay(parseApplications(md), overlay);

    const byCompany = parsed.byCompany || {};
    const enrichedByCompany = {};
    for (const [company, list] of Object.entries(byCompany)) {
      const trackerMatch = findTrackerMatch(rows, company);
      enrichedByCompany[company] = list.map((m) => {
        const intent = classifyIntent(m.subject, m.snippet, m.body, m.intent);
        const action = ACTIONS_BY_INTENT[intent] || ACTIONS_BY_INTENT.other;
        const mismatch = trackerMatch && intent === 'applied-ack'
          && !['Applied', 'Interview', 'Offer', 'Responded', 'Rejected'].includes(trackerMatch.status);
        return {
          ...m,
          intent,
          action,
          tracker: trackerMatch ? { num: trackerMatch.num, role: trackerMatch.role, score: trackerMatch.score, status: trackerMatch.status } : null,
          trackerMismatch: !!mismatch,
        };
      });
    }
    parsed.byCompany = enrichedByCompany;
    parsed._source = source;
    send(res, 200, JSON.stringify(parsed), 'application/json; charset=utf-8');
    return;
  }

  if (url.pathname === '/api/feed') {
    // Unified time-sorted activity feed: tracker rows + email threads.
    // Each event has shape { id, ts, type, company, role, num, summary, urls, intent, status, score, sender, threadId }
    const md = await readFile(join(ROOT, 'data', 'applications.md'), 'utf8').catch(() => '');
    const overlay = await loadOverlay();
    const rows = applyOverlay(parseApplications(md), overlay);

    // Email cache
    let emails = { byCompany: {}, fetchedAt: null };
    try {
      const candidates = [join(SUPPORT_DIR, 'emails-cache.json'), join(ROOT, 'data', 'emails-cache.json')];
      for (const p of candidates) {
        try { emails = JSON.parse(await readFile(p, 'utf8')); break; } catch {}
      }
    } catch {}

    const events = [];

    // Tracker events — one per row, dated by the row's date column. Type derived from current status.
    for (const r of rows) {
      const ts = isoForDate(r.date);
      events.push({
        id: `t:${r.num}`,
        ts,
        source: 'tracker',
        type: trackerEventType(r.status),
        status: r.status,
        company: r.company,
        role: r.role,
        num: r.num,
        score: r.score,
        scoreText: r.scoreText,
        urls: r.urls || [],
        reportPath: r.reportPath,
        summary: (r.notes || '').slice(0, 200),
      });
    }

    // Email events — one per thread.
    for (const [company, threads] of Object.entries(emails.byCompany || {})) {
      const trackerMatch = findTrackerMatch(rows, company);
      for (const m of threads || []) {
        const intent = classifyIntent(m.subject, m.snippet, m.body, m.intent);
        const ts = m.date || null;
        events.push({
          id: `e:${m.threadId}`,
          ts,
          source: 'email',
          type: intent === 'rejection' ? 'rejection'
              : intent === 'offer' ? 'offer'
              : (intent === 'interview-request' || intent === 'interview-scheduling' || intent === 'interview-followup') ? 'interview'
              : intent === 'applied-ack' ? 'ack'
              : 'email',
          intent,
          // Surface Claude's confidence + reason from the cache so the UI can flag
          // low-confidence calls and let the user see WHY a thread was classified.
          confidence: m.confidence || null,
          reason: m.reason || null,
          // Was this regex-classified at read-time (legacy) or Claude-classified at
          // refresh-time (new)? Helps the UI show a "regex fallback" warning.
          classifiedBy: m.intent ? 'claude' : 'regex',
          company,
          role: trackerMatch?.role || null,
          num: trackerMatch?.num || null,
          score: trackerMatch?.score || null,
          subject: m.subject,
          sender: m.sender,
          threadId: m.threadId,
          // Show snippet by default (compact), make full body available on expand.
          summary: (m.snippet || '').slice(0, 280),
          body: m.body || null,
          urls: trackerMatch?.urls || [],
        });
      }
    }

    // Sort newest first; events without ts go to the bottom
    events.sort((a, b) => {
      if (!a.ts && !b.ts) return 0;
      if (!a.ts) return 1;
      if (!b.ts) return -1;
      return b.ts.localeCompare(a.ts);
    });

    send(res, 200, JSON.stringify({
      events,
      fetchedAt: emails.fetchedAt || null,
    }), 'application/json; charset=utf-8');
    return;
  }

  if (url.pathname === '/api/emails/refresh' && req.method === 'POST') {
    try {
      // Find the claude CLI on PATH (or via $CLAUDE_BIN env)
      let claudeBin = process.env.CLAUDE_BIN || '';
      if (!claudeBin) {
        try {
          const { stdout } = await execFile('which', ['claude']);
          claudeBin = stdout.trim();
        } catch {}
      }
      if (!claudeBin) {
        send(res, 500, JSON.stringify({
          error: 'claude CLI not found on PATH',
          hint: 'Install Claude Code (https://docs.claude.com/code), then set $CLAUDE_BIN or rerun this from a shell where `claude` is on PATH.',
        }), 'application/json');
        return;
      }

      const promptPath = join(ROOT, 'tools', 'email-refresh', 'prompt.md');
      const cacheFile = join(SUPPORT_DIR, 'emails-cache.json');
      let prompt;
      try { prompt = await readFile(promptPath, 'utf8'); }
      catch {
        send(res, 500, JSON.stringify({
          error: 'tools/email-refresh/prompt.md not found',
          hint: 'This file ships with the repo — check that you cloned the full tree.',
        }), 'application/json');
        return;
      }

      await mkdir(SUPPORT_DIR, { recursive: true });

      // Spawn claude headless. Stream output to logs but cap wait at 4 minutes.
      const child = spawn(claudeBin, [
        '--print',
        '--permission-mode', 'bypassPermissions',
        '--allowed-tools', 'mcp__claude_ai_Gmail__search_threads,mcp__claude_ai_Gmail__get_thread,Read,Write,Edit,Bash',
        '--append-system-prompt', 'Headless cache refresh. Be terse. No questions.',
        prompt,
      ], {
        env: { ...process.env, CACHE_FILE: cacheFile },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '', stderr = '';
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });

      // Gmail searches with MCP can take 5–8 min on a busy inbox the first time.
      const timeout = setTimeout(() => child.kill('SIGTERM'), 8 * 60 * 1000);
      const code = await new Promise((r) => child.on('close', r));
      clearTimeout(timeout);

      if (code !== 0) {
        send(res, 500, JSON.stringify({
          error: `claude exited ${code}`,
          stderr: (stderr || '').slice(-2000),
          stdout: (stdout || '').slice(-2000),
          hint: 'Most common cause: Gmail MCP not authenticated. Run `claude` interactively, type /mcp, and connect Gmail.',
        }), 'application/json');
        return;
      }

      // Read the cache the prompt just wrote
      let cache = { byCompany: {}, fetchedAt: null };
      try { cache = JSON.parse(await readFile(cacheFile, 'utf8')); } catch {}
      const summary = (stdout || '').trim().split('\n').pop() || 'refresh complete';
      send(res, 200, JSON.stringify({
        ok: true,
        summary,
        fetchedAt: cache.fetchedAt,
        companyCount: Object.keys(cache.byCompany || {}).length,
        threadCount: Object.values(cache.byCompany || {}).reduce((n, l) => n + l.length, 0),
      }), 'application/json; charset=utf-8');
    } catch (e) {
      send(res, 500, JSON.stringify({ error: e.message }), 'application/json');
    }
    return;
  }

  if (url.pathname === '/api/pipeline') {
    try {
      const md = await readFile(join(ROOT, 'data', 'pipeline.md'), 'utf8');
      const pending = (md.match(/^- \[ \]/gm) || []).length;
      const done = (md.match(/^- \[x\]/gmi) || []).length;
      send(res, 200, JSON.stringify({ pending, done }), 'application/json; charset=utf-8');
    } catch (e) {
      send(res, 500, JSON.stringify({ error: e.message }), 'application/json');
    }
    return;
  }

  return serveStatic(req, res);
}

createServer(handle).listen(PORT, () => {
  console.log(`career-ops UI → http://localhost:${PORT}`);
});
