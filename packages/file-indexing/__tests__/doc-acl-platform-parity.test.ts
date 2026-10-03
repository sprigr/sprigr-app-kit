/**
 * Grammar parity with the platform (the parity test sprigr-team decision 0151
 * names). fixtures/doc-acl-grammar-fixture.json is GENERATED from
 * sprigr-team packages/shared/src/utils/doc-acl.ts (the grammar the import
 * endpoint and the read-time filter enforce) by fixtures/gen-platform-grammar.mts;
 * every input must produce the same output here. A drift on either side fails
 * this test, and regenerating the fixture against a newer platform shows the
 * change in review.
 */
import { describe, expect, it } from 'vitest';
import fixture from './fixtures/doc-acl-grammar-fixture.json';
import {
  ACL_PRINCIPALS_ATTR,
  PUBLIC_PRINCIPAL,
  groupPrincipal,
  isValidPrincipal,
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
  it('stampedPrincipalsValid rejects an empty list and any bad entry', () => {
    expect(stampedPrincipalsValid([])).toBe(false);
    expect(stampedPrincipalsValid(['user:a@x.com', 'nope'])).toBe(false);
    expect(stampedPrincipalsValid(['user:a@x.com', 'group:g'])).toBe(true);
  });
});
