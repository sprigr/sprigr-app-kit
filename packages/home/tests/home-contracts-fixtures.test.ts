/**
 * Home Contracts fixtures (FINAL-APP-FEEDS 4.3 rule 11): each provider's file
 * must be in the upload, every case must be a valid request and a valid
 * answer with nothing the platform would drop, the states Home draws
 * differently must be covered, and display strings must already be clean.
 */

import { describe, it, expect } from 'vitest';
import { validateHomeFixtures, homeDisplayTextProblem, type HomeBlock } from '../src/index';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Read with fs, not a JSON import: the composite tsconfig would need every .json listed. */
function load(name: string): unknown {
  return JSON.parse(readFileSync(join(__dirname, 'fixtures', 'home-contracts', name), 'utf8')) as unknown;
}
const simproManifest = load('simpro.manifest.json') as { home: unknown };
const xeroManifest = load('xero-accounting.manifest.json') as { home: unknown };
const simproMyDay = load('simpro-my-day.fixtures.json');
const simproCrewDay = load('simpro-crew-day.fixtures.json');
const simproEnquiries = load('simpro-new-enquiries.fixtures.json');
const xeroMoney = load('xero-money.fixtures.json');
const xeroFacts = load('xero-overdue-facts.fixtures.json');
const xeroAlerts = load('xero-alerts.fixtures.json');

type Case = { name: string; request: Record<string, unknown>; vendor?: unknown; expect: Record<string, unknown> & { records: Array<Record<string, unknown>> } };

const SIMPRO_FILES: Record<string, unknown> = {
  'home/fixtures/my_day.json': simproMyDay,
  'home/fixtures/crew_day.json': simproCrewDay,
  'home/fixtures/new_enquiries.json': simproEnquiries,
};
const XERO_FILES: Record<string, unknown> = {
  'home/fixtures/money.json': xeroMoney,
  'home/fixtures/overdue_facts.json': xeroFacts,
  'home/fixtures/alerts.json': xeroAlerts,
};

function reader(files: Record<string, unknown>): (path: string) => string | undefined {
  return (path) => (path in files ? JSON.stringify(files[path]) : undefined);
}

const simproBlock = simproManifest.home as unknown as HomeBlock;
const xeroBlock = xeroManifest.home as unknown as HomeBlock;

/** Xero's money fixtures with `edit` applied to a copy, checked against the Xero block. */
function moneyVerdict(edit: (cases: Case[]) => void): string | null {
  const cases = JSON.parse(JSON.stringify(xeroMoney)) as Case[];
  edit(cases);
  return validateHomeFixtures(xeroBlock, reader({ ...XERO_FILES, 'home/fixtures/money.json': cases }));
}

describe('the example fixtures validate', () => {
  it('Simpro: my_day (with unmapped), crew_day, new_enquiries', () => {
    expect(validateHomeFixtures(simproBlock, reader(SIMPRO_FILES))).toBeNull();
  });

  it('Xero: money, overdue_facts, alerts', () => {
    expect(validateHomeFixtures(xeroBlock, reader(XERO_FILES))).toBeNull();
  });
});

describe('fixture refusals', () => {
  it('a file missing from the upload, or not JSON', () => {
    expect(validateHomeFixtures(xeroBlock, reader({}))).toBe('home.provides[0].fixtures "home/fixtures/money.json" is not in the upload');
    expect(validateHomeFixtures(xeroBlock, () => '{not json')).toBe('home.provides[0].fixtures "home/fixtures/money.json" is not valid JSON');
    expect(validateHomeFixtures(xeroBlock, () => '{}')).toMatch(/must be a non-empty JSON array/);
  });

  it('every state Home draws differently must be covered, unmapped too when a person is required', () => {
    expect(moneyVerdict((c) => c.splice(2, 1))).toBe(
      'home.provides[0].fixtures "home/fixtures/money.json" has no "not_connected" case; fixtures must cover ok, empty, not_connected',
    );
    const noUnmapped = (simproMyDay as unknown as Case[]).filter((c) => c.expect.state !== 'unmapped');
    expect(validateHomeFixtures(simproBlock, reader({ ...SIMPRO_FILES, 'home/fixtures/my_day.json': noUnmapped }))).toMatch(/has no "unmapped" case/);
  });

  it('the request must be for this provider, contract and scope', () => {
    expect(moneyVerdict((c) => { c[0]!.request.provider = 'alerts'; })).toMatch(/case "a normal day": request.provider must be "money"/);
    expect(moneyVerdict((c) => { c[0]!.request.scope = 'me'; })).toMatch(/request.scope must be company/);
    expect(moneyVerdict((c) => { c[0]!.request.contract = 'sprigr/home_queue'; })).toMatch(/request.contract must be sprigr\/home_metrics/);
    expect(moneyVerdict((c) => { c[0]!.request.viewer_email = 'a@b.example'; })).toMatch(/unknown key "viewer_email"/);
  });

  it('the answer must echo the basis and carry no record the platform would drop', () => {
    expect(moneyVerdict((c) => { c[0]!.expect.basis = { day: '2026-10-06', tz: 'UTC' }; })).toMatch(/expect.basis must echo the request/);
    expect(moneyVerdict((c) => { c[0]!.expect.records[0]!.metric = 'sales.day'; })).toBe(
      'home.provides[0].fixtures "home/fixtures/money.json" case "a normal day": expect.records[0] would be dropped by the platform: record.metric "sales.day" is not in this provider\'s declared metrics',
    );
  });

  it('a ref.link must name a declared link', () => {
    const facts = JSON.parse(JSON.stringify(xeroFacts)) as Case[];
    (facts[0]!.expect.records[0]!.ref as Record<string, unknown>).link = 'bill';
    expect(validateHomeFixtures(xeroBlock, reader({ ...XERO_FILES, 'home/fixtures/overdue_facts.json': facts }))).toMatch(
      /record.ref.link "bill" is not a home.links\[\].id this app declares/,
    );
  });

  it('display strings must already be clean: no URL, markup, emoji or "!"', () => {
    const alerts = (title: string) => {
      const cases = JSON.parse(JSON.stringify(xeroAlerts)) as Case[];
      cases[0]!.expect.records[0]!.title = title;
      return validateHomeFixtures(xeroBlock, reader({ ...XERO_FILES, 'home/fixtures/alerts.json': cases }));
    };
    expect(alerts('Reconnect at https://evil.example')).toMatch(/expect.records\[0\].title must not contain a URL/);
    expect(alerts('Reconnect at www.evil.example')).toMatch(/must not contain a URL/);
    expect(alerts('Reconnect <script>x</script>')).toMatch(/must not contain markup/);
    expect(alerts('Reconnect now \u{1F525}')).toMatch(/must not contain emoji/);
    expect(alerts('Reconnect now!')).toMatch(/must not contain "!"/);
    expect(alerts('Xero connection expires in 5 days')).toBeNull();
  });

  it('case names are unique and cases are closed', () => {
    expect(moneyVerdict((c) => { c[1]!.name = c[0]!.name; })).toMatch(/case "a normal day" is named twice/);
    expect(moneyVerdict((c) => { (c[0] as unknown as Record<string, unknown>).notes = 'x'; })).toMatch(/case 0 has unknown key "notes"/);
  });
});

describe('homeDisplayTextProblem', () => {
  it('leaves ordinary copy alone', () => {
    expect(homeDisplayTextProblem('Overdue in Xero, INV-0042, $640')).toBeNull();
    expect(homeDisplayTextProblem('a < b and 3 > 2')).toBeNull();
  });
});
