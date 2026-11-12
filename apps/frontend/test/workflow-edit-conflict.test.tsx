import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import EditWorkflowPage from '@/app/workflows/[id]/edit/page';
import { WorkflowForm } from '@/components/workflow-form';
import type { WorkflowDto } from '@/lib/types';

const router = { push: vi.fn(), refresh: vi.fn(), replace: vi.fn() };
const loadWorkflow = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ useRouter: () => router, usePathname: () => '/workflows/w1/edit', notFound: vi.fn() }));
vi.mock('@/lib/api', () => ({ apiFetch: loadWorkflow }));

const CONFLICT = 'The workflow was changed by someone else; reload it and try again';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const workflow: WorkflowDto = {
  id: 'w1',
  name: 'Orders',
  steps: [{ id: 'note', type: 'log', message: 'hi' }],
  enabled: true,
  cron: null,
  timezone: 'UTC',
  missedRunPolicy: 'once',
  nextRunAt: null,
  version: 7,
  createdAt: '2026-11-20T09:00:00Z',
};

describe('editing a workflow that someone else may change at the same time', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    router.push.mockReset();
    router.refresh.mockReset();
    fetchMock = vi.fn(async () => json({ ...workflow, version: 8 }));
    vi.stubGlobal('fetch', fetchMock);
  });

  function rename(): void {
    render(<WorkflowForm workflow={workflow} timezones={['UTC']} />);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Orders v2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  }

  it('sends the version it was loaded with as the expected version', async () => {
    rename();

    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/workflows'));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/proxy/workflows/w1');
    expect(init.method).toBe('PATCH');
    expect(new Headers(init.headers).get('if-match')).toBe('"7"');
  });

  it('explains that the workflow changed meanwhile, keeps the edits and offers to reload', async () => {
    fetchMock.mockResolvedValueOnce(json({ statusCode: 412, message: CONFLICT }, 412));

    rename();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(CONFLICT);
    expect(screen.getByLabelText('Name')).toHaveValue('Orders v2');
    expect(router.push).not.toHaveBeenCalled();

    fireEvent.click(within(alert).getByRole('button', { name: 'Reload the workflow' }));
    expect(router.refresh).toHaveBeenCalledOnce();
  });

  it('explains the conflict even when the answer carries no message', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 412 }));

    rename();

    expect(await screen.findByRole('alert')).toHaveTextContent(CONFLICT);
  });

  it('shows the newer workflow after a reload instead of the stale edits under the newer version', async () => {
    const id = '48c61687-afc1-474c-85ae-678f21b706d2';
    loadWorkflow.mockResolvedValueOnce({ ...workflow, id });
    const view = render(await EditWorkflowPage({ params: Promise.resolve({ id }) }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Orders v2' } });

    loadWorkflow.mockResolvedValueOnce({ ...workflow, id, name: 'Orders renamed elsewhere', version: 8 });
    view.rerender(await EditWorkflowPage({ params: Promise.resolve({ id }) }));

    expect(screen.getByLabelText('Name')).toHaveValue('Orders renamed elsewhere');
  });
});
