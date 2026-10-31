/**
 * The shared dispatch-manifest builder (sprigr-app-kit#170).
 *
 * Seven sprigr-apps apps carried their own copy of
 * `scripts/gen-dispatch-manifest.ts`, so a change to the dispatch shape (such
 * as sprigr-apps#3701's `actionDescriptions`) landed in one of them. These
 * builders are the pure part every copy shared, ported from simpro 0.6.4
 * (sprigr-apps#3702) with its semantics and tests.
 */
import { describe, it, expect } from 'vitest';
import {
  ACTION_DESCRIPTION_MAX_CHARS,
  buildDispatchManifest,
  buildParamsDescription,
  oneLineDescription,
  type DispatchActionSpec,
} from '../src/index';

describe('oneLineDescription', () => {
  it("uses the action's summary when it declares one", () => {
    expect(oneLineDescription({ description: 'Long text. More.', summary: 'Short.' })).toBe('Short.');
  });

  it('otherwise takes the first sentence of the description', () => {
    expect(oneLineDescription({ description: 'Fetch a single job. Returns everything.' })).toBe('Fetch a single job.');
  });

  it('does not end a sentence at an abbreviation dot or inside an open bracket', () => {
    expect(oneLineDescription({ description: 'Use e.g. this one. Then more.' })).toBe('Use e.g. this one.');
    expect(oneLineDescription({ description: 'Add ONE cost centre (building a new quote? use another action). Then more.' }))
      .toBe('Add ONE cost centre (building a new quote? use another action).');
  });

  it('cuts a first sentence over the cap on a word boundary with a visible marker', () => {
    const line = oneLineDescription({ description: `${'word '.repeat(80)}end.` });
    expect(line.endsWith('...')).toBe(true);
    expect(line.length).toBeLessThanOrEqual(ACTION_DESCRIPTION_MAX_CHARS);
    expect(ACTION_DESCRIPTION_MAX_CHARS).toBe(160);
  });

  it('honours a smaller cap and collapses whitespace onto one line', () => {
    const line = oneLineDescription({ description: 'alpha beta\ngamma delta epsilon zeta eta theta.' }, 20);
    expect(line).not.toContain('\n');
    expect(line.length).toBeLessThanOrEqual(20);
    expect(line.endsWith('...')).toBe(true);
  });

  it('returns an empty string for an action with no text', () => {
    expect(oneLineDescription({})).toBe('');
    expect(oneLineDescription({ description: '   ' })).toBe('');
  });
});

/** A registry keyed by CALLABLE name: `list_cost_centres` is an alias of `list_cost_centers`. */
function registry(): ReadonlyMap<string, DispatchActionSpec> {
  const listCC: DispatchActionSpec = { name: 'list_cost_centers', description: 'List cost centres. Paged.', accepts: ['job_id', 'page'], required: ['job_id'] };
  return new Map<string, DispatchActionSpec>([
    ['get_job', { name: 'get_job', description: 'Fetch a single job. Returns everything.', accepts: ['job_id', 'id'] }],
    ['update_job', { name: 'update_job', description: 'Patch a job.' }],
    ['list_cost_centers', listCC],
    ['list_cost_centres', listCC],
    ['ping', { name: 'ping', description: '' }],
  ]);
}

describe('buildDispatchManifest', () => {
  it('lists every callable name, sorted, aliases included', () => {
    const d = buildDispatchManifest(registry());
    expect(d.actionField).toBe('action');
    expect(d.actions).toEqual(['get_job', 'list_cost_centers', 'list_cost_centres', 'ping', 'update_job']);
  });

  it('declares actionInputs only for actions with accepts, keyed by canonical name, required when non-empty', () => {
    const d = buildDispatchManifest(registry());
    expect(d.actionInputs).toEqual({
      get_job: { accepts: ['job_id', 'id'] },
      list_cost_centers: { accepts: ['job_id', 'page'], required: ['job_id'] },
    });
  });

  it('gives every callable name with text one line, and omits an action with none', () => {
    const d = buildDispatchManifest(registry());
    expect(d.actionDescriptions).toEqual({
      get_job: 'Fetch a single job.',
      list_cost_centers: 'List cost centres.',
      list_cost_centres: 'List cost centres.',
      update_job: 'Patch a job.',
    });
  });

  it('omits actionInputs when no action declares accepts, and actionDescriptions when asked', () => {
    const plain = new Map<string, DispatchActionSpec>([['a', { name: 'a', description: 'A.' }]]);
    expect(buildDispatchManifest(plain)).toEqual({ actionField: 'action', actions: ['a'], actionDescriptions: { a: 'A.' } });
    expect(buildDispatchManifest(plain, { descriptions: false })).toEqual({ actionField: 'action', actions: ['a'] });
    expect(buildDispatchManifest(plain, { actionField: 'op' }).actionField).toBe('op');
  });
});

describe('buildParamsDescription', () => {
  it('renders one `name: keys` line per contract, `*` marking a required key, after the intro', () => {
    const { actionInputs } = buildDispatchManifest(registry());
    const text = buildParamsDescription(actionInputs, 'Intro line.');
    expect(text).toBe(['Intro line.', '', 'get_job: job_id, id', 'list_cost_centers: job_id*, page'].join('\n'));
  });

  it('has a default intro naming the `input` envelope and list_actions', () => {
    const text = buildParamsDescription(undefined);
    expect(text).toContain('nested under `input`');
    expect(text).toContain('list_actions');
  });
});
