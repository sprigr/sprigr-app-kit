export const dynamic = 'force-dynamic';

export default function Page() {
  return (
    <main style={{ padding: 32, maxWidth: 720, margin: '0 auto', fontFamily: 'system-ui, sans-serif' }}>
      <h1 style={{ marginTop: 0 }}>Showcase Consumer</h1>
      <p style={{ color: '#555' }}>
        Companion to the <strong>showcase</strong> app. It subscribes to showcase&apos;s cross-tenant
        <code> showcase.deal.won</code> event and enriches each signal by calling showcase&apos;s
        <code> showcase_lookup_contact</code> cross-tenant tool via <code>env.SPRIGR.invoke</code>.
      </p>
      <p style={{ color: '#888' }}>
        Install the <strong>showcase</strong> app first and approve the app-to-app dependency grant, then
        this app can look up contacts on the granting brand&apos;s behalf.
      </p>
    </main>
  );
}
