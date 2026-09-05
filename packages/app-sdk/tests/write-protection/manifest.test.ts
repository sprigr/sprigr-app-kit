import { describe, it, expect } from 'vitest';
import { applyConfirmationPolicies, manifestIsFresh, serializeManifest, buildConfirmationPolicy } from '../../src/index';
import type { AppToolEffectsDeclaration, ManifestLike, ManifestToolLike } from '../../src/write-protection/manifest';

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

// sprigr-app-kit#49 / platform decision 0057: `tools[].effects` is a typed,
// optional manifest field. The confirmation generator strips two other
// tool-level fields (`confirmation_required`, the app-declared `confirm`
// input), so the risk worth pinning is that a future strip takes `effects`
// with it and an app silently loses its write-tier declaration on the next
// `gen:confirmation` run.
describe('tools[].effects survives the confirmation generator', () => {
  function withEffects(): ManifestLike {
    return {
      tools: [
        {
          name: 'crm_sync_contacts',
          effects: 'write',
          confirmation_required: true,
          input_schema: { properties: { id: {}, confirm: { type: 'boolean' } }, required: ['id', 'confirm'] },
        },
        { name: 'widget_list', input_schema: { properties: { q: {} } } },
      ],
    };
  }

  it('keeps the declaration on a tool the generator rewrites', () => {
    const m = withEffects();
    applyConfirmationPolicies(m, { policies: { crm_sync_contacts: rule } });
    const tool = m.tools![0]!;
    expect(tool.effects).toBe('write');
    // The fields the generator IS meant to retire still go.
    expect(tool.confirmation_required).toBeUndefined();
    expect(tool.input_schema!.properties!.confirm).toBeUndefined();
  });

  it('keeps it on an untouched tool and through a serialize round-trip', () => {
    const m = withEffects();
    applyConfirmationPolicies(m, { policies: {} });
    expect(m.tools![0]!.effects).toBe('write');
    expect(m.tools![1]!.effects).toBeUndefined();
    const round = JSON.parse(serializeManifest(m)) as ManifestLike;
    expect(round.tools![0]!.effects).toBe('write');
  });

  it('is invisible to manifestIsFresh, so declaring it does not read as drift', () => {
    const m = withEffects();
    const opts = { policies: { crm_sync_contacts: rule } };
    applyConfirmationPolicies(m, opts);
    expect(manifestIsFresh(m, opts)).toBe(true);
  });

  it("accepts 'write' as the typed value on ManifestToolLike", () => {
    // The type is exported as one literal on purpose: 'read' is not honoured
    // by the platform and must not be expressible. Tests are not typechecked
    // in this package, so this asserts the runtime shape only; the compile
    // time guarantee is the `effects?: AppToolEffectsDeclaration` field
    // itself, which `pnpm -F @sprigr/apps-app-sdk typecheck` covers.
    const tool: ManifestToolLike = { name: 't', effects: 'write' };
    const declared: AppToolEffectsDeclaration = 'write';
    expect(tool.effects).toBe(declared);
  });
});
