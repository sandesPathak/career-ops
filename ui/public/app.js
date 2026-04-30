const STATUS_ORDER = ['Applied', 'Interview', 'Offer', 'Responded', 'Evaluated', 'Discarded', 'SKIP', 'Rejected'];
const INTENT_ORDER = ['offer', 'interview-request', 'rejection', 'recruiter-outreach', 'security-code', 'applied-ack', 'other'];
const INTENT_LABELS = {
  'offer': 'Offer',
  'interview-request': 'Interview',
  'rejection': 'Rejection',
  'recruiter-outreach': 'Recruiter',
  'security-code': 'Security code',
  'applied-ack': 'Applied (ack)',
  'other': 'Other',
};
const SCORE_BUCKETS = [
  { key: 'all', label: 'All', match: () => true },
  { key: 'top', label: '4.5+', match: (r) => r.score >= 4.5 },
  { key: 'good', label: '4–4.4', match: (r) => r.score >= 4 && r.score < 4.5 },
  { key: 'mid', label: '3–3.9', match: (r) => r.score >= 3 && r.score < 4 },
  { key: 'low', label: '<3', match: (r) => r.score < 3 },
];

const state = {
  rows: [],
  emailsByCompany: {},
  emailsFetchedAt: null,
  pipelinePending: 0,
  search: '',
  statusFilter: 'all',
  scoreFilter: 'all',
  emailFilter: 'any',
  inboxIntentFilter: 'all',
  expandedThread: null,
  sort: 'score',
  view: 'pipeline',
  selectedNum: null,
};

const $ = (id) => document.getElementById(id);

function scoreClass(s) {
  if (s >= 4.5) return 's5';
  if (s >= 4) return 's4';
  if (s >= 3) return 's3';
  if (s >= 2) return 's2';
  return 's1';
}

