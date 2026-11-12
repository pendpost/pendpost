import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import CommandPalette from '../CommandPalette.jsx';
import AppToast from '../AppToast.jsx';
import { I18nProvider } from '../../lib/i18n.js';
import { recheckTiming } from '../../lib/useRecheck.js';

// Cmd-K "Recheck status": the palette closes on run, and before this the probe ran with its
// result and any error thrown away, so the click left no trace. Now a progress notice shows
// while it runs, then what came back, or why it failed.
const noop = () => {};

function renderPalette(onRecheckHealth) {
  return render(
    <I18nProvider locale="en">
      <CommandPalette posts={[]} onNavigate={noop} onNew={noop} onToggleTheme={noop} onRecheckHealth={onRecheckHealth} onOpenPost={noop} dark={false} clients={[]} activeClientId={null} onSwitchClient={noop} />
      <AppToast />
    </I18nProvider>,
  );
}

async function runRecheck(user) {
  await user.keyboard('{Meta>}k{/Meta}');
  await screen.findByRole('dialog', { name: /command palette/i });
  await user.type(screen.getByRole('combobox'), 'recheck');
  await user.keyboard('{Enter}');
}

beforeEach(() => { document.body.innerHTML = ''; });

describe('CommandPalette Recheck status', () => {
  it('shows a progress notice while the probe runs, then says it checked', async () => {
    recheckTiming.minBusyMs = 30;
    let resolve;
    const onRecheckHealth = vi.fn(() => new Promise((r) => { resolve = r; }));
    const user = userEvent.setup();
    renderPalette(onRecheckHealth);
    await runRecheck(user);
    expect(onRecheckHealth).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole('status')).toHaveTextContent(/checking every connection/i);
    resolve({ ok: true, health: { x: { ok: true } } });
    expect(await screen.findByText(/^Status checked at .+\./)).toBeInTheDocument();
  });

  it('a failed probe says so instead of vanishing', async () => {
    const onRecheckHealth = vi.fn(() => Promise.reject(Object.assign(new Error('timed out'), { code: 'timeout' })));
    const user = userEvent.setup();
    renderPalette(onRecheckHealth);
    await runRecheck(user);
    expect(await screen.findByRole('alert')).toHaveTextContent(/took too long to answer/i);
  });
});
