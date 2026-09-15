export const metadata = {
  title: 'Showcase Consumer - Sprigr',
  description: 'Consumer side of the showcase cross-app demo',
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