function escape(s) {
  return String(s ?? '').replace(/[<>&"']/g, (c) => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

function timeAgo(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const days = Math.round(diff / 86400000);
  if (days < 1) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.round(days / 7)}w ago`;
  if (days < 365) return `${Math.round(days / 30)}mo ago`;
  return `${Math.round(days / 365)}y ago`;
}

function emailsFor(company) {
  if (!company) return [];
  if (state.emailsByCompany[company]) return state.emailsByCompany[company];
  const lc = company.toLowerCase();
  for (const k of Object.keys(state.emailsByCompany)) {
    const klc = k.toLowerCase();
    if (klc === lc || lc.includes(klc) || klc.includes(lc)) return state.emailsByCompany[k];
  }
  return [];
}

function totalEmails() {
  return Object.values(state.emailsByCompany).reduce((s, a) => s + a.length, 0);
}

function statusCounts() {
  const c = { all: state.rows.length };
  for (const r of state.rows) c[r.status] = (c[r.status] || 0) + 1;
  return c;
}

async function loadAll() {
  const [a, p, e] = await Promise.all([
    fetch('/api/applications').then((r) => r.json()),
    fetch('/api/pipeline').then((r) => r.json()).catch(() => ({ pending: 0 })),
    fetch('/api/emails').then((r) => r.json()).catch(() => ({ byCompany: {} })),
  ]);
  state.rows = a.rows;
  state.pipelinePending = p.pending || 0;
  state.emailsByCompany = e.byCompany || {};
  state.emailsFetchedAt = e.fetchedAt;
  if (!state.selectedNum && state.rows.length) {
    state.selectedNum = sortedRows(state.rows)[0].num;
  }
  render();
}

async function refreshEmails() {
  const btn = $('refreshEmailsBtn');
  const status = $('inboxStatus');
  if (!btn || !status) return;
  btn.disabled = true;
  const orig = btn.textContent;
  btn.textContent = '↻ Refreshing…';
  status.hidden = false;
  status.className = 'inbox-status pending';
  status.textContent = 'Running Gmail search via Claude CLI… first run can take 5–8 minutes; subsequent runs are faster.';
  try {
    const r = await fetch('/api/emails/refresh', { method: 'POST' });
    const j = await r.json();
    if (!r.ok || !j.ok) {
      status.className = 'inbox-status error';
      const hint = j.hint ? `\n\nHint: ${j.hint}` : '';
      status.textContent = `Refresh failed: ${j.error || 'unknown error'}${hint}`;
      return;
    }
    status.className = 'inbox-status ok';
    status.textContent = `Refreshed: ${j.companyCount} companies, ${j.threadCount} threads. ${j.summary || ''}`;
    // Refetch and re-render
    const fresh = await fetch('/api/emails').then((x) => x.json()).catch(() => null);
    if (fresh) {
      state.emailsByCompany = fresh.byCompany || {};
      state.emailsFetchedAt = fresh.fetchedAt;
      renderInbox();
    }
  } catch (e) {
    status.className = 'inbox-status error';
    status.textContent = `Refresh failed: ${e.message}`;
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
  }
}

document.addEventListener('click', (ev) => {
  if (ev.target && ev.target.id === 'refreshEmailsBtn') refreshEmails();
});

function sortedRows(rows) {
  const out = [...rows];
  switch (state.sort) {
    case 'date': return out.sort((a, b) => b.date.localeCompare(a.date) || b.score - a.score);
    case 'company': return out.sort((a, b) => a.company.localeCompare(b.company));
    case 'emails': return out.sort((a, b) => emailsFor(b.company).length - emailsFor(a.company).length || b.score - a.score);
    default: return out.sort((a, b) => b.score - a.score || a.date.localeCompare(b.date));
  }
}

function visibleRows() {
  let out = state.rows;
  if (state.statusFilter !== 'all') out = out.filter((r) => r.status === state.statusFilter);
  const sb = SCORE_BUCKETS.find((s) => s.key === state.scoreFilter);
  if (sb) out = out.filter(sb.match);
  if (state.emailFilter === 'yes') out = out.filter((r) => emailsFor(r.company).length > 0);
  if (state.emailFilter === 'no') out = out.filter((r) => emailsFor(r.company).length === 0);
  if (state.search) {
    const q = state.search.toLowerCase();
    out = out.filter((r) =>
      r.company.toLowerCase().includes(q) ||
      r.role.toLowerCase().includes(q) ||
      (r.notes || '').toLowerCase().includes(q)
    );
  }
  return sortedRows(out);
}

function allEmails() {
  const out = [];
  for (const [company, list] of Object.entries(state.emailsByCompany)) {
    for (const m of list) out.push({ company, ...m });
  }
  return out;
}

function visibleEmails() {
  let f = allEmails();
  if (state.inboxIntentFilter !== 'all') f = f.filter((m) => m.intent === state.inboxIntentFilter);
  if (state.search) {
    const q = state.search.toLowerCase();
    f = f.filter((m) =>
      m.company.toLowerCase().includes(q) ||
      (m.subject || '').toLowerCase().includes(q) ||
      (m.snippet || '').toLowerCase().includes(q) ||
      (m.sender || '').toLowerCase().includes(q)
    );
  }
  return f.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}

/* RENDER */

function render() {
  renderKpis();
  renderNav();
  if (state.view === 'pipeline') {
    renderFilters();
    renderRowList();
    renderDetail();
  } else if (state.view === 'inbox') {
    renderInbox();
  } else if (state.view === 'companies') {
    renderCompanies();
  }
}

function renderKpis() {
  const counts = statusCounts();
  const top = state.rows.filter((r) => r.score >= 4).length;
  const avg = state.rows.length ? (state.rows.reduce((s, r) => s + r.score, 0) / state.rows.length).toFixed(2) : '—';
  $('kpi-offers').textContent = state.rows.length;
  $('kpi-applied').textContent = counts.Applied || 0;
  $('kpi-evaluated').textContent = counts.Evaluated || 0;
  $('kpi-top').textContent = top;
  $('kpi-emails').textContent = totalEmails();
  $('kpi-pipeline').textContent = state.pipelinePending;
  $('kpi-avg').textContent = avg;
}

function renderNav() {
  document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === state.view));
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${state.view}`));
}

