// tests/scan-himalayas.test.mjs — unit tests for the Himalayas API scanner.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  himalayasJobToOffer,
  isUSEligible,
  processJobs,
} from '../scan-himalayas.mjs';
import {
  buildCompanyFilter,
  buildLocationFilter,
  buildTitleFilter,
} from '../scan-core.mjs';

const FIXTURE = JSON.parse(
  readFileSync(new URL('./fixtures/himalayas-sample.json', import.meta.url), 'utf-8')
);

test('fixture loads and has expected shape', () => {
  assert.ok(Array.isArray(FIXTURE.jobs), 'jobs is array');
  assert.ok(FIXTURE.jobs.length > 0, 'has rows');
  assert.equal(typeof FIXTURE.totalCount, 'number');
});

test('himalayasJobToOffer maps fields correctly', () => {
  const j = FIXTURE.jobs.find((x) => x.applicationLink && x.companyName && x.title);
  assert.ok(j, 'has at least one valid job in fixture');
  const o = himalayasJobToOffer(j);
  assert.ok(o);
  assert.equal(o.title, j.title.trim());
  assert.equal(o.company, j.companyName.trim());
  assert.equal(o.source, 'himalayas-api');
  assert.ok(o.url.startsWith('http'), 'url is http(s)');
});

test('himalayasJobToOffer rejects malformed rows', () => {
  assert.equal(himalayasJobToOffer(null), null);
  assert.equal(himalayasJobToOffer({}), null);
  assert.equal(himalayasJobToOffer({ title: 'x' }), null, 'missing company+url');
  assert.equal(
    himalayasJobToOffer({ title: 'x', companyName: 'y' }),
    null,
    'missing applicationLink'
  );
  assert.ok(
    himalayasJobToOffer({
      title: 'AI Engineer',
      companyName: 'Co',
      applicationLink: 'https://example.com/apply',
      locationRestrictions: ['United States'],
      seniority: ['Senior'],
    })
  );
});

test('himalayasJobToOffer joins multi-location into a single string', () => {
  const o = himalayasJobToOffer({
    title: 'AI Engineer',
    companyName: 'Co',
    applicationLink: 'https://example.com/apply',
    locationRestrictions: ['United States', 'Canada'],
    seniority: ['Senior'],
  });
  assert.equal(o.location, 'United States, Canada');
});

test('isUSEligible — locationRestrictions array containing United States', () => {
  assert.equal(isUSEligible({ locationRestrictions: ['United States'] }), true);
  assert.equal(
    isUSEligible({ locationRestrictions: ['United States', 'Canada'] }),
    true
  );
  assert.equal(isUSEligible({ locationRestrictions: ['USA'] }), true);
  assert.equal(isUSEligible({ locationRestrictions: ['Poland'] }), false);
  assert.equal(isUSEligible({ locationRestrictions: ['Germany', 'India'] }), false);
});

test('isUSEligible — empty restrictions: lenient by default, strict mode rejects', () => {
  assert.equal(isUSEligible({ locationRestrictions: [] }), true, 'empty ⇒ allow');
  assert.equal(
    isUSEligible({ locationRestrictions: [] }, true),
    false,
    'empty + strict ⇒ reject'
  );
  assert.equal(
    isUSEligible({}, true),
    false,
    'no field + strict ⇒ reject'
  );
});

