export const metadata = {
  title: 'Mock Warehouse - Sprigr',
  description: 'Deterministic fulfilment_provider implementer for the fulfilment hub',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: 'system-ui, sans-serif', margin: 0, padding: '2rem', maxWidth: 760 }}>
        {children}
      </body>
    </html>
  );
}
