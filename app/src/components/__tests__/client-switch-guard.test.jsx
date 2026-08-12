import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import ClientSwitcher from '../ClientSwitcher.jsx';
import Composer from '../Composer.jsx';
import ThreadComposer from '../ThreadComposer.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { I18nProvider } from '../../lib/i18n.js';
import { makeClientSwitchGuard } from '../../lib/clientSwitchGuard.js';

// Dim-4 gap 1 (ux-audit-2026-08-04): switching the active client while the
// Composer holds a dirty draft silently re-scoped the app but kept the form
// state, so Save posted the draft into the WRONG client's identically-named
// campaign (the exact anti-goal of docs/specs/multi-client.md). The fix is ONE
// shared guard (makeClientSwitchGuard) that BOTH switch paths (sidebar
// ClientSwitcher + Cmd-K palette) run before re-scoping: a dirty composer must
// be explicitly discarded via confirm, and the discard happens BEFORE the
// switch; cancel stays put. A clean composer switches silently as before.

const setActive = vi.fn(() => Promise.resolve({ ok: true }));
let clientsState;

vi.mock('../../lib/api.js', () => ({
  useClients: () => ({ data: clientsState, isLoading: false, isError: false, error: null }),
  useActiveClient: () => ({
    data: clientsState,
    isLoading: false,
    isError: false,
    error: null,
    activeClient: clientsState?.clients.find((c) => c.id === clientsState.activeClientId) || null,
    activeClientId: clientsState?.activeClientId || null,
  }),
  useSetActiveClient: () => setActive,
  useAssets: () => ({ data: { assets: [], dir: '/tmp/assets' } }),
  useConfig: () => ({ data: { posting: { hashtagPresets: [] } } }),
  usePlatformValidate: () => ({ data: undefined }),
  useValidateMedia: () => ({ data: undefined }),
  useRedditFlairs: () => ({ data: undefined, isLoading: false }),
  usePinterestBoardSections: () => ({ data: undefined, isLoading: false }),
  createPost: vi.fn(() => Promise.resolve({ ok: true })),
  updatePost: vi.fn(() => Promise.resolve({ ok: true })),
  lintText: vi.fn(() => Promise.resolve({ ok: true, clean: true, findings: [] })),
}));

function wrap(ui) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale="en">
        <TooltipProvider>
          <ConfirmProvider>{ui}</ConfirmProvider>
        </TooltipProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  setActive.mockClear();
  clientsState = {
    activeClientId: 'acme',
    clients: [
      { id: 'acme', displayName: 'Acme Retail', status: 'active' },
      { id: 'globex', displayName: 'Globex Inc', status: 'active' },
    ],
  };
});

describe('makeClientSwitchGuard (the ONE shared guard)', () => {
  it('lets a clean composer switch silently (no confirm, no discard)', async () => {
    const confirmDiscard = vi.fn();
    const discardComposer = vi.fn();
    const guard = makeClientSwitchGuard({ isComposerDirty: () => false, confirmDiscard, discardComposer });
    await expect(guard()).resolves.toBe(true);
    expect(confirmDiscard).not.toHaveBeenCalled();
    expect(discardComposer).not.toHaveBeenCalled();
  });

  it('a dirty composer + cancel stays put: resolves false, nothing discarded', async () => {
    const discardComposer = vi.fn();
    const guard = makeClientSwitchGuard({
      isComposerDirty: () => true,
      confirmDiscard: vi.fn(() => Promise.resolve(false)),
      discardComposer,
    });
    await expect(guard()).resolves.toBe(false);
    expect(discardComposer).not.toHaveBeenCalled();
  });

  it('a dirty composer + confirm discards FIRST, then allows the switch', async () => {
    const order = [];
    const guard = makeClientSwitchGuard({
      isComposerDirty: () => true,
      confirmDiscard: vi.fn(() => Promise.resolve(true)),
      discardComposer: vi.fn(() => order.push('discard')),
    });
    const ok = await guard();
    order.push('switch-allowed');
    expect(ok).toBe(true);
    expect(order).toEqual(['discard', 'switch-allowed']);
  });
});

describe('ClientSwitcher goes through the guard (onBeforeSwitch)', () => {
  it('a refused guard blocks the switch: setActiveClient is never called', async () => {
    const user = userEvent.setup();
    wrap(<ClientSwitcher onBeforeSwitch={vi.fn(() => Promise.resolve(false))} />);
    await user.click(screen.getByRole('button', { name: /switch active project/i }));
    await user.click(await screen.findByRole('button', { name: /globex inc/i }));
    await waitFor(() => expect(setActive).not.toHaveBeenCalled());
  });

  it('an allowing guard lets the switch proceed', async () => {
    const user = userEvent.setup();
    wrap(<ClientSwitcher onBeforeSwitch={vi.fn(() => Promise.resolve(true))} />);
    await user.click(screen.getByRole('button', { name: /switch active project/i }));
    await user.click(await screen.findByRole('button', { name: /globex inc/i }));
    await waitFor(() => expect(setActive).toHaveBeenCalledWith('globex'));
  });

  it('without a guard prop the switch stays silent (unchanged behavior)', async () => {
    const user = userEvent.setup();
    wrap(<ClientSwitcher />);
    await user.click(screen.getByRole('button', { name: /switch active project/i }));
    await user.click(await screen.findByRole('button', { name: /globex inc/i }));
    await waitFor(() => expect(setActive).toHaveBeenCalledWith('globex'));
  });
});

const campaigns = [{ id: 'launch-2026-07', active: true, posts: [] }];

describe('Composer reports dirtiness upward (onDirtyChange)', () => {
  it('starts clean, flips to dirty after typing', async () => {
    const user = userEvent.setup();
    const onDirtyChange = vi.fn();
    wrap(
      <Composer
        mode="create"
        post={null}
        campaigns={campaigns}
        onClose={vi.fn()}
        onSaved={vi.fn()}
        onDirtyChange={onDirtyChange}
      />,
    );
    expect(onDirtyChange).toHaveBeenCalledWith(false);
    expect(onDirtyChange).not.toHaveBeenCalledWith(true);
    await user.type(screen.getByRole('textbox', { name: /post text/i }), 'hello');
    await waitFor(() => expect(onDirtyChange).toHaveBeenCalledWith(true));
  });
});

describe('ThreadComposer reports dirtiness upward (onDirtyChange)', () => {
  it('starts clean, flips to dirty after typing the opener', async () => {
    const user = userEvent.setup();
    const onDirtyChange = vi.fn();
    wrap(
      <ThreadComposer
        campaigns={campaigns}
        onClose={vi.fn()}
        onSaved={vi.fn()}
        onDirtyChange={onDirtyChange}
      />,
    );
    expect(onDirtyChange).toHaveBeenCalledWith(false);
    expect(onDirtyChange).not.toHaveBeenCalledWith(true);
    await user.type(screen.getAllByRole('textbox')[0], 'thread opener');
    await waitFor(() => expect(onDirtyChange).toHaveBeenCalledWith(true));
  });
});
