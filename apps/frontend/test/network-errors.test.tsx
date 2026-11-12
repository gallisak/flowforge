import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ConnectPage from '@/app/connect/page';
import { ExecutionsList } from '@/components/executions-list';
import { RunWorkflowButton } from '@/components/run-workflow-button';
import { WorkflowForm } from '@/components/workflow-form';

const router = { push: vi.fn(), refresh: vi.fn(), replace: vi.fn() };
vi.mock('next/navigation', () => ({ useRouter: () => router, usePathname: () => '/' }));

const OFFLINE = 'Could not reach the server. Check your connection and try again.';

describe('messages for failures that are not answers of the API', () => {
  beforeEach(() => {
    router.push.mockReset();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    );
  });

  it('explains a lost connection when a run cannot be started', async () => {
    render(<RunWorkflowButton workflowId="w1" />);

    fireEvent.click(screen.getByRole('button', { name: 'Run' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(OFFLINE);
    expect(screen.queryByText(/Failed to fetch/)).not.toBeInTheDocument();
  });

  it('explains a lost connection when a workflow cannot be saved', async () => {
    render(<WorkflowForm timezones={['UTC']} />);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Orders' } });

    fireEvent.click(screen.getByRole('button', { name: 'Create workflow' }));

    expect(await screen.findByText(OFFLINE)).toBeInTheDocument();
    expect(screen.queryByText(/Failed to fetch/)).not.toBeInTheDocument();
  });

  it('explains a lost connection when the key cannot be checked', async () => {
    render(<ConnectPage />);
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'ff_key' } });

    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(OFFLINE);
  });

  it('explains a lost connection when the executions cannot be loaded', async () => {
    render(<ExecutionsList filters={{}} />);

    expect(await screen.findByText(OFFLINE)).toBeInTheDocument();
  });

  it('tells a malformed answer apart from a lost connection', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.startsWith('/api/proxy/executions')
          ? new Response('<html>gateway</html>', { status: 200, headers: { 'content-type': 'text/html' } })
          : new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }),
      ),
    );

    render(<ExecutionsList filters={{}} />);

    expect(await screen.findByText('The server sent an unexpected response')).toBeInTheDocument();
    expect(screen.queryByText(OFFLINE)).not.toBeInTheDocument();
    expect(screen.queryByText('The API is not reachable')).not.toBeInTheDocument();
  });
});
