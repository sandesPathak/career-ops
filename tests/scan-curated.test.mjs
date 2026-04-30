// tests/scan-curated.test.mjs — unit tests for the SimplifyJobs README parser.

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseSimplifyReadme } from '../scan-curated.mjs';

const SAMPLE_README = `
## Software Engineering New Grad Roles

<table>
<thead><tr><th>Company</th><th>Role</th><th>Location</th><th>Application</th><th>Age</th></tr></thead>
<tbody>
<tr>
<td><strong><a href="https://simplify.jobs/c/Anthropic">Anthropic</a></strong></td>
<td>AI Software Engineer 🇺🇸</td>
<td>San Francisco, CA</br>Remote, US</td>
<td><div align="center"><a href="https://job-boards.greenhouse.io/anthropic/jobs/123?utm_source=Simplify"><img src="apply.png" alt="Apply"></a> <a href="https://simplify.jobs/p/abc-uuid">simplify</a></div></td>
<td>0d</td>
</tr>
<tr>
<td><strong><a href="https://simplify.jobs/c/Acme">Acme Corp</a></strong></td>
<td>Software Engineer</td>
<td>Remote in UK</td>
<td><div align="center"><a href="https://example.com/apply">Apply</a></div></td>
<td>3d</td>
</tr>
<tr>
<td>↳</td>
<td>Senior Software Engineer</td>
<td>NYC</td>
<td><div align="center"><a href="https://example.com/apply2">Apply</a></div></td>
<td>5d</td>
</tr>
<tr>
<td><strong><a href="https://simplify.jobs/c/Closed">ClosedCo</a></strong></td>
<td>AI Engineer</td>
<td>NYC</td>
<td>🔒</td>
<td>2d</td>
</tr>
<tr>
<td><strong><a href="https://simplify.jobs/c/Old">OldCo</a></strong></td>
<td>AI Engineer</td>
<td>NYC</td>
<td><div align="center"><a href="https://example.com/old">Apply</a></div></td>
<td>3mo</td>
</tr>
</tbody>
</table>
`;

test('parser: extracts standard rows', () => {
  const rows = parseSimplifyReadme(SAMPLE_README);
  assert.equal(rows.length, 5, 'all 5 rows parsed');

  const a = rows[0];
  assert.equal(a.company, 'Anthropic');
  assert.equal(a.title, 'AI Software Engineer 🇺🇸');
  assert.equal(a.location, 'San Francisco, CA / Remote, US');
  assert.equal(a.applyUrl, 'https://job-boards.greenhouse.io/anthropic/jobs/123');
  assert.equal(a.ageDays, 0);
  assert.equal(a.usCitizenOnly, true, '🇺🇸 in title detected');
  assert.equal(a.closed, false);
});

test('parser: continuation rows inherit company from previous row', () => {
  const rows = parseSimplifyReadme(SAMPLE_README);
  const cont = rows.find((r) => r.title === 'Senior Software Engineer');
  assert.ok(cont, 'continuation row found');
  assert.equal(cont.company, 'Acme Corp', 'inherited from prior row');
  assert.equal(cont.ageDays, 5);
});

test('parser: closed listings flagged + apply URL nulled', () => {
  const rows = parseSimplifyReadme(SAMPLE_README);
  const closed = rows.find((r) => r.company === 'ClosedCo');
  assert.equal(closed.closed, true);
  assert.equal(closed.applyUrl, null);
});

test('parser: age strings (Nd / Nmo / Ny)', () => {
  const rows = parseSimplifyReadme(SAMPLE_README);
  const old = rows.find((r) => r.company === 'OldCo');
  assert.equal(old.ageDays, 90, '3mo → 90d');
});

test('parser: utm_source params stripped from apply URLs', () => {
  const rows = parseSimplifyReadme(SAMPLE_README);
  const a = rows[0];
  assert.ok(!a.applyUrl.includes('utm_source'), 'utm stripped');
  assert.ok(!a.applyUrl.includes('Simplify'), 'no simplify ref');
});

test('parser: simplify.jobs/p/ tracker URLs ignored as apply URL', () => {
  const rows = parseSimplifyReadme(SAMPLE_README);
  const a = rows[0];
  assert.ok(!a.applyUrl.includes('simplify.jobs/p/'), 'tracker not used');
  assert.ok(a.applyUrl.includes('greenhouse.io'), 'real ATS used');
});

test('parser: 🇺🇸 emoji detection on title', () => {
  const rows = parseSimplifyReadme(SAMPLE_README);
  const cit = rows.find((r) => r.usCitizenOnly);
  assert.ok(cit, 'one row should be flagged');
  assert.equal(cit.company, 'Anthropic');
});
