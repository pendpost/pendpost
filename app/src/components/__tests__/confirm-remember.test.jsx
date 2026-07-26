import { StrictMode } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeEach } from 'vitest';
import { ConfirmProvider, useConfirm, usePrompt, resetDialogSkips, dialogSkipCount } from '../ui/confirm.jsx';

// "Don't show this message again": a dialog opts in with a stable rememberKey; ticking
// the box and confirming suppresses that exact dialog on future calls (confirm -> true,
// prompt -> its defaultValue), recoverable via resetDialogSkips(). Cancelling never
// persists. Vitest's experimental localStorage has no working methods, so back it with a
// real Map (see the memory note on shadowed localStorage under vitest).
const store = new Map();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
    key: (i) => [...store.keys()][i] ?? null,
    get length() { return store.size; },
  },
});

const wrap = { wrapper: StrictMode };

function ConfirmHarness({ opts, onResult }) {
  const confirm = useConfirm();
  return <button type="button" onClick={async () => onResult(await confirm(opts))}>Ask</button>;
}
function PromptHarness({ opts, onResult }) {
  const prompt = usePrompt();
  return <button type="button" onClick={async () => onResult(await prompt(opts))}>AskPrompt</button>;
}

beforeEach(() => { store.clear(); });

describe('confirm/prompt "don\'t show again"', () => {
  it('shows the checkbox only when a rememberKey is passed', async () => {
    const { unmount } = render(<ConfirmProvider><ConfirmHarness opts={{ title: 'Plain' }} onResult={() => {}} /></ConfirmProvider>, wrap);
    fireEvent.click(screen.getByText('Ask'));
    await screen.findByRole('dialog');
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    unmount();

    render(<ConfirmProvider><ConfirmHarness opts={{ title: 'Silenceable', rememberKey: 'x.act' }} onResult={() => {}} /></ConfirmProvider>, wrap);
    fireEvent.click(screen.getByText('Ask'));
    await screen.findByRole('dialog');
    expect(screen.getByRole('checkbox')).toBeInTheDocument();
  });

  it('ticking + confirm suppresses the dialog on the next call and resolves true', async () => {
    let result;
    render(<ConfirmProvider><ConfirmHarness opts={{ title: 'Sure?', confirmLabel: 'Go', rememberKey: 'x.act' }} onResult={(r) => { result = r; }} /></ConfirmProvider>, wrap);

    fireEvent.click(screen.getByText('Ask'));
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Go' }));
    await waitFor(() => expect(result).toBe(true));
    expect(dialogSkipCount()).toBe(1);

    // Second call: no modal, resolves true immediately.
    result = undefined;
    fireEvent.click(screen.getByText('Ask'));
    await waitFor(() => expect(result).toBe(true));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('cancelling never persists, even with the box ticked', async () => {
    let result;
    render(<ConfirmProvider><ConfirmHarness opts={{ title: 'Sure?', cancelLabel: 'Stop', rememberKey: 'x.act' }} onResult={(r) => { result = r; }} /></ConfirmProvider>, wrap);
    fireEvent.click(screen.getByText('Ask'));
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(result).toBe(false));
    expect(dialogSkipCount()).toBe(0);

    // Still asks next time.
    fireEvent.click(screen.getByText('Ask'));
    await screen.findByRole('dialog');
  });

  it('a suppressed prompt resolves its defaultValue without a dialog', async () => {
    let result;
    render(<ConfirmProvider><PromptHarness opts={{ title: 'Note?', confirmLabel: 'Save', rememberKey: 'x.note', defaultValue: '' }} onResult={(r) => { result = r; }} /></ConfirmProvider>, wrap);
    fireEvent.click(screen.getByText('AskPrompt'));
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(result).toBe(''));

    result = undefined;
    fireEvent.click(screen.getByText('AskPrompt'));
    await waitFor(() => expect(result).toBe(''));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('resetDialogSkips brings every silenced dialog back', async () => {
    let result;
    render(<ConfirmProvider><ConfirmHarness opts={{ title: 'Sure?', confirmLabel: 'Go', rememberKey: 'x.act' }} onResult={(r) => { result = r; }} /></ConfirmProvider>, wrap);
    fireEvent.click(screen.getByText('Ask'));
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Go' }));
    await waitFor(() => expect(dialogSkipCount()).toBe(1));

    expect(resetDialogSkips()).toBe(1);
    expect(dialogSkipCount()).toBe(0);

    // Asks again after reset.
    fireEvent.click(screen.getByText('Ask'));
    await screen.findByRole('dialog');
  });
});
