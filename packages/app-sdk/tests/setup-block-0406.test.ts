/**
 * The manifest `setup` block (sprigr-team decision 0406). The fixture file is
 * the same file sprigr-team's validator reads, so every case here gets the
 * platform's verdict and message.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateSetup } from '../src/index';

interface Fixtures {
  tools: Array<{ name: string; input_schema: Record<string, unknown> }>;
  cases: Array<{ name: string; kind?: string; setup?: unknown; expect: string | null }>;
}

const fixtures = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'setup-block-fixtures.json'), 'utf8')) as Fixtures;

describe('validateSetup', () => {
  for (const c of fixtures.cases) {
    it(c.name, () => {
      const manifest = { tools: fixtures.tools, kind: c.kind, ...('setup' in c ? { setup: c.setup } : {}) };
      expect(validateSetup(manifest)).toBe(c.expect);
    });
  }
});
