import { WAREHOUSE_FIXTURE } from '../lib/stock';

export const dynamic = 'force-dynamic';

export default function Page() {
  return (
    <main>
      <h1 style={{ marginTop: 0 }}>Mock Warehouse</h1>
      <p style={{ color: '#555' }}>
        A deterministic implementer of <code>fulfilment-hub/fulfilment_provider</code> v1.0.0. It accepts every
        push and holds it at <code>queued</code> until <code>mock_warehouse_advance</code> fires{' '}
        <code>provider.order.accepted</code> and then <code>provider.shipment.created</code>, which is how a
        hub shakedown drives the whole state machine without a real 3PL.
      </p>
      <h2 style={{ fontSize: '1rem' }}>Warehouses</h2>
      <ul>
        {WAREHOUSE_FIXTURE.map((w) => (
          <li key={w.warehouse_key}>
            <code>{w.warehouse_key}</code> - {w.name} ({w.country}), cutoff {w.cutoff_local_time}
          </li>
        ))}
      </ul>
      <p style={{ color: '#555' }}>
        <code>provider_ref</code> is always <code>mw_&lt;fulfilment_request_id&gt;</code>, so a shakedown can
        predict every id it will see.
      </p>
    </main>
  );
}
