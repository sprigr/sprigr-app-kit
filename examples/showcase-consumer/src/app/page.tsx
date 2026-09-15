export const dynamic = 'force-dynamic';

export default function Page() {
  return (
    <main style={{ padding: 32, maxWidth: 720, margin: '0 auto', fontFamily: 'system-ui, sans-serif' }}>
      <h1 style={{ marginTop: 0 }}>Showcase Consumer</h1>
      <p style={{ color: '#555' }}>
        Companion to the <strong>showcase</strong> app. It subscribes to showcase&apos;s cross-tenant
        <code> showcase.deal.won</code> event and enriches each signal by resolving the contact through
        every installed provider of the <code>showcase/contact_lookup</code> interface
        (<code>env.SPRIGR.grants.providers</code> + <code>env.SPRIGR.invoke</code>).
      </p>
      <p style={{ color: '#888' }}>
        Install any provider of the interface (the <strong>showcase</strong> app, <strong>contact-mirror</strong>,
        or one published later) before or after this app; the platform binds them without a republish.
      </p>
    </main>
  );
}
