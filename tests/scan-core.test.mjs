// tests/scan-core.test.mjs — unit tests for the scanner filter primitives.
//
// Run with: node --test tests/scan-core.test.mjs
//   or: npm test
//
// Uses Node's built-in node:test runner — no external test framework needed.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCompanyFilter,
  buildLocationFilter,
  buildTitleFilter,
} from '../scan-core.mjs';

// ── Title filter ────────────────────────────────────────────────────

test('title filter: word-boundary match avoids substring false positives', () => {
  const f = buildTitleFilter({ positive: ['AI'], negative: [] });
  assert.equal(f('AI Engineer'), true, 'standalone AI passes');
  assert.equal(f('AI/ML Engineer'), true, 'AI before slash passes');
  assert.equal(f('Engineer (AI)'), true, 'AI in parens passes');
  // The classic substring bug — "ai" inside "chain" must not match.
  assert.equal(f('Supply Chain Co-Op'), false, 'AI inside "chain" must not match');
  assert.equal(f('Captain of Industry'), false, 'AI inside "captain" must not match');
});

test('title filter: positive list with multiple keywords', () => {
  const f = buildTitleFilter({
    positive: ['AI Engineer', 'ML Engineer', 'Forward Deployed'],
    negative: [],
  });
  assert.equal(f('Senior AI Engineer'), true);
  assert.equal(f('Staff ML Engineer, Platform'), true);
  assert.equal(f('Forward Deployed Engineer'), true);
  assert.equal(f('Salesforce Admin'), false, 'no positive match → fail');
});

test('title filter: negative trumps positive', () => {
  const f = buildTitleFilter({
    positive: ['AI', 'Engineer'],
    negative: ['Junior', 'Mobile', 'Federal'],
  });
  assert.equal(f('Senior AI Engineer'), true);
  assert.equal(f('Junior AI Engineer'), false, 'Junior negative kicks in');
  assert.equal(f('Mobile iOS Engineer'), false);
  assert.equal(f('AI Engineer (US Federal Practice)'), false);
});

test('title filter: empty positive list defaults to true (open match)', () => {
  const f = buildTitleFilter({ positive: [], negative: ['Junior'] });
  assert.equal(f('Software Engineer'), true);
  assert.equal(f('Junior Software Engineer'), false);
});

test('title filter: empty negative list', () => {
  const f = buildTitleFilter({ positive: ['Engineer'], negative: [] });
  assert.equal(f('AI Engineer'), true);
  assert.equal(f('Designer'), false);
});

test('title filter: handles empty/null inputs gracefully', () => {
  const f = buildTitleFilter({ positive: ['AI'], negative: ['Junior'] });
  assert.equal(f(''), false, 'empty string → no positive match');
  assert.equal(f(null), false, 'null → no positive match');
  assert.equal(f(undefined), false, 'undefined → no positive match');
});

test('title filter: case insensitive', () => {
  const f = buildTitleFilter({ positive: ['AI'], negative: ['Junior'] });
  assert.equal(f('ai engineer'), true);
  assert.equal(f('JUNIOR AI ENGINEER'), false);
});

// ── Location filter ─────────────────────────────────────────────────

test('location filter: substring match (locations are long phrases)', () => {
  const f = buildLocationFilter({
    positive: ['United States', 'Remote', 'Oregon'],
    negative: ['United Kingdom', 'India', 'Remote in UK'],
  });
  assert.equal(f('United States'), true);
  assert.equal(f('Portland, Oregon'), true);
  assert.equal(f('Remote, US'), true);
  assert.equal(f('London, United Kingdom'), false);
  assert.equal(f('Bangalore, India'), false);
  assert.equal(f('Remote in UK'), false);
});

test('location filter: empty location passes (treated as remote/unknown)', () => {
  const f = buildLocationFilter({
    positive: ['United States'],
    negative: ['United Kingdom'],
  });
  assert.equal(f(''), true);
  assert.equal(f(null), true);
});

test('location filter: empty positive list = open match (negative still fires)', () => {
  const f = buildLocationFilter({
    positive: [],
    negative: ['United Kingdom'],
  });
  assert.equal(f('Anywhere'), true);
  assert.equal(f('London, United Kingdom'), false);
});

// ── Company filter ──────────────────────────────────────────────────

test('company filter: word-boundary match', () => {
  const f = buildCompanyFilter({
    negative: ['Booz Allen Hamilton', 'Lockheed Martin', 'CACI'],
  });
  assert.equal(f('Booz Allen Hamilton'), false, 'exact match fails');
  assert.equal(f('Booz Allen Hamilton Inc.'), false, 'with suffix fails');
  assert.equal(f('Lockheed Martin Aeronautics'), false);
  assert.equal(f('CACI International'), false);
  // Word-boundary protects against substring false positives.
  // "CACI" must not match "Pacific"... wait, "pacific" doesn't contain "caci".
  // Better test: ensure "Boozer" isn't matched by "Booz".
  assert.equal(f('Boozer Inc'), true, '"Booz" prefix only must not match "Boozer"');
});

test('company filter: empty / undefined company always passes', () => {
  const f = buildCompanyFilter({ negative: ['Booz Allen'] });
  assert.equal(f(''), true);
  assert.equal(f(undefined), true);
});

test('company filter: no negatives = always pass', () => {
  const f = buildCompanyFilter({});
  assert.equal(f('Random Inc'), true);
  assert.equal(f('Booz Allen Hamilton'), true);
});

// ── Realistic-config sanity test ────────────────────────────────────

test('realistic title-filter config from portals.yml mirrors expected behavior', () => {
  const f = buildTitleFilter({
    positive: ['AI', 'ML', 'LLM', 'Engineer', 'Forward Deployed', 'Applied AI'],
    negative: [
      'Junior', 'Intern', 'Mobile', 'Federal', 'Cleared', 'DoD',
      'Product Manager', 'Program Manager', 'Co-Op', 'New Grad',
      'Engineer 1', 'Engineer I', 'Engineer II',
    ],
  });

  // Should pass:
  assert.equal(f('AI Engineer'), true);
  assert.equal(f('Senior AI Engineer'), true);
  assert.equal(f('Sr. Applied AI Engineer'), true);
  assert.equal(f('Forward Deployed Engineer'), true);
  assert.equal(f('AI/ML Engineer'), true);
  assert.equal(f('Director of AI Engineering'), true, 'Director allowed');

  // Should fail:
  assert.equal(f('Junior AI Engineer'), false);
  assert.equal(f('Senior Product Manager, AI Agents'), false);
  assert.equal(f('Principal Technical Program Manager - Agentic AI'), false);
  assert.equal(f('Software Engineer (US Federal Practice)'), false);
  assert.equal(f('Software Engineer - DoD'), false);
  assert.equal(f('ML Engineer (TS/SCI Cleared required)'), false);
  assert.equal(f('Supply Chain Co-Op-Summer 2026'), false);
  assert.equal(f('Software Engineer 1'), false);
  assert.equal(f('Software Engineer I'), false);
  assert.equal(f('Software Engineer - New Grad'), false);
  assert.equal(f('Mobile iOS Engineer'), false);
});
