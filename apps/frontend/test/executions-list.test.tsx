import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ExecutionsList } from '@/components/executions-list';

const router = { push: vi.fn(), refresh: vi.fn(), replace: vi.fn() };
vi.mock('next/navigation', () => ({ useRouter: () => router, usePathname: () => '/executions' }));

const execution = (id: string, status = 'succeeded') => ({
  id: `${id}-0000-0000-0000-000000000000`,
  workflowId: 'aaaaaaaa-0000-0000-0000-000000000000',
  workflowVersion: 1,
  status,
  trigger: 'api',
  input: {},
  output: null,
  error: null,
  correlationId: null,
  createdAt: '2026-11-20T09:00:00Z',
  finishedAt: '2026-11-20T09:00:01Z',
});

function respond(body: unknown, init: { status?: number; cursor?: string } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (init.cursor) headers['x-next-cursor'] = init.cursor;
  return new Response(JSON.stringify(body), { status: init.status ?? 200, headers });
}

describe('ExecutionsList', () => {
  let pages: Record<string, () => Response>;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    router.replace.mockReset();
    pages = {
      '/api/proxy/workflows': () => respond([{ id: 'aaaaaaaa-0000-0000-0000-000000000000', name: 'Orders' }]),
    };
    fetchMock = vi.fn(async (url: string) => {
      const [path, query = ''] = url.split('?');
      const key = path === '/api/proxy/executions' ? `${path}?${query}` : path;
      const page = pages[key];
      if (!page) throw new Error(`unexpected request ${url}`);
      return page();
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  it('loads the next page with the cursor of the previous one', async () => {
    pages['/api/proxy/executions?limit=20'] = () => respond([execution('11111111'), execution('22222222')], { cursor: 'next-1' });
    pages['/api/proxy/executions?limit=20&cursor=next-1'] = () => respond([execution('33333333', 'failed')]);

    render(<ExecutionsList filters={{}} />);
    expect(await screen.findByText('11111111')).toBeInTheDocument();
    expect(screen.getAllByText('Orders')).not.toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));

    expect(await screen.findByText('33333333')).toBeInTheDocument();
    expect(screen.getByText('11111111')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });

  it('passes the filters to the API', async () => {
    pages['/api/proxy/executions?limit=20&status=failed&workflowId=aaaaaaaa-0000-0000-0000-000000000000'] = () => respond([execution('44444444', 'failed')]);

    render(<ExecutionsList filters={{ status: 'failed', workflowId: 'aaaaaaaa-0000-0000-0000-000000000000' }} />);

    expect(await screen.findByText('44444444')).toBeInTheDocument();
  });

  it('shows an empty state', async () => {
    pages['/api/proxy/executions?limit=20&status=waiting'] = () => respond([]);

    render(<ExecutionsList filters={{ status: 'waiting' }} />);

    expect(await screen.findByText('No executions found')).toBeInTheDocument();
    expect(screen.getByText('Try another filter.')).toBeInTheDocument();
  });

  it('shows a loading state before the first page arrives', () => {
    pages['/api/proxy/executions?limit=20'] = () => respond([]);
    fetchMock.mockImplementation(() => new Promise(() => undefined));

    render(<ExecutionsList filters={{}} />);

    expect(screen.getByLabelText('Loading executions')).toHaveAttribute('aria-busy', 'true');
  });

  it('shows an error with a way to retry and recovers', async () => {
    let calls = 0;
    pages['/api/proxy/executions?limit=20'] = () =>
      ++calls === 1 ? respond({ statusCode: 500, message: 'Internal server error' }, { status: 500 }) : respond([execution('55555555')]);

    render(<ExecutionsList filters={{}} />);
    expect(await screen.findByText('Internal server error')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByText('55555555')).toBeInTheDocument();
  });

  it('offers to connect when the API key is rejected', async () => {
    pages['/api/proxy/executions?limit=20'] = () => respond({ statusCode: 401, message: 'Invalid API key' }, { status: 401 });

    render(<ExecutionsList filters={{}} />);

    await waitFor(() => expect(screen.getByRole('link', { name: 'Connect' })).toHaveAttribute('href', '/connect'));
  });
});
