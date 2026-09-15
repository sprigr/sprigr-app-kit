export const dynamic = 'force-dynamic';

export default function Page() {
  return (
    <main style={{ padding: 32, maxWidth: 720, margin: '0 auto', fontFamily: 'system-ui, sans-serif' }}>
      <h1 style={{ marginTop: 0 }}>Contact Mirror</h1>
      <p style={{ color: '#555' }}>
        A second provider of the <code>showcase/contact_lookup</code> interface. Its one cross-tenant tool,
        <code> contact_mirror_lookup_contact</code>, is tagged <code>provides</code> in the manifest, so any
        installed consumer of the interface is bound to it, before or after this app is installed.
      </p>
    </main>
  );
}
