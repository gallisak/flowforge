import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkflowForm } from '@/components/workflow-form';
import type { WorkflowDto } from '@/lib/types';

const router = { push: vi.fn(), refresh: vi.fn(), replace: vi.fn() };
vi.mock('next/navigation', () => ({ useRouter: () => router, usePathname: () => '/workflows/new' }));

const ZONES = ['Europe/Kyiv'];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('WorkflowForm', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    router.push.mockReset();
    fetchMock = vi.fn(async () => json({ id: 'w1' }, 201));
    vi.stubGlobal('fetch', fetchMock);
  });

  const submit = () => fireEvent.click(screen.getByRole('button', { name: /create workflow|save changes/i }));

  it('shows field errors and sends nothing while the form is invalid', async () => {
    render(<WorkflowForm timezones={ZONES} />);
    fireEvent.change(screen.getByLabelText('Steps (JSON)'), { target: { value: '[{' } });

    submit();

    expect(await screen.findByText('Name is required')).toBeInTheDocument();
    expect(screen.getByText(/Steps are not valid JSON/)).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toHaveAttribute('aria-invalid', 'true');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('creates the workflow and returns to the list', async () => {
    render(<WorkflowForm timezones={ZONES} />);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Orders' } });
    fireEvent.change(screen.getByLabelText('Schedule (cron)'), { target: { value: '0 9 * * *' } });
    fireEvent.change(screen.getByLabelText('Time zone'), { target: { value: 'Europe/Kyiv' } });

    submit();

    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/workflows'));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/proxy/workflows');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toMatchObject({ name: 'Orders', cron: '0 9 * * *', timezone: 'Europe/Kyiv', enabled: true });
  });

  it('shows the errors of the API next to the fields they belong to', async () => {
    fetchMock.mockResolvedValueOnce(json({ statusCode: 400, message: ['cron must be a valid cron expression'] }, 400));
    render(<WorkflowForm timezones={ZONES} />);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Orders' } });
    fireEvent.change(screen.getByLabelText('Schedule (cron)'), { target: { value: '61 9 * * *' } });

    submit();

    expect(await screen.findByText('cron must be a valid cron expression')).toBeInTheDocument();
    expect(screen.getByLabelText('Schedule (cron)')).toHaveAttribute('aria-invalid', 'true');
    expect(router.push).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Create workflow' })).toBeEnabled();
  });

  it('disables saving while the request is in flight', async () => {
    fetchMock.mockReturnValueOnce(new Promise(() => undefined));
    render(<WorkflowForm timezones={ZONES} />);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Orders' } });

    submit();

    expect(await screen.findByRole('button', { name: 'Saving…' })).toBeDisabled();
  });

  it('sends only the fields that changed when editing', async () => {
    const workflow: WorkflowDto = {
      id: 'w1',
      name: 'Orders',
      steps: [{ id: 'note', type: 'log', message: 'hi' }],
      enabled: true,
      cron: null,
      timezone: 'UTC',
      missedRunPolicy: 'once',
      nextRunAt: null,
      version: 2,
      createdAt: '2026-11-20T09:00:00Z',
    };
    render(<WorkflowForm workflow={workflow} timezones={ZONES} />);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Orders v2' } });

    submit();

    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/workflows'));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/proxy/workflows/w1');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({ name: 'Orders v2' });
  });
});
