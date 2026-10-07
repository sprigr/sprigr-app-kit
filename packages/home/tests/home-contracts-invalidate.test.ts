/**
 * `home.invalidate`'s wire contract (decision 0178): identity only. The route
 * (workers/provisioning/src/wfp-home-invalidate.ts) refuses with
 * `homeInvalidateBodyProblems`, and an SDK maps its input with
 * `homeInvalidateBodyFor`, so both refuse the same things.
 */
import { describe, expect, it } from 'vitest';
import {
  HOME_INVALIDATE_BODY_KEYS,
  HOME_INVALIDATE_PATH,
  homeInvalidateBodyFor,
  homeInvalidateBodyProblems,
} from '../src/index';

describe('homeInvalidateBodyProblems', () => {
  it('accepts a provider, with or without an owner', () => {
    expect(homeInvalidateBodyProblems({ provider: 'my_day' })).toEqual([]);
    expect(homeInvalidateBodyProblems({ provider: 'money', owner_platform_user_id: 'usr_tom' })).toEqual([]);
    expect(HOME_INVALIDATE_BODY_KEYS).toEqual(['provider', 'owner_platform_user_id']);
    expect(HOME_INVALIDATE_PATH).toBe('/internal/wfp/home/invalidate');
  });

  it.each([
    ['records', { provider: 'board', records: [{ id: 'b1' }] }, '"records" is not accepted'],
    ['a result', { provider: 'board', result: { state: 'ok' } }, '"result" is not accepted'],
    ['an install id', { provider: 'board', install_id: 'inst_other' }, '"install_id" is not accepted'],
    ['a company id', { provider: 'board', company_id: 'comp_other' }, '"company_id" is not accepted'],
    ['a camelCase owner', { provider: 'board', owner: { platformUserId: 'usr_tom' } }, '"owner" is not accepted'],
  ])('refuses a body carrying %s', (_label, body, problem) => {
    expect(homeInvalidateBodyProblems(body).join('; ')).toContain(problem);
  });

  it.each([
    ['no provider', {}],
    ['a provider that is not an id', { provider: 'My Day' }],
    ['an empty owner', { provider: 'money', owner_platform_user_id: '' }],
    ['an overlong owner', { provider: 'money', owner_platform_user_id: 'u'.repeat(129) }],
    ['an array', ['my_day']],
    ['a string', 'my_day'],
  ])('refuses %s', (_label, body) => {
    expect(homeInvalidateBodyProblems(body).length).toBeGreaterThan(0);
  });
});

describe('homeInvalidateBodyFor', () => {
  it('maps the SDK input to the snake_case wire body', () => {
    expect(homeInvalidateBodyFor({ provider: 'my_day' })).toEqual({ provider: 'my_day' });
    expect(homeInvalidateBodyFor({ provider: 'money', owner: { platformUserId: 'usr_tom' } })).toEqual({
      provider: 'money',
      owner_platform_user_id: 'usr_tom',
    });
  });

  it('throws on what the route would refuse, before anything is sent', () => {
    expect(() => homeInvalidateBodyFor({ provider: 'my_day', records: [] } as never)).toThrow(/"records" is not accepted/);
    expect(() => homeInvalidateBodyFor({ provider: 'money', owner: 'usr_tom' } as never)).toThrow(/owner must be/);
    expect(() => homeInvalidateBodyFor({ provider: 'My Day' })).toThrow(/provider/);
  });
});
