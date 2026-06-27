import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { axeClean } from '../../test-utils/axe.js';
import CommandPalette from '../CommandPalette.jsx';

// C4: the Cmd-K "Switch to {client}" actions. The palette stays PROP-DRIVEN (no
// hooks inside it) - App.jsx threads `clients`, `activeClientId`, and
// `onSwitchClient` as props, so the palette is testable in isolation. Selecting a
// non-active client calls onSwitchClient(id) and closes; the active client is
// marked and selecting it is a no-op close.
const noop = () => {};

const CLIENTS = [
  { id: 'acme', displayName: 'Acme Retail', status: 'active' },
  { id: 'globex', displayName: 'Globex Inc', status: 'active' },
  { id: 'initech', displayName: 'Initech', status: 'archived' },
];

function renderPalette(props = {}) {
  return render(
    <CommandPalette
      posts={[]}
      onNavigate={noop}
      onNew={noop}
      onToggleTheme={noop}
      onRecheckHealth={() => Promise.resolve()}
      onOpenPost={noop}
      dark={false}
      clients={CLIENTS}
      activeClientId="acme"
      onSwitchClient={props.onSwitchClient || noop}
      {...props}
    />,
  );
}

async function openPalette(user) {
  await user.keyboard('{Meta>}k{/Meta}');
  return screen.findByRole('dialog', { name: /command palette/i });
}

describe('CommandPalette switch-client actions (C4)', () => {
  beforeEach(() => {
    // userEvent's keyboard needs a clean document each test.
    document.body.innerHTML = '';
  });

  it('offers a "Switch to {name}" action per non-archived client', async () => {
    const user = userEvent.setup();
    renderPalette();
    await openPalette(user);
    await user.type(screen.getByRole('combobox'), 'globex');
    expect(await screen.findByText(/switch to globex inc/i)).toBeInTheDocument();
  });

  it('does NOT offer a switch action for an archived client', async () => {
    const user = userEvent.setup();
    renderPalette();
    await openPalette(user);
    await user.type(screen.getByRole('combobox'), 'initech');
    expect(screen.queryByText(/switch to initech/i)).not.toBeInTheDocument();
  });

  it('activating "Switch to {name}" calls onSwitchClient(id) and closes the palette', async () => {
    const onSwitchClient = vi.fn();
    const user = userEvent.setup();
    renderPalette({ onSwitchClient });
    await openPalette(user);
    await user.type(screen.getByRole('combobox'), 'globex');
    const option = await screen.findByText(/switch to globex inc/i);
    await user.click(option);
    await waitFor(() => expect(onSwitchClient).toHaveBeenCalledWith('globex'));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /command palette/i })).not.toBeInTheDocument());
  });

  it('marks the active client and selecting it is a no-op close (does not call onSwitchClient)', async () => {
    const onSwitchClient = vi.fn();
    const user = userEvent.setup();
    renderPalette({ onSwitchClient });
    await openPalette(user);
    await user.type(screen.getByRole('combobox'), 'acme');
    const activeOption = await screen.findByText(/switch to acme retail/i);
    // The active client's option is marked via aria-current.
    const optionEl = activeOption.closest('[role="option"]');
    expect(optionEl).toHaveAttribute('aria-current', 'true');
    await user.click(activeOption);
    expect(onSwitchClient).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /command palette/i })).not.toBeInTheDocument());
  });

  it('has no axe violations with the switch-client actions present', async () => {
    const user = userEvent.setup();
    const { container } = renderPalette();
    await openPalette(user);
    await user.type(screen.getByRole('combobox'), 'globex');
    await screen.findByText(/switch to globex inc/i);
    expect(await axeClean(container)).toHaveNoViolations();
  });
});

describe('CommandPalette page-jump commands (US-MC-04)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  // The four nav destinations that the sidebar exposes but the palette used to
  // omit. Each must be reachable as a "Go to {page}" page jump.
  it.each([
    ['published', /go to published/i],
    ['clients', /go to projects/i],
    ['setup', /go to setup/i],
  ])('offers a page jump to %s and routes onNavigate to it', async (page, labelRe) => {
    const onNavigate = vi.fn();
    const user = userEvent.setup();
    renderPalette({ onNavigate });
    await openPalette(user);
    await user.type(screen.getByRole('combobox'), page);
    const option = await screen.findByText(labelRe);
    await user.click(option);
    await waitFor(() => expect(onNavigate).toHaveBeenCalledWith(page));
  });
});

describe('CommandPalette keyboard exit (r2 coherence)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  // Escape must close from anywhere inside the dialog, matching the sibling
  // modals - not only while the search input holds focus. Clicking the backdrop
  // moves focus off the input, so a focus-bound Escape would silently stop
  // working; the global listener covers that case.
  it('closes on Escape after focus has left the search input (backdrop click)', async () => {
    const user = userEvent.setup();
    renderPalette();
    const dialog = await openPalette(user);
    // Move focus off the input onto the backdrop close button.
    const backdrop = screen.getByRole('button', { name: /close/i });
    backdrop.focus();
    expect(dialog).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /command palette/i })).not.toBeInTheDocument());
  });

  it('still closes on Escape while the search input holds focus', async () => {
    const user = userEvent.setup();
    renderPalette();
    await openPalette(user);
    await waitFor(() => expect(screen.getByRole('combobox')).toHaveFocus());
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /command palette/i })).not.toBeInTheDocument());
  });
});

describe('CommandPalette result-list a11y', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('gives the results listbox an accessible name', async () => {
    const user = userEvent.setup();
    renderPalette();
    await openPalette(user);
    const listbox = await screen.findByRole('listbox');
    expect(listbox).toHaveAccessibleName();
  });

  it('exposes a live status region announcing the matched count', async () => {
    const user = userEvent.setup();
    renderPalette();
    await openPalette(user);
    const status = await screen.findByRole('status');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status).toHaveTextContent(/\d+/);
  });

  it('announces the no-match state via the live status region', async () => {
    const user = userEvent.setup();
    renderPalette();
    await openPalette(user);
    await user.type(screen.getByRole('combobox'), 'zzzznomatchquery');
    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent(/no matches/i);
  });
});