function renderFilters() {
  const counts = statusCounts();
  const sf = $('statusFilters');
  const items = [{ key: 'all', label: 'All' }, ...STATUS_ORDER.filter((s) => counts[s]).map((s) => ({ key: s, label: s }))];
  sf.innerHTML = items.map((it) => `
    <button class="chip ${state.statusFilter === it.key ? 'active' : ''}" data-status="${escape(it.key)}">
      ${escape(it.label)}<span class="count">${counts[it.key] || 0}</span>
    </button>
  `).join('');
  sf.querySelectorAll('.chip').forEach((b) => b.addEventListener('click', () => {
    state.statusFilter = b.dataset.status;
    state.selectedNum = null;
    render();
  }));

  const scf = $('scoreFilters');
  scf.innerHTML = SCORE_BUCKETS.map((b) => {
    const cnt = state.rows.filter(b.match).length;
    return `<button class="chip ${state.scoreFilter === b.key ? 'active' : ''}" data-score="${escape(b.key)}">${escape(b.label)}<span class="count">${cnt}</span></button>`;
  }).join('');
  scf.querySelectorAll('.chip').forEach((b) => b.addEventListener('click', () => {
    state.scoreFilter = b.dataset.score;
    state.selectedNum = null;
    render();
  }));

  document.querySelectorAll('[data-emailfilter]').forEach((b) => {
    b.classList.toggle('active', state.emailFilter === b.dataset.emailfilter);
    b.onclick = () => { state.emailFilter = b.dataset.emailfilter; render(); };
  });
}

function renderRowList() {
  const data = visibleRows();
  $('listCount').textContent = `${data.length} ${data.length === 1 ? 'offer' : 'offers'}`;
  if (state.selectedNum && !data.find((r) => r.num === state.selectedNum) && data.length) {
    state.selectedNum = data[0].num;
  } else if (!data.length) {
    state.selectedNum = null;
  }

  const list = $('rowList');
  if (!data.length) {
    list.innerHTML = '<div class="empty"><h2>No offers match</h2><div>Adjust filters or clear search.</div></div>';
    return;
  }
  list.innerHTML = data.map((r) => {
    const mailCount = emailsFor(r.company).length;
    return `
      <div class="list-row ${state.selectedNum === r.num ? 'active' : ''}" data-num="${r.num}" data-status="${escape(r.status)}">
        <div class="row-score ${scoreClass(r.score)}">${r.score.toFixed(1)}</div>
        <div class="row-mid">
          <div class="row-company">${escape(r.company)}</div>
          <div class="row-role">${escape(r.role)}</div>
          <div class="row-meta"><span>#${r.num}</span><span>${escape(r.date)}</span></div>
        </div>
        <div class="row-side">
          <span class="status-dot status-${escape(r.status)}">${escape(r.status)}</span>
          ${mailCount ? `<span class="row-mail">✉ ${mailCount}</span>` : ''}
        </div>
      </div>
    `;
  }).join('');
  list.querySelectorAll('.list-row').forEach((el) => el.addEventListener('click', () => {
    state.selectedNum = Number(el.dataset.num);
    renderRowList();
    renderDetail();
  }));
}

function renderDetail() {
  const detail = $('detail');
  const r = state.rows.find((x) => x.num === state.selectedNum);
  if (!r) {
    detail.innerHTML = '<div class="empty"><h2>Select an offer</h2><div>Pick a row on the left to see role details, notes, and inbox activity.</div></div>';
    return;
  }
  const emails = emailsFor(r.company);
  detail.innerHTML = `
    <div class="detail-head">
      <div style="flex:1; min-width:0;">
        <h2>${escape(r.company)}</h2>
        <div class="role">${escape(r.role)}</div>
        <div class="meta-line">
          <span>#${r.num}</span><span>·</span><span>${escape(r.date)}</span>
        </div>
        <div class="detail-tags">
          <span class="status-dot status-${escape(r.status)}">${escape(r.status)}</span>
          <span class="tag-soft">${r.pdf ? 'PDF ready' : 'No PDF'}</span>
          ${emails.length ? `<span class="tag-soft" style="color:var(--magenta)">✉ ${emails.length} email${emails.length > 1 ? 's' : ''}</span>` : ''}
        </div>
      </div>
      <div class="detail-score ${scoreClass(r.score)}">${r.score.toFixed(1)}</div>
    </div>

    <div class="action-row">
      ${r.reportPath ? `<button class="btn btn-primary" data-act="report">Open report</button>` : ''}
      <button class="btn" data-act="jd">Open posting</button>
      ${r.reportPath ? `<button class="btn" data-act="copy-report">Copy report path</button>` : ''}
    </div>

    <div class="section">
      <div class="section-head"><h3>Notes</h3></div>
      <div class="notes-text">${escape(r.notes) || '<span style="color:var(--fg-dim)">no notes</span>'}</div>
    </div>

    <div class="section">
      <div class="section-head">
        <h3>Inbox · ${emails.length}</h3>
      </div>
      ${emails.length ? `
        <div class="email-cards">
          ${emails.map((m) => `
            <a class="email-card" href="https://mail.google.com/mail/u/0/#all/${encodeURIComponent(m.threadId)}" target="_blank" rel="noopener">
              <div class="email-card-row1">
                <span class="email-card-subj">${escape(m.subject)}</span>
                <span class="email-card-when" title="${escape(m.date)}">${timeAgo(m.date)}</span>
              </div>
              <div class="email-card-row2">
                <span class="email-kind ${m.kind || 'other'}">${(m.kind || 'other').replace('-', ' ')}</span>
                <span>${escape(m.sender)}</span>
              </div>
              <div class="email-card-snippet">${escape(m.snippet)}</div>
            </a>
          `).join('')}
        </div>
      ` : `<div class="empty" style="margin:0;padding:30px 0">No emails matched for ${escape(r.company)} in the inbox cache.</div>`}
    </div>
  `;
  detail.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', async () => {
    if (b.dataset.act === 'report') openReport(r);
    else if (b.dataset.act === 'jd') openJD(r);
    else if (b.dataset.act === 'copy-report' && r.reportPath) {
      navigator.clipboard.writeText(r.reportPath);
    }
  }));
}

