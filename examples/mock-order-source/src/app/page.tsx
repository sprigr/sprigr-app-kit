import { SEED_LOCATIONS, SEED_ORDER, SEED_REQUEST } from '../lib/records';

export const dynamic = 'force-dynamic';

export default function Page() {
  return (
    <main>
      <h1 style={{ marginTop: 0 }}>Mock Order Source</h1>
      <p style={{ color: '#555' }}>
        A deterministic implementer of <code>fulfilment-hub/order_source</code> v1.0.0. It keeps orders in
        this install&apos;s own D1 and implements every op against that store, so the hub can be driven end to
        end with no selling system behind it.
      </p>
      <p style={{ color: '#555' }}>
        Call <code>mock_order_source_place_order</code> to create an order and fire{' '}
        <code>source.order.created</code> then <code>source.request.submitted</code>, which is the
        routing trigger the hub subscribes to.
      </p>
      <h2 style={{ fontSize: '1rem' }}>Seeded on install</h2>
      <ul>
        <li>
          Order <code>{SEED_ORDER.source_ref}</code> ({SEED_ORDER.source_number}), two lines, request{' '}
          <code>{SEED_REQUEST.source_request_ref}</code>
        </li>
        {SEED_LOCATIONS.map((l) => (
          <li key={l.source_location_ref}>
            Location <code>{l.source_location_ref}</code> - {l.name} ({l.country})
          </li>
        ))}
      </ul>
    </main>
  );
}
