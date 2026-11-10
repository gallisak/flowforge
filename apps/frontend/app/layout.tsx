import Link from 'next/link';

export const metadata = { title: 'FlowForge' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: 'system-ui, sans-serif', margin: 0 }}>
        <nav style={{ display: 'flex', gap: 16, padding: '12px 24px', borderBottom: '1px solid #ddd' }}>
          <strong>FlowForge</strong>
          <Link href="/workflows">Workflows</Link>
          <Link href="/connect">API key</Link>
        </nav>
        <div style={{ padding: 24, maxWidth: 800 }}>{children}</div>
      </body>
    </html>
  );
}