function renderInbox() {
  const all = allEmails();
  const intentCounts = { all: all.length };
  for (const m of all) intentCounts[m.intent] = (intentCounts[m.intent] || 0) + 1;

  // intent filter chips
  const filters = $('inboxIntentFilters');
  const chips = [{ key: 'all', label: 'All' }, ...INTENT_ORDER.filter((k) => intentCounts[k]).map((k) => ({ key: k, label: INTENT_LABELS[k] }))];
  filters.innerHTML = chips.map((c) => `
    <button class="chip ${state.inboxIntentFilter === c.key ? 'active' : ''}" data-intent-filter="${escape(c.key)}">
      ${escape(c.label)}<span class="count">${intentCounts[c.key] || 0}</span>
    </button>
  `).join('');
  filters.querySelectorAll('[data-intent-filter]').forEach((b) => b.addEventListener('click', () => {
    state.inboxIntentFilter = b.dataset.intentFilter;
    renderInbox();
  }));

  const data = visibleEmails();
  $('inboxSub').textContent = `${data.length} emails · cache: ${state.emailsFetchedAt ? timeAgo(state.emailsFetchedAt) : '—'}`;

  const mismatchEl = $('inboxMismatch');
  const mismatches = all.filter((m) => m.trackerMismatch);
  if (mismatches.length) {
    mismatchEl.hidden = false;
    mismatchEl.innerHTML = `
      <div><b>${mismatches.length}</b> applied confirmation${mismatches.length > 1 ? 's' : ''} but tracker still says Evaluated/other. <span style="color:var(--fg-dim)">Click "Confirm Applied" on the row.</span></div>
      <button class="act tiny" id="autoConfirmAll">Confirm all</button>
    `;
    document.getElementById('autoConfirmAll').onclick = async () => {
      for (const m of mismatches) {
        if (m.tracker) await postOverlay(m.tracker.num, 'Applied', `auto-confirmed from inbox: ${m.subject}`);
      }
      await loadAll();
    };
  } else {
    mismatchEl.hidden = true;
    mismatchEl.innerHTML = '';
  }

  // group by intent
  const groups = $('inboxGroups');
  if (!data.length) {
    groups.innerHTML = '<div class="empty"><h2>Nothing here</h2><div>Adjust intent filter or search.</div></div>';
    return;
  }
  const byIntent = new Map();
  for (const m of data) {
    if (!byIntent.has(m.intent)) byIntent.set(m.intent, []);
    byIntent.get(m.intent).push(m);
  }
  groups.innerHTML = INTENT_ORDER.filter((k) => byIntent.has(k)).map((intent) => {
    const items = byIntent.get(intent);
    return `
      <div class="inbox-group" data-intent="${escape(intent)}">
        <div class="inbox-group-head">
          <span class="accent-dot"></span>
          <span>${escape(INTENT_LABELS[intent])}</span>
          <span class="pill">${items.length}</span>
        </div>
        ${items.map((m) => emailRowHtml(m)).join('')}
      </div>
    `;
  }).join('');

  // expand/collapse
  groups.querySelectorAll('.email-row').forEach((row) => row.addEventListener('click', (e) => {
    if (e.target.closest('.email-actions') || e.target.closest('a') || e.target.closest('button')) return;
    const tid = row.dataset.thread;
    state.expandedThread = state.expandedThread === tid ? null : tid;
    renderInbox();
  }));

  // wire actions
  groups.querySelectorAll('[data-action="apply-status"]').forEach((b) => b.addEventListener('click', async (e) => {
    e.preventDefault(); e.stopPropagation();
    const num = Number(b.dataset.num);
    const target = b.dataset.target;
    const note = b.dataset.note || '';
    await postOverlay(num, target, note);
    await loadAll();
  }));
  groups.querySelectorAll('[data-action="reset-status"]').forEach((b) => b.addEventListener('click', async (e) => {
    e.preventDefault(); e.stopPropagation();
    const num = Number(b.dataset.num);
    await fetch('/api/overlay/reset', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ num }) });
    await loadAll();
  }));
}

