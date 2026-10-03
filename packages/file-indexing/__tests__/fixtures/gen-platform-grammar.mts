// Regenerates doc-acl-grammar-fixture.json from the PLATFORM grammar, the source of
// truth this package must match byte for byte. Run from a sprigr-team checkout:
//   node --experimental-strip-types gen-platform-grammar.mts \
//     /path/to/sprigr-team/packages/shared/src/utils/doc-acl.ts > doc-acl-grammar-fixture.json
// The committed fixture was generated from sprigr-team 30e18e6fe (2026-10-02).
import { pathToFileURL } from 'node:url';
const src = process.argv[2];
if (!src) throw new Error('usage: gen-platform-grammar.mts <path to sprigr-team doc-acl.ts>');
const p = await import(pathToFileURL(src).href);
const valid: unknown[] = [
  'public', ' public ', 'PUBLIC', 'user:alice@corp.com', 'user:Alice@Corp.COM', '  user:Bob@X.io  ', 'user:',
  'user: ', 'user:a b@x.com', 'user:a\tb', 'user:a\nb', 'group:', 'group:ABC-123', 'group: ABC ', 'group:a b',
  'org:', 'org:Tenant-GUID', ' org:t1 ', 'org:t 1', 'anyone', 'user', 'User:alice@corp.com', 'GROUP:x', 'domain:corp.com',
  '', '   ', 42, null, undefined, ['user:a'], 'public extra', 'user:x@y.com OR acl_principals:public',
];
const normalize = ['user:Alice@Corp.COM', '  user:Bob@X.io  ', 'group:ABC-123', ' group:ABC ', 'org:Tenant-GUID', ' org:t1 ', 'public', ' public ', 'user:already@lower.com'];
const users = ['Alice@Corp.COM', '  bob@x.io ', 'ÉLODIE@Example.FR'];
const groups = ['ABC-123', '  Sales@Corp.com ', 'Mixed-Case-Id'];
const orgs = ['Tenant-GUID', '  corp.com ', 'ABC'];
const out = {
  isValidPrincipal: valid.map((v) => [v === undefined ? '__undefined__' : v, p.isValidPrincipal(v)]),
  normalizePrincipal: normalize.map((v) => [v, p.normalizePrincipal(v)]),
  userPrincipal: users.map((v) => [v, p.userPrincipal(v)]),
  groupPrincipal: groups.map((v) => [v, p.groupPrincipal(v)]),
  orgPrincipal: orgs.map((v) => [v, p.orgPrincipal(v)]),
  constants: { PUBLIC_PRINCIPAL: p.PUBLIC_PRINCIPAL, ACL_PRINCIPALS_ATTR: p.ACL_PRINCIPALS_ATTR },
};
console.log(JSON.stringify(out, null, 2));
