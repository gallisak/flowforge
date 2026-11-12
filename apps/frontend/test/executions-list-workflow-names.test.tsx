import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ExecutionsPage from '@/app/executions/page';

const router = { push: vi.fn(), refresh: vi.fn(), replace: vi.fn() };
vi.mock('next/navigation', () => ({ useRouter: () => router, usePathname: () => '/executions' }));

const workflowId = (n: number) => `aaaaaaaa-0000-0000-0000-${String(n).padStart(12, '0')}`;
const execution = (id: string, workflow: number, status = 'succeeded') => ({
  id: `${id}-0000-0000-0000-000000000000`,
  workflowId: workflowId(workflow),
  workflowVersion: 1,
  status,
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

const page = async (query: { status?: string; workflowId?: string }) => ExecutionsPage({ searchParams: Promise.resolve(query) });

describe('workflow names on the executions page', () => {
  let pages: Record<string, () => Response>;
  let fetchMock: ReturnType<typeof vi.fn>;
  const workflowRequests = () => fetchMock.mock.calls.filter(([url]) => String(url).startsWith('/api/proxy/workflows')).length;

  beforeEach(() => {
    pages = {
      '/api/proxy/workflows?limit=200': () => respond([{ id: workflowId(1), name: 'First page workflow' }], { cursor: 'wf-2' }),
      '/api/proxy/workflows?limit=200&cursor=wf-2': () => respond([{ id: workflowId(2), name: 'Second page workflow' }]),
      '/api/proxy/executions?limit=20': () => respond([execution('11111111', 1), execution('22222222', 2, 'failed')]),
      '/api/proxy/executions?limit=20&status=failed': () => respond([execution('22222222', 2, 'failed')]),
      '/api/proxy/executions?limit=20&status=succeeded': () => respond([execution('11111111', 1)]),
    };
    fetchMock = vi.fn(async (url: string) => {
      const answer = pages[url];
      if (!answer) throw new Error(`unexpected request ${url}`);
      return answer();
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  it('loads the workflow names once and keeps them while the filters change', async () => {
    const view = render(await page({}));
    expect(await screen.findByText('Second page workflow', { selector: 'td' })).toBeInTheDocument();
    expect(workflowRequests()).toBe(2);

    view.rerender(await page({ status: 'failed' }));
    expect(await screen.findByText('22222222')).toBeInTheDocument();
    expect(screen.queryByText('11111111')).not.toBeInTheDocument();
    view.rerender(await page({ status: 'succeeded' }));
    expect(await screen.findByText('11111111')).toBeInTheDocument();

    expect(screen.getByText('First page workflow', { selector: 'td' })).toBeInTheDocument();
    expect(workflowRequests()).toBe(2);
  });

  it('keeps the names it loaded and shows ids for the rest when a later page of workflows fails', async () => {
    pages['/api/proxy/workflows?limit=200&cursor=wf-2'] = () => respond({ statusCode: 502, message: 'The API is not reachable' }, { status: 502 });

    render(await page({}));

    expect(await screen.findByText('First page workflow', { selector: 'td' })).toBeInTheDocument();
    expect(screen.getByText('aaaaaaaa', { selector: 'td' })).toBeInTheDocument();
  });
});
