/**
 * Document-ACL principal grammar for the file-indexing surface.
 *
 * A faithful mirror of the platform's canonical builders in sprigr-team
 * packages/shared/src/utils/doc-acl.ts (userPrincipal / groupPrincipal /
 * orgPrincipal / PUBLIC_PRINCIPAL / isValidPrincipal / normalizePrincipal). A
 * marketplace app cannot import from `@sprigr/team-shared` (the build-runner
 * npm-installs the app in a sandbox with no workspace context), so the grammar
 * lives here, once, instead of as a hand copy in every file-indexing app
 * (microsoft-365 and google-workspace each carried one before this package).
 *
 * Byte-for-byte parity matters: the platform enforces `acl_principals` at read
 * time by building a locked filter of `acl_principals:<principal>` terms from
 * the REQUESTER's lowercased principals (platform doc-acl.ts buildAclFilter).
 * If an app stamps a `user:` principal with a mixed-case address (Microsoft
 * Graph and Google Drive both return `Alice@Corp.com`), the stored
 * `user:Alice@Corp.com` never matches the requester's `user:alice@corp.com`
 * term and the row is silently hidden from the very person it grants. So every
 * `user:` principal is lowercased at build time, exactly as `userPrincipal`
 * does platform-side. __tests__/doc-acl-platform-parity.test.ts pins the
 * parity with a fixture table generated from the platform module (the rule
 * sprigr-team decision 0151 sets for this package).
 *
 * The platform ALSO re-validates and re-normalises every principal on import
 * (wfp-data.ts validateAclPrincipals) and rejects the WHOLE batch on any
 * malformed or missing entry. We validate and normalise here anyway so a bad
 * principal is caught before a batch is ever posted (fail closed at the
 * source), and so the written form is already canonical.
 */

/** Principal every public / "anyone with the link" record carries. No file
 *  mapper in this package's consumers stamps it (a sharing link confers no
 *  search visibility, sprigr-team 2026-10-02); it stays in the grammar because
 *  the platform accepts it from other writers. */
export const PUBLIC_PRINCIPAL = 'public';

/** The faceted attribute holding a record's allowed principals. MUST be in the
 *  index's attributes_for_faceting (the platform forces this for -acl- indexes). */
export const ACL_PRINCIPALS_ATTR = 'acl_principals';

/**
 * A principal value may never contain whitespace (emails, group ids and domain
 * names never do). Whitespace is the only way a value could smuggle the
 * space-padded ` OR ` / ` AND ` operators into the read-time filter grammar, so
 * any candidate that contains it is rejected rather than silently corrupting
 * the filter. Mirrors FILTER_RESERVED in the platform doc-acl.ts.
 */
const FILTER_RESERVED = /\s/;

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** `user:<email>` with the email lowercased and trimmed for stable matching. */
export function userPrincipal(email: string): string {
  return `user:${normalizeEmail(email)}`;
}

/** `group:<id>` for a directory group (an Entra group GUID, a Google Group
 *  email, a Dropbox group id). Ids are case-SIGNIFICANT, so trimmed but never
 *  lowercased. */
export function groupPrincipal(groupId: string): string {
  return `group:${groupId.trim()}`;
}

/** `org:<tenantId>` for whole-directory ("people in your org") access. Ids are
 *  case-SIGNIFICANT, so trimmed but never lowercased. */
export function orgPrincipal(tenantId: string): string {
  return `org:${tenantId.trim()}`;
}

/**
 * True when `value` is a well-formed principal string in the canonical grammar:
 *
 *   - `public`                     the anyone-with-the-link principal
 *   - `user:<non-empty>`           a single end user (an email in practice)
 *   - `group:<non-empty>`          a directory group id
 *   - `org:<non-empty>`            a whole-directory / tenant id
 *
 * The suffix after the prefix must be non-empty and contain NO whitespace.
 * Leading and trailing whitespace on the whole value is tolerated and trimmed
 * before the check, matching the `*Principal` builders. Mirrors
 * isValidPrincipal in the platform doc-acl.ts, the source of truth the import
 * endpoint validates against.
 */
export function isValidPrincipal(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  if (!v || FILTER_RESERVED.test(v)) return false;
  if (v === PUBLIC_PRINCIPAL) return true;
  for (const prefix of ['user:', 'group:', 'org:'] as const) {
    if (v.startsWith(prefix)) return v.length > prefix.length;
  }
  return false;
}

/**
 * Canonicalise a stored principal so the write side matches the read side:
 *   - `user:<email>`  -> lowercase and trim the email portion (case-insensitive)
 *   - `group:<id>` / `org:<tenantId>` -> trimmed only (ids are case-significant)
 *   - `public`        -> unchanged
 *
 * Call AFTER isValidPrincipal has accepted the value. Idempotent. Mirrors
 * normalizePrincipal in the platform doc-acl.ts.
 */
export function normalizePrincipal(principal: string): string {
  const v = principal.trim();
  if (v.startsWith('user:')) {
    return userPrincipal(v.slice('user:'.length));
  }
  return v;
}

/**
 * True when every principal in `list` is valid AND the list is non-empty. The
 * withAcl import rejects the whole batch on any invalid or missing row, so the
 * indexer verifies each stamped record and SKIPS a bad one rather than let it
 * strand the whole batch (which would also strand the cursor). A well-behaved
 * mapper always yields at least the owner principal, so this only fires when
 * the owner email was unavailable AND the file had no resolvable grants.
 */
export function stampedPrincipalsValid(list: string[]): boolean {
  if (!Array.isArray(list) || list.length === 0) return false;
  return list.every((p) => isValidPrincipal(p));
}
