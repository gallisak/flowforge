import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import PageError from '@/app/error';
import EditWorkflowLoading from '@/app/workflows/[id]/edit/loading';
import WorkflowsLoading from '@/app/workflows/loading';

describe('states of server rendered pages', () => {
  it('shows a busy placeholder while the workflows load', () => {
    render(<WorkflowsLoading />);
    expect(screen.getByRole('status', { name: 'Loading workflows' })).toHaveAttribute('aria-busy', 'true');
  });

  it('shows a busy placeholder while a workflow loads for editing', () => {
    render(<EditWorkflowLoading />);
    expect(screen.getByRole('status', { name: 'Loading the workflow' })).toBeInTheDocument();
  });

  it('shows an error with a way to try again when a page fails', () => {
    const reset = vi.fn();
    render(<PageError error={new Error('boom')} reset={reset} />);

    expect(screen.getByText('This page could not be shown')).toBeInTheDocument();
    expect(screen.queryByText('boom')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(reset).toHaveBeenCalledOnce();
  });
});
