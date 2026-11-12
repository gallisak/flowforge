import Link from 'next/link';
import { hasApiKey } from '@/lib/api';
import { DisconnectButton } from './disconnect-button';

export async function SiteHeader() {
  const connected = await hasApiKey();
  return (
    <header className="border-b bg-background">
      <div className="container flex h-14 items-center gap-6">
        <Link href="/workflows" className="font-semibold tracking-tight">
          FlowForge
        </Link>
        <nav className="flex items-center gap-4 text-sm text-muted-foreground">
          <Link href="/workflows" className="hover:text-foreground">
            Workflows
          </Link>
          <Link href="/executions" className="hover:text-foreground">
            Executions
          </Link>
        </nav>
        <div className="ml-auto">
          {connected ? (
            <DisconnectButton />
          ) : (
            <Link href="/connect" className="text-sm text-muted-foreground hover:text-foreground">
              Connect
            </Link>
          )}
        </div>
      </div>
    </header>
  );
}
