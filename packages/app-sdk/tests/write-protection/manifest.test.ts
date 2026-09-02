import { describe, it, expect } from 'vitest';
import { applyConfirmationPolicies, manifestIsFresh, serializeManifest, buildConfirmationPolicy } from '../../src/index';
import type { ManifestLike } from '../../src/write-protection/manifest';

function manifest(): ManifestLike {
  return {
    tools: [
      { name: 'widget_delete', confirmation_required: true, input_schema: { properties: { id: {}, confirm: { type: 'boolean' } }, required: ['id', 'confirm'] } },
      { name: 'widget_list', input_schema: { properties: { q: {} } } },
      { name: 'widgets', input_schema: { properties: { action: {}, input: {} }, required: ['action'] } },
    ],
  };
}

const rule = buildConfirmationPolicy({ irreversible: { widget_delete: 'Delete widget {id}' } }).actions!.widget_delete!;
const dispatcher = buildConfirmationPolicy({ always: { purge: 'Purge every widget' } });

describe('applyConfirmationPolicies', () => {
  it('writes each policy, strips the legacy flag and the app-declared confirm input everywhere', () => {
    const m = manifest();
    const touched = applyConfirmationPolicies(m, { policies: { widget_delete: rule, widgets: dispatcher } });
    expect(touched.sort()).toEqual(['widget_delete', 'widgets']);
    const del = m.tools![0]!;
    expect(del.confirmation).toEqual(rule);
    expect(del.confirmation_required).toBeUndefined();
    expect(del.input_schema!.properties!.confirm).toBeUndefined();
    expect(del.input_schema!.required).toEqual(['id']);
    expect(m.tools![2]!.confirmation).toEqual(dispatcher);
    expect(m.tools![1]!.confirmation).toBeUndefined();
  });

  it('drops an emptied required list rather than leaving []', () => {
    const m: ManifestLike = { tools: [{ name: 't', input_schema: { properties: { confirm: {} }, required: ['confirm'] } }] };
    applyConfirmationPolicies(m, { policies: {} });
    expect(m.tools![0]!.input_schema!.required).toBeUndefined();
  });

  it('writes a dispatch block alongside and counts the tool once', () => {
    const m = manifest();
    const touched = applyConfirmationPolicies(m, {
      policies: { widgets: dispatcher },
      dispatch: { widgets: { actionField: 'action', actions: ['list', 'purge'] } },
    });
    expect(touched).toEqual(['widgets']);
    expect(m.tools![2]!.dispatch).toEqual({ actionField: 'action', actions: ['list', 'purge'] });
  });

  it('throws on a tool the manifest does not have, so a rename cannot drop a gate silently', () => {
    expect(() => applyConfirmationPolicies(manifest(), { policies: { widget_destroy: rule } })).toThrow(/no tool named 'widget_destroy'/);
    expect(() => applyConfirmationPolicies(manifest(), { policies: {}, dispatch: { nope: { actionField: 'action', actions: [] } } })).toThrow(/nope/);
  });

  it('can be told to keep the legacy flag and the confirm param', () => {
    const m = manifest();
    applyConfirmationPolicies(m, { policies: {}, stripLegacyFlag: false, dropConfirmParam: false });
    expect(m.tools![0]!.confirmation_required).toBe(true);
    expect(m.tools![0]!.input_schema!.properties!.confirm).toBeDefined();
  });
});

describe('manifestIsFresh', () => {
  it('is false before generation and true after, without mutating the input', () => {
    const m = manifest();
    const opts = { policies: { widget_delete: rule } };
    expect(manifestIsFresh(m, opts)).toBe(false);
    expect(m.tools![0]!.confirmation).toBeUndefined();
    applyConfirmationPolicies(m, opts);
    expect(manifestIsFresh(m, opts)).toBe(true);
  });
});

describe('serializeManifest', () => {
  it('matches the committed formatting: two-space indent and a trailing newline', () => {
    expect(serializeManifest({ a: 1 })).toBe('{\n  "a": 1\n}\n');
  });
});
