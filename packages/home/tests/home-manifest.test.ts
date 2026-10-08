/**
 * The manifest `home` block validator, as an app calls it: on the two
 * example manifests the platform's own tests use, plus the refusals an app
 * author is most likely to hit.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homeBlockFromManifest, homeToolNameFor, validateHome } from '../src/index';

type Json = Record<string, any>;
const load = (name: string): Json => JSON.parse(readFileSync(join(__dirname, 'fixtures', 'home-contracts', name), 'utf8')) as Json;
const deps = { isReadShapedDispatch: (name: string, effects?: 'write' | null) => effects !== 'write' && /^(get|list|search)_/.test(name) };

describe('validateHome', () => {
  for (const name of ['simpro.manifest.json', 'xero-accounting.manifest.json']) {
    it(`accepts ${name}`, () => {
      expect(validateHome(load(name) as never, deps)).toBeNull();
      expect(homeBlockFromManifest(load(name), deps)?.tool).toBe(load(name).home.tool);
    });
  }

  it('pins the tool name to get_<slug>_home, so it matches the read classifier for every slug', () => {
    expect(homeToolNameFor('xero-accounting')).toBe('get_xero_accounting_home');
    const m = load('xero-accounting.manifest.json');
    m.home.tool = 'xero_home';
    expect(validateHome(m as never, deps)).toMatch(/get_xero_accounting_home/);
  });

  it('refuses an unknown key rather than ignoring it', () => {
    const m = load('xero-accounting.manifest.json');
    m.home.colour = 'green';
    expect(validateHome(m as never, deps)).toMatch(/colour/);
  });

  it('refuses a Home tool that is not internal', () => {
    const m = load('xero-accounting.manifest.json');
    for (const t of m.tools) if (t.name === m.home.tool) delete t.internal;
    expect(validateHome(m as never, deps)).toMatch(/internal/);
  });

  it('a manifest without a home block is fine', () => {
    const m = load('xero-accounting.manifest.json');
    delete m.home;
    expect(validateHome(m as never, deps)).toBeNull();
  });
});
