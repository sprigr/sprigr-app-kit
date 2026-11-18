import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Decision 58, proof test 2: the engine and its dialects name no app. Per-app
 * behaviour is data the app passes in. The names below are vendors and app
 * slugs from the first set; a new one belongs here when an app joins.
 */
const APP_NAMES = [
  'xero', 'shopify', 'quickbooks', 'myob', 'servicem8', 'simpro', 'procore', 'skusavvy', 'cin7',
  'klaviyo', 'gorgias', 'starshipit', 'asana', 'trello', 'dropbox', 'fastmail', 'atlassian', 'jira',
  'microsoft', 'outlook', 'google', 'gmail', 'meta-ads', 'facebook', 'imap', 'sprigrworks', 'sprigrbooks',
];

function namesIn(text: string): string[] {
  const lower = text.toLowerCase();
  return APP_NAMES.filter((n) => new RegExp(`(^|[^a-z0-9])${n.replace('-', '\\-')}([^a-z0-9]|$)`).test(lower));
}

const SRC = new URL('../src/', import.meta.url);

describe('no app is named in the engine or a dialect', () => {
  it('the scan finds a name in a fixture that has one', () => {
    expect(namesIn("const base = 'https://api.xero.com/';")).toEqual(['xero']);
    expect(namesIn('// Shopify GraphQL')).toEqual(['shopify']);
    expect(namesIn('const items = list(resource);')).toEqual([]);
  });

  it('every source file is free of app names', () => {
    const files = readdirSync(SRC).filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      expect({ file: f, names: namesIn(readFileSync(new URL(f, SRC), 'utf8')) }).toEqual({ file: f, names: [] });
    }
  });
});
