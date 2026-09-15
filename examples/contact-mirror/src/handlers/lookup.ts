/**
 * Contact Mirror - a second implementer of showcase/contact_lookup.
 *
 * The whole point of this app is its manifest: `cross_tenant_tools[0].provides`
 * tags `contact_mirror_lookup_contact` as op `lookup_contact` of the
 * showcase app's interface, so any consumer that requires the interface is
 * bound to this tool at install (decision 0077). The handler itself is a
 * fixture lookup; a real mirror would read its own store.
 */

export interface LookupArgs {
  contact_id: string;
}

export interface LookupResult {
  found: boolean;
  contact?: { id: string; name: string; email: string; source: 'contact-mirror' };
}

const FIXTURE: Record<string, { name: string; email: string }> = {
  'c_mirror_1': { name: 'Mira Mirror', email: 'mira@example.test' },
  'c_mirror_2': { name: 'Milo Mirror', email: 'milo@example.test' },
};

export function lookupContact(args: LookupArgs): LookupResult {
  const hit = args?.contact_id ? FIXTURE[args.contact_id] : undefined;
  if (!hit) return { found: false };
  return { found: true, contact: { id: args.contact_id, ...hit, source: 'contact-mirror' } };
}

export default {
  contact_mirror_lookup_contact: (args: LookupArgs) => lookupContact(args),
};
