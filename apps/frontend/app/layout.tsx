import './globals.css';
import { SiteHeader } from '@/components/site-header';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'FlowForge' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-neutral-50 font-sans">
        <SiteHeader />
        <main className="container py-8">{children}</main>
      </body>
    </html>
  );
}