function emailRowHtml(m) {
  const t = m.tracker;
  const tracker = t ? `
    <span class="email-row-tracker">
      <span class="num">#${t.num}</span> · ${escape(t.role)}
      <span class="badge status-${escape(t.status)}" style="color:inherit"><span class="status-dot status-${escape(t.status)}" style="font-size:10px;padding:0;border:none;background:transparent">${escape(t.status)}</span></span>
    </span>
  ` : `<span class="email-row-tracker" style="color:var(--fg-dim)">no tracker match</span>`;

  let actionBtn = '';
  if (m.action.target && t) {
    const isCurrentStatus = t.status === m.action.target;
    if (isCurrentStatus) {
      actionBtn = `<span class="act act-status-applied">${escape(t.status)} ✓</span>`;
    } else {
      actionBtn = `<button class="act ${m.action.tone}" data-action="apply-status" data-num="${t.num}" data-target="${escape(m.action.target)}" data-note="${escape('inbox: ' + m.subject)}">${escape(m.action.label)}</button>`;
    }
  }

  const isExpanded = state.expandedThread === m.threadId;
  const bodyHtml = isExpanded ? `
    <div class="email-body-wrap">
      <div class="email-body-meta">
        <span><b>From</b>${escape(m.sender)}</span>
        <span><b>Date</b>${escape(m.date)}</span>
        <span><b>Thread</b>${escape(m.threadId)}</span>
      </div>
      ${m.body
        ? `<div class="email-body">${escape(m.body)}</div>`
        : `<div class="email-body-empty">Full body not yet cached. Run the refresh job once to populate it: <code>launchctl kickstart -k gui/$(id -u)/com.career-ops.email-refresh</code></div>`}
    </div>
  ` : '';

  return `
    <div class="email-row ${m.trackerMismatch ? 'mismatch' : ''} ${isExpanded ? 'expanded' : ''}" data-thread="${escape(m.threadId)}">
      <div class="email-main">
        <div class="email-row-top">
          <span class="email-row-company">${escape(m.company)}</span>
          ${tracker}
          <span class="email-row-when" title="${escape(m.date)}">${timeAgo(m.date)}</span>
        </div>
        <div class="email-row-subj">${escape(m.subject)}</div>
        <div class="email-row-snippet">${escape(m.snippet)}</div>
        <div class="email-row-bottom">
          <span class="intent-pill intent-${escape(m.intent)}">${escape(INTENT_LABELS[m.intent] || m.intent)}</span>
          <span>${escape(m.sender)}</span>
          <span style="margin-left:auto;font-size:11px;color:var(--fg-dim)">${isExpanded ? 'click to collapse' : 'click to expand'}</span>
        </div>
      </div>
      <div class="email-actions">
        ${actionBtn}
        <a class="act tiny soft" href="https://mail.google.com/mail/u/0/#all/${encodeURIComponent(m.threadId)}" target="_blank" rel="noopener">Open in Gmail</a>
        ${t && t.status !== 'Evaluated' && state.rows.find((r) => r.num === t.num)?._overlay
          ? `<button class="act tiny soft" data-action="reset-status" data-num="${t.num}">Reset override</button>`
          : ''}
      </div>
      ${bodyHtml}
    </div>
  `;
}

async function postOverlay(num, status, note) {
  await fetch('/api/overlay', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ num, status, note, source: 'inbox-ui' }),
  });
}

