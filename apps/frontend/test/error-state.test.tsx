import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ErrorState } from '@/components/error-state';

const router = { refresh: vi.fn(), push: vi.fn(), replace: vi.fn() };
vi.mock('next/navigation', () => ({ useRouter: () => router, usePathname: () => '/workflows' }));

describe('error state', () => {
  it('asks a visitor without a valid key to connect instead of showing the API message', () => {
    render(<ErrorState title="Could not load workflows" message="Missing x-api-key" status={401} />);

    expect(screen.queryByText('Missing x-api-key')).not.toBeInTheDocument();
    expect(screen.getByText('Connect with a valid API key first')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Connect' })).toHaveAttribute('href', '/connect');
  });

  it('lets a server rendered page be loaded again after a failure', () => {
    render(<ErrorState title="Could not load workflows" message="The API is not reachable" status={0} refreshable />);

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(router.refresh).toHaveBeenCalledOnce();
  });
});
