import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import handlers, { lookupContact } from '../src/handlers/lookup';

describe('contact-mirror', () => {
  it('resolves a fixture contact and misses cleanly', () => {
    expect(lookupContact({ contact_id: 'c_mirror_1' })).toMatchObject({ found: true, contact: { name: 'Mira Mirror', source: 'contact-mirror' } });
    expect(lookupContact({ contact_id: 'nope' })).toEqual({ found: false });
    expect(handlers.contact_mirror_lookup_contact({ contact_id: 'c_mirror_2' }).found).toBe(true);
  });

  it('tags its tool as an implementation of showcase/contact_lookup (decision 0077)', () => {
    const manifest = JSON.parse(readFileSync(join(__dirname, '..', 'sprigr-app.json'), 'utf8'));
    const tool = manifest.cross_tenant_tools[0];
    expect(tool.tool_name.startsWith('contact_mirror_')).toBe(true);
    expect(manifest.tools.some((t: { name: string }) => t.name === tool.tool_name)).toBe(true);
    expect(tool.provides).toEqual({ interface: 'showcase/contact_lookup', op: 'lookup_contact', version: '1.0.0' });
  });
});
