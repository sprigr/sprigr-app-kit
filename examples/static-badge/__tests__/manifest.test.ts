/**
 * static-badge smoke test: it has no handlers (static tier), so the only
 * thing to assert is that the manifest declares the static contract and the
 * served index.html exists. `sprigr app validate` is the real gate; this is
 * a fast local sanity check.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

describe('static-badge manifest', () => {
  const manifest = JSON.parse(readFileSync(path.join(dir, 'sprigr-app.json'), 'utf-8'));

  it('declares the static runtime tier + framework', () => {
    expect(manifest.runtime.tier).toBe('static');
    expect(manifest.runtime.framework).toBe('static');
  });

  it('has an empty tools array (nothing to dispatch)', () => {
    expect(manifest.tools).toEqual([]);
  });

  it('ships the entry file it declares', () => {
    expect(manifest.runtime.entry).toBe('public/index.html');
    expect(existsSync(path.join(dir, manifest.runtime.entry))).toBe(true);
  });
});
