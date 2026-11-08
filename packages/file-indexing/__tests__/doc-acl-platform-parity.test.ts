/**
 * Grammar parity with the platform (the parity test sprigr-team decision 0151
 * names). fixtures/doc-acl-grammar-fixture.json is GENERATED from
 * sprigr-team packages/shared/src/utils/doc-acl.ts (the grammar the import
 * endpoint and the read-time filter enforce) by fixtures/gen-platform-grammar.mts;
 * every input must produce the same output here. A drift on either side fails
 * this test, and regenerating the fixture against a newer platform shows the
 * change in review.
 */
import { describe, expect, it, vi } from 'vitest';
import fixture from './fixtures/doc-acl-grammar-fixture.json';
import {
  ACL_PRINCIPALS_ATTR,
  PUBLIC_PRINCIPAL,
  groupPrincipal,
  isValidPrincipal,
  keepValidPrincipals,
  normalizePrincipal,
  orgPrincipal,
  stampedPrincipalsValid,
  userPrincipal,
} from '../src/doc-acl';

const decode = (v: unknown) => (v === '__undefined__' ? undefined : v);

describe('doc-acl grammar parity with the platform', () => {
  it('has the platform constants', () => {
    expect(PUBLIC_PRINCIPAL).toBe(fixture.constants.PUBLIC_PRINCIPAL);
    expect(ACL_PRINCIPALS_ATTR).toBe(fixture.constants.ACL_PRINCIPALS_ATTR);
  });
  it.each(fixture.isValidPrincipal as Array<[unknown, boolean]>)('isValidPrincipal(%j) === %s', (input, expected) => {
    expect(isValidPrincipal(decode(input))).toBe(expected);
  });
  it.each(fixture.normalizePrincipal as Array<[string, string]>)('normalizePrincipal(%j) === %j', (input, expected) => {
    expect(normalizePrincipal(input)).toBe(expected);
  });
  it.each(fixture.userPrincipal as Array<[string, string]>)('userPrincipal(%j) === %j', (input, expected) => {
    expect(userPrincipal(input)).toBe(expected);
  });
  it.each(fixture.groupPrincipal as Array<[string, string]>)('groupPrincipal(%j) === %j', (input, expected) => {
    expect(groupPrincipal(input)).toBe(expected);
  });
  it.each(fixture.orgPrincipal as Array<[string, string]>)('orgPrincipal(%j) === %j', (input, expected) => {
    expect(orgPrincipal(input)).toBe(expected);
  });
  it('pins the rules the fixture exists for', () => {
    expect(userPrincipal('Alice@Corp.COM')).toBe('user:alice@corp.com');
    expect(groupPrincipal(' Sales-ID ')).toBe('group:Sales-ID');
    expect(orgPrincipal(' Tenant ')).toBe('org:Tenant');
    expect(isValidPrincipal('user:a b@x.com')).toBe(false);
    expect(isValidPrincipal('public')).toBe(true);
  });
  // sprigr-search#599 row 58: the engine trims U+0085 as whitespace and JS does
  // not, so `user:a@x.com\u0085` would be read as `user:a@x.com`.
  it('refuses a principal carrying U+0085, which the engine trims and JS does not', () => {
    expect(isValidPrincipal('user:a@x.com\u0085')).toBe(false);
    expect(isValidPrincipal('\u0085public')).toBe(false);
    expect(stampedPrincipalsValid(['user:a@x.com', 'group:g1\u0085'])).toBe(false);
  });
  it('keepValidPrincipals drops bad principals and warns once without the values', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(keepValidPrincipals(['user:a@x.com', 'user:b@x.com\u0085', 'nope'], 'drive-acl')).toEqual(['user:a@x.com']);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toBe('[drive-acl] dropped 2 invalid principal(s); kept 1');
      expect(keepValidPrincipals(['group:g1'], 'drive-acl')).toEqual(['group:g1']);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
  it('stampedPrincipalsValid rejects an empty list and any bad entry', () => {
    expect(stampedPrincipalsValid([])).toBe(false);
    expect(stampedPrincipalsValid(['user:a@x.com', 'nope'])).toBe(false);
    expect(stampedPrincipalsValid(['user:a@x.com', 'group:g'])).toBe(true);
  });
});
