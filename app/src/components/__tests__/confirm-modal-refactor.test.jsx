import { StrictMode } from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { ConfirmProvider, useConfirm, usePrompt } from '../ui/confirm.jsx';

// Wrap in StrictMode so the suite exercises the same double-invoke-effects path
// the real app runs (src/main.jsx mounts under <React.StrictMode>) — this is what
// catches a child effect (Modal's useSlideOver panel-focus) re-running after the
// parent's default-focus effect and stealing focus.
const wrap = { wrapper: StrictMode };

function ConfirmHarness({ opts, onResult }) {
  const confirm = useConfirm();
  return (
    <button type="button" onClick={async () => onResult(await confirm(opts))}>
      Ask
    </button>
  );
}

function PromptHarness({ opts, onResult }) {
  const prompt = usePrompt();
  return (
    <button type="button" onClick={async () => onResult(await prompt(opts))}>
      AskPrompt
    </button>
  );
}

describe('ConfirmProvider via shared Modal', () => {
  it('portals the dialog to document.body with max-w-sm', async () => {
    render(<ConfirmProvider><ConfirmHarness opts={{ title: 'Sure?' }} onResult={() => {}} /></ConfirmProvider>, wrap);
    fireEvent.click(screen.getByText('Ask'));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.parentElement).toBe(document.body);
    expect(dialog.querySelector('.glass-panel').className).toContain('max-w-sm');
  });

  it('default-focuses the confirm button (non-danger)', async () => {
    render(<ConfirmProvider><ConfirmHarness opts={{ title: 'Sure?', confirmLabel: 'Go' }} onResult={() => {}} /></ConfirmProvider>, wrap);
    fireEvent.click(screen.getByText('Ask'));
    await screen.findByRole('dialog');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Go' })).toHaveFocus());
  });

  it('default-focuses the cancel button when danger', async () => {
    render(<ConfirmProvider><ConfirmHarness opts={{ title: 'Sure?', danger: true, cancelLabel: 'Stop' }} onResult={() => {}} /></ConfirmProvider>, wrap);
    fireEvent.click(screen.getByText('Ask'));
    await screen.findByRole('dialog');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Stop' })).toHaveFocus());
  });

  it('default-focuses the prompt input and Enter submits its value', async () => {
    let result;
    render(<ConfirmProvider><PromptHarness opts={{ title: 'Name?' }} onResult={(r) => { result = r; }} /></ConfirmProvider>, wrap);
    fireEvent.click(screen.getByText('AskPrompt'));
    await screen.findByRole('dialog');
    const input = screen.getByRole('textbox');
    await waitFor(() => expect(input).toHaveFocus());
    fireEvent.change(input, { target: { value: 'hi there' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(result).toBe('hi there'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Escape cancels: false for confirm, null for prompt', async () => {
    let confirmRes;
    const { unmount } = render(<ConfirmProvider><ConfirmHarness opts={{ title: 'Sure?' }} onResult={(r) => { confirmRes = r; }} /></ConfirmProvider>, wrap);
    fireEvent.click(screen.getByText('Ask'));
    await screen.findByRole('dialog');
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
    await waitFor(() => expect(confirmRes).toBe(false));
    unmount();

    let promptRes = 'unset';
    render(<ConfirmProvider><PromptHarness opts={{ title: 'Name?' }} onResult={(r) => { promptRes = r; }} /></ConfirmProvider>, wrap);
    fireEvent.click(screen.getByText('AskPrompt'));
    await screen.findByRole('dialog');
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
    await waitFor(() => expect(promptRes).toBe(null));
  });

  it('restores focus to the trigger on close', async () => {
    render(<ConfirmProvider><ConfirmHarness opts={{ title: 'Sure?', confirmLabel: 'Go' }} onResult={() => {}} /></ConfirmProvider>, wrap);
    const trigger = screen.getByText('Ask');
    trigger.focus();
    fireEvent.click(trigger);
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: 'Go' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(trigger).toHaveFocus();
  });
});
