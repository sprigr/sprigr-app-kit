/**
 * The stable identity of a gated operation, for the approval grant.
 *
 * A grant is bound to a hash so a tap on a small write cannot be spent on a big
 * one. When an app supplies no hash the platform derives one from the arguments
 * the MODEL sent, and the model does not send the same thing twice: an optional
 * param included on the asking call and dropped on the retry, a `store` learned
 * between the two, a tag list in a different order, each mints a different hash.
 * When the hash moves, the tap is silently discarded and the person is asked
 * the identical question again with nothing saying their answer was thrown
 * away.
 *
 * Only the app knows which arguments identify the operation, so only the app
 * can make the identity stable. Put in exactly the things that decide what
 * changes: the resource, the connection, and the payload. NOT `confirm` or
 * `_approval_granted` (attestation, not operation) and not free text the model
 * composes.
 *
 * Extracted unchanged from the Shopify app (sprigr-apps #1197).
 */

/**
 * Field separator. A control character, so it cannot occur in a tag, an id or
 * a store domain, which is what stops one combination of values being
 * re-partitioned into another ("a" + "bc" must not collide with "ab" + "c").
 */
export const UNIT_SEP = '\u001f';

/** A set, order-insensitive: `set(["a","b"])` === `set(["b","a"])`. */
export function set(values: unknown): string {
  if (!Array.isArray(values)) return '';
  return [...values].map((v) => String(v)).sort().join(UNIT_SEP);
}

/** An ordered list, for payloads where position changes the outcome. */
export function seq(values: unknown): string {
  if (!Array.isArray(values)) return '';
  return values.map((v) => String(v)).join(UNIT_SEP);
}

/**
 * Join the parts into the `_approval.hash` string. The platform mixes the tool
 * name in before hashing, so this never needs to repeat it.
 */
export function approvalHash(...parts: Array<string | number | undefined | null>): string {
  return parts.map((p) => (p === undefined || p === null ? '' : String(p))).join(UNIT_SEP);
}
