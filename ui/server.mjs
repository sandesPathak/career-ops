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

// Order matters — first match wins. Rejection-class signals come BEFORE interview/applied-ack
// because rejection emails sometimes contain "thank you for applying" boilerplate at the top.
// Keep this list synced with the kind classifier in tools/email-refresh/prompt.md Step 5.
const INTENT_RULES = [
  { intent: 'rejection', re: /(unfortunately[, ]+(?:we|after)|we (?:have|'ve) decided (?:not to|to (?:move forward|pursue))|won['’]t be moving forward|not (?:moving|to move) forward|moving forward with other candidates|decided not to (?:move forward|proceed)|chose to move forward with (?:another|other)|not be (?:a fit|moving forward)|no longer being considered|not (?:selected|moving|to move)|wasn['’]t selected|cannot move forward|other candidates|update on your application|regarding your application|thank you for your interest|status of your application)/i },
  { intent: 'offer', re: /(pleased to (?:offer|extend)|offer letter|congratulations[\s\S]{0,40}offer|extending an offer|formal offer|offer of employment)/i },
  { intent: 'interview-request', re: /(schedule (?:a |an )?(?:call|interview|chat)|book a time|calendly|next steps?|interview availability|find a time|set up a (?:call|chat)|let['’]s connect|chat with|invite to (?:interview|chat))/i },
  { intent: 'recruiter-outreach', re: /(came across your profile|reaching out about|exciting opportunity|saw your background|wanted to connect about a role)/i },
  { intent: 'security-code', re: /security code|verification code|2fa|two-factor/i },
  { intent: 'applied-ack', re: /(thank(?:s)? you for (?:applying|your application)|application (?:has been )?received|we received your application|thanks for applying)/i },
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

function classifyIntent(subject, snippet, body) {
  // Search across subject + snippet + body so rejections buried in body language get caught.
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
  res.writeHead(code, { 'content-type': type });
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
        const intent = classifyIntent(m.subject, m.snippet, m.body);
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
