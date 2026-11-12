import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ExecutionsList } from '@/components/executions-list';

const router = { push: vi.fn(), refresh: vi.fn(), replace: vi.fn() };
vi.mock('next/navigation', () => ({ useRouter: () => router, usePathname: () => '/executions' }));

const workflowId = (n: number) => `aaaaaaaa-0000-0000-0000-${String(n).padStart(12, '0')}`;
const execution = (id: string, workflow = 1) => ({
  id: `${id}-0000-0000-0000-000000000000`,
  workflowId: workflowId(workflow),
  workflowVersion: 1,
  status: 'succeeded',
  trigger: 'api',
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

describe('ExecutionsList paging', () => {
  let pages: Record<string, () => Response>;

  beforeEach(() => {
    pages = {
      '/api/proxy/workflows?limit=200': () => respond([{ id: workflowId(1), name: 'First page workflow' }], { cursor: 'wf-2' }),
      '/api/proxy/workflows?limit=200&cursor=wf-2': () => respond([{ id: workflowId(2), name: 'Second page workflow' }]),
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const page = pages[url];
        if (!page) throw new Error(`unexpected request ${url}`);
        return page();
      }),
    );
  });

  it('names workflows from every page of the workflow list', async () => {
    pages['/api/proxy/executions?limit=20'] = () => respond([execution('11111111', 2)]);

    render(<ExecutionsList filters={{}} />);

    expect(await screen.findByText('Second page workflow')).toBeInTheDocument();
  });

  it('retries a failed next page from its cursor and keeps the rows already loaded', async () => {
    let failNext = true;
    pages['/api/proxy/executions?limit=20'] = () => respond([execution('11111111')], { cursor: 'next-1' });
    pages['/api/proxy/executions?limit=20&cursor=next-1'] = () => {
      if (failNext) {
        failNext = false;
        return respond({ statusCode: 502, message: 'The API is not reachable' }, { status: 502 });
      }
      return respond([execution('22222222')]);
    };
    render(<ExecutionsList filters={{}} />);
    expect(await screen.findByText('11111111')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    const alert = await screen.findByRole('alert');
    fireEvent.click(within(alert).getByRole('button'));

    expect(await screen.findByText('22222222')).toBeInTheDocument();
    expect(screen.getByText('11111111')).toBeInTheDocument();
  });
});