test('processJobs filters end-to-end with realistic config', () => {
  const titleFilter = buildTitleFilter({
    positive: ['AI', 'ML', 'Engineer'],
    negative: ['Junior', 'Intern', 'Federal'],
  });
  const locationFilter = buildLocationFilter({
    positive: ['United States', 'USA', 'Remote'],
    negative: ['United Kingdom', 'India'],
  });
  const companyFilter = buildCompanyFilter({
    negative: ['Booz Allen'],
  });

  const fakeJobs = [
    {
      title: 'Senior AI Engineer',
      companyName: 'Acme',
      applicationLink: 'https://example.com/1',
      locationRestrictions: ['United States'],
      seniority: ['Senior'],
    },
    {
      title: 'Junior AI Engineer',
      companyName: 'Acme',
      applicationLink: 'https://example.com/2',
      locationRestrictions: ['United States'],
      seniority: ['Entry-level'],
    },
    {
      title: 'Senior AI Engineer',
      companyName: 'Acme',
      applicationLink: 'https://example.com/3',
      locationRestrictions: ['India'],
      seniority: ['Senior'],
    },
    {
      title: 'Senior AI Engineer',
      companyName: 'Booz Allen Hamilton',
      applicationLink: 'https://example.com/4',
      locationRestrictions: ['United States'],
      seniority: ['Senior'],
    },
    {
      title: 'Senior Software Engineer (US Federal Practice)',
      companyName: 'Acme',
      applicationLink: 'https://example.com/5',
      locationRestrictions: ['United States'],
      seniority: ['Senior'],
    },
  ];

  const result = processJobs(fakeJobs, {
    strict: true,
    titleFilter,
    locationFilter,
    companyFilter,
    seenUrls: new Set(),
    seenCompanyRoles: new Set(),
  });

  assert.equal(result.newOffers.length, 1, 'only the clean Acme/US row survives');
  assert.equal(result.newOffers[0].url, 'https://example.com/1');
  assert.equal(result.stats.title, 2, 'title-culled = Junior + Federal Practice');
  assert.equal(result.stats.nonUS, 1, '1 non-US (India)');
  assert.equal(result.stats.company, 1, '1 company-culled (Booz Allen)');
});

test('processJobs honors prior-seen URLs (refreshes, no double-add)', () => {
  const titleFilter = buildTitleFilter({ positive: ['Engineer'], negative: [] });
  const locationFilter = buildLocationFilter({
    positive: ['United States'],
    negative: [],
  });
  const companyFilter = buildCompanyFilter({});

  const fakeJobs = [
    {
      title: 'AI Engineer',
      companyName: 'Acme',
      applicationLink: 'https://example.com/1',
      locationRestrictions: ['United States'],
    },
  ];

  const seenUrls = new Set(['https://example.com/1']);
  const result = processJobs(fakeJobs, {
    strict: true,
    titleFilter,
    locationFilter,
    companyFilter,
    seenUrls,
    seenCompanyRoles: new Set(),
  });

  assert.equal(result.newOffers.length, 0);
  assert.equal(result.refreshedUrls.length, 1);
});

test('processJobs honors prior-seen (company, title) keys', () => {
  const titleFilter = buildTitleFilter({ positive: ['Engineer'], negative: [] });
  const locationFilter = buildLocationFilter({
    positive: ['United States'],
    negative: [],
  });
  const companyFilter = buildCompanyFilter({});

  const fakeJobs = [
    {
      title: 'AI Engineer',
      companyName: 'Acme',
      applicationLink: 'https://example.com/1',
      locationRestrictions: ['United States'],
    },
  ];

  const seenCompanyRoles = new Set(['acme::ai engineer']);
  const result = processJobs(fakeJobs, {
    strict: true,
    titleFilter,
    locationFilter,
    companyFilter,
    seenUrls: new Set(),
    seenCompanyRoles,
  });

  assert.equal(result.newOffers.length, 0);
  assert.equal(result.stats.dupes, 1);
});

test('end-to-end: real fixture filtered by realistic portals.yml-style config', () => {
  const titleFilter = buildTitleFilter({
    positive: ['AI Engineer', 'ML Engineer', 'Applied AI', 'Senior'],
    negative: ['Junior', 'Intern', 'New Grad'],
  });
  const locationFilter = buildLocationFilter({
    positive: ['United States', 'USA', 'Remote'],
    negative: ['United Kingdom', 'India', 'Poland', 'Germany'],
  });
  const companyFilter = buildCompanyFilter({});

  const result = processJobs(FIXTURE.jobs, {
    strict: true,
    titleFilter,
    locationFilter,
    companyFilter,
    seenUrls: new Set(),
    seenCompanyRoles: new Set(),
  });

  // From the fixture, expect ~3 US-based senior AI engineer roles to pass.
  assert.ok(
    result.newOffers.length >= 1 && result.newOffers.length <= 12,
    `expected 1–12 survivors from fixture, got ${result.newOffers.length}`
  );
  for (const o of result.newOffers) {
    assert.ok(o.title.length > 0);
    assert.ok(o.company.length > 0);
    assert.ok(o.url.startsWith('http'));
    assert.equal(o.source, 'himalayas-api');
  }
});