function renderCompanies() {
  const map = new Map();
  for (const r of state.rows) {
    if (!map.has(r.company)) map.set(r.company, { name: r.company, count: 0, applied: 0, bestScore: 0, lastDate: '' });
    const m = map.get(r.company);
    m.count++;
    if (r.status === 'Applied') m.applied++;
    if (r.score > m.bestScore) m.bestScore = r.score;
    if (r.date > m.lastDate) m.lastDate = r.date;
  }
  for (const [k, v] of Object.entries(state.emailsByCompany)) {
    if (!map.has(k)) map.set(k, { name: k, count: 0, applied: 0, bestScore: 0, lastDate: '' });
  }
  const list = [...map.values()].sort((a, b) => b.bestScore - a.bestScore || b.count - a.count || a.name.localeCompare(b.name));
  $('companyGrid').innerHTML = list.map((c) => {
    const emails = emailsFor(c.name);
    return `
      <article class="company-card" data-company="${escape(c.name)}">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px">
          <h3>${escape(c.name)}</h3>
          ${c.bestScore ? `<div class="row-score ${scoreClass(c.bestScore)}" style="width:38px;height:38px;font-size:12px">${c.bestScore.toFixed(1)}</div>` : ''}
        </div>
        <div class="company-card-meta">
          <span><b>${c.count}</b>offers</span>
          ${c.applied ? `<span class="company-card-applied">${c.applied} applied</span>` : ''}
          ${emails.length ? `<span style="color:var(--magenta)"><b>✉</b>${emails.length}</span>` : ''}
        </div>
      </article>
    `;
  }).join('');
  $('companyGrid').querySelectorAll('.company-card').forEach((card) => card.addEventListener('click', () => {
    const company = card.dataset.company;
    state.search = company;
    $('search').value = company;
    state.view = 'pipeline';
    state.selectedNum = null;
    const match = state.rows.find((r) => r.company === company);
    if (match) state.selectedNum = match.num;
    render();
  }));
}

/* ACTIONS */

async function openReport(r) {
  if (!r || !r.reportPath) return;
  const md = await fetch(`/api/report?path=${encodeURIComponent(r.reportPath)}`).then((x) => x.text());
  $('reportTitle').textContent = `${r.company} — ${r.role}`;
  $('reportSub').textContent = `#${r.num} · ${r.date} · score ${r.score.toFixed(2)}/5 · ${r.status}`;
  $('reportBody').textContent = md;
  $('reportModal').hidden = false;
  $('reportModal')._url = (md.match(/\*\*URL:\*\*\s+(\S+)/) || [])[1] || null;
}

async function openJD(r) {
  if (!r || !r.reportPath) return;
  const md = await fetch(`/api/report?path=${encodeURIComponent(r.reportPath)}`).then((x) => x.text());
  const u = (md.match(/\*\*URL:\*\*\s+(\S+)/) || [])[1];
  if (u) window.open(u, '_blank');
}

$('closeReport').addEventListener('click', () => { $('reportModal').hidden = true; });
$('refreshBtn').addEventListener('click', () => loadAll());
$('search').addEventListener('input', (e) => {
  state.search = e.target.value.trim();
  if (state.view === 'pipeline') { renderRowList(); renderDetail(); }
  else if (state.view === 'inbox') renderInbox();
});
$('sortSelect').addEventListener('change', (e) => {
  state.sort = e.target.value;
  renderRowList();
});
document.querySelectorAll('.nav-item').forEach((b) => b.addEventListener('click', () => {
  state.view = b.dataset.view;
  render();
}));
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && document.activeElement.tagName !== 'INPUT') {
    $('search').focus();
    e.preventDefault();
  }
  if (e.key === 'Escape') $('reportModal').hidden = true;
  if (state.view === 'pipeline' && document.activeElement.tagName !== 'INPUT') {
    const data = visibleRows();
    const i = data.findIndex((r) => r.num === state.selectedNum);
    if (e.key === 'j' || e.key === 'ArrowDown') {
      if (i < data.length - 1) { state.selectedNum = data[i + 1].num; renderRowList(); renderDetail(); e.preventDefault(); }
    } else if (e.key === 'k' || e.key === 'ArrowUp') {
      if (i > 0) { state.selectedNum = data[i - 1].num; renderRowList(); renderDetail(); e.preventDefault(); }
    }
  }
});

loadAll();
