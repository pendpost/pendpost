import { render, screen, act, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import UpdateToast, { formatVersion, postDashboardUpdate } from '../UpdateToast.jsx';
import { I18nProvider } from '../../lib/i18n.js';
import { TooltipProvider } from '../ui/Tooltip.jsx';

// UpdateToast polls GET /api/dashboard-update (useUpdateStatus) and behaves like a
// desktop updater: it names the new version (never a commit), shows the real step
// the server reports, says "Updated to" once the server is back on the new code,
// explains a failure with Try again, and remembers a dismissal per commit. The hook
// is mocked so each test drives the server states directly.
let status;
const pollCalls = [];
vi.mock('../../lib/api.js', () => ({
  useUpdateStatus: (fast) => { pollCalls.push(fast); return status; },
}));
// GET /api/whats-new (useWhatsNew) is mocked the same way; the helpers stay real.
let news = null;
const seenCalls = [];
vi.mock('../../lib/whatsNew.js', async (importOriginal) => ({
  ...(await importOriginal()),
  useWhatsNew: () => ({ data: news }),
  useMarkWhatsNewSeen: () => (v) => { seenCalls.push(v); },
}));
// One release entry with one item per title pair (the items schema, lib/whats-new.json).
const NOTE = (version, en, de) => ({
  version,
  date: '2026-11-02',
  url: `https://example.test/changelog#v${version}`,
  items: en.map((title, i) => ({ kind: 'new', icon: 'layers', title: { en: title, 'de-CH': de[i] }, body: { en: `${title} body.`, 'de-CH': `${de[i]} Text.` } })),
});
const newsFor = (version, unseen) => ({ ok: true, version, seen: '2.9.0', unseen, recent: unseen, releasesUrl: 'https://example.test/releases' });

// Node's experimental localStorage has no methods under vitest: install a real one.
function installStorage() {
  const map = new Map();
  const stub = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    clear: () => { map.clear(); },
    key: (i) => [...map.keys()][i] ?? null,
    get length() { return map.size; },
  };
  Object.defineProperty(globalThis, 'localStorage', { value: stub, configurable: true, writable: true });
  Object.defineProperty(window, 'localStorage', { value: stub, configurable: true, writable: true });
  return stub;
}

const RUN = { version: '2.9.0', commit: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678' };
const NEW = { version: '2.10.0', commit: 'f4e5d6c7b8a90112233445566778899aabbccddee'.slice(0, 40) };
const NEWER = { version: '2.10.1', commit: '0123456789abcdef0123456789abcdef01234567' };

// One /api/dashboard-update answer. `update` overrides the update block.
function answer({ pid = 1, buildId = 'A', building = false, ...update } = {}) {
  return {
    data: {
      ok: true, pid, buildId, building,
      update: { available: true, canApply: true, ahead: 0, state: null, waitingFor: null, lastRun: null, running: RUN, target: NEW, id: NEW.commit, ...update },
    },
    isError: false,
    refetch: vi.fn(),
  };
}
const upToDate = (over = {}) => answer({ available: false, canApply: false, target: null, id: null, ...over });

const ui = (props = {}, locale = 'en') => (
  <I18nProvider locale={locale}>
    <TooltipProvider>
      <UpdateToast {...props} />
    </TooltipProvider>
  </I18nProvider>
);
const renderToast = (props, locale) => render(ui(props, locale));
// Keyboard focus (Tab) opens a Tip; a programmatic focus does not.
const tabTo = async (el) => { for (let i = 0; i < 10 && document.activeElement !== el; i += 1) await userEvent.tab(); };
const clickUpdate = async () => userEvent.click(screen.getByRole('button', { name: /^update$/i }));

let storage;
beforeEach(() => {
  storage = installStorage();
  status = upToDate();
  pollCalls.length = 0;
  news = null;
  seenCalls.length = 0;
});
afterEach(() => { vi.useRealTimers(); });

describe('UpdateToast: offer', () => {
  it('renders nothing when the running version is current', () => {
    const { container } = renderToast();
    expect(container).toBeEmptyDOMElement();
  });

  it('never offers the commit that is already running', () => {
    status = answer({ target: RUN, id: RUN.commit });
    const { container } = renderToast();
    expect(container).toBeEmptyDOMElement();
  });

  it('does not offer an update that cannot be applied (diverged or dirty before a pull)', () => {
    status = answer({ canApply: false, reason: 'dirty-tree' });
    const { container } = renderToast();
    expect(container).toBeEmptyDOMElement();
  });

  it('names the new version in one line, with no commit code', () => {
    status = answer();
    renderToast();
    expect(screen.getByText('pendpost 2.10.0 is ready')).toBeInTheDocument();
    expect(screen.queryByText(/a1b2c3d|f4e5d6c/)).toBeNull();
  });

  it('reads in de-CH too', () => {
    status = answer();
    renderToast({}, 'de-CH');
    expect(screen.getByText('pendpost 2.10.0 ist bereit')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /aktualisieren/i })).toBeInTheDocument();
  });

  it('the same version on a newer commit is "Small improvements ready"', () => {
    status = answer({ target: { version: RUN.version, commit: NEW.commit } });
    renderToast({}, 'de-CH');
    expect(screen.getByText('Kleine Verbesserungen bereit')).toBeInTheDocument();
  });

  it('an offer with no target version falls back to the plain sentence', () => {
    status = answer({ target: { version: null, commit: NEW.commit } });
    renderToast();
    expect(screen.getByText('A new version is available')).toBeInTheDocument();
  });

  it('formats the version alone, never the commit', () => {
    expect(formatVersion(RUN)).toBe('2.9.0');
    expect(formatVersion({ version: '2.9.0', commit: null })).toBe('2.9.0');
    expect(formatVersion({ version: null, commit: NEW.commit })).toBe(null);
    expect(formatVersion(null)).toBe(null);
  });

  it('has 44px tap targets, focus rings and a polite live region', () => {
    status = answer();
    renderToast();
    const toast = screen.getByRole('status');
    expect(toast).toHaveAttribute('aria-live', 'polite');
    for (const b of screen.getAllByRole('button')) {
      expect(b.className).toMatch(/after:h-11/);
      expect(b.className).toMatch(/after:min-w-11/);
      expect(b.className).toMatch(/focus-visible:ring-2/);
    }
  });
});

describe('UpdateToast: dismiss per commit', () => {
  it('a dismissal survives the next app open for the same commit', async () => {
    status = answer();
    const first = renderToast();
    await userEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(first.container).toBeEmptyDOMElement();
    first.unmount();
    const again = renderToast(); // the owner opens the app again
    expect(again.container).toBeEmptyDOMElement();
  });

  it('a newer commit shows the offer again', async () => {
    status = answer();
    const first = renderToast();
    await userEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    first.unmount();
    status = answer({ target: NEWER, id: NEWER.commit });
    renderToast();
    expect(screen.getByText('pendpost 2.10.1 is ready')).toBeInTheDocument();
  });

  it('still works when browser storage is blocked (dismissal holds for the page)', async () => {
    const blocked = () => { throw new Error('blocked'); };
    storage.getItem = blocked;
    storage.setItem = blocked;
    storage.removeItem = blocked;
    status = answer();
    const { container } = renderToast();
    await userEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(container).toBeEmptyDOMElement();
  });
});

describe('UpdateToast: progress', () => {
  it('Update -> the toast stays and says the update is starting, then polls fast', async () => {
    let resolve;
    const onUpdate = vi.fn(() => new Promise((r) => { resolve = r; }));
    status = answer();
    renderToast({ onUpdate });
    await clickUpdate();
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/starting the update/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^update$/i })).not.toBeInTheDocument();
    expect(pollCalls.at(-1)).toBe(true);
    await act(async () => { resolve({ ok: true, started: true, state: 'downloading' }); });
    expect(status.refetch).toHaveBeenCalled();
  });

  it('walks the real steps the server reports: downloading, installing, waiting, restarting', async () => {
    const onUpdate = vi.fn().mockResolvedValue({ ok: true, started: true });
    status = answer({ ahead: 2 });
    const { rerender } = renderToast({ onUpdate });
    await clickUpdate();
    const stepStates = () => [...screen.getByTestId('update-steps').children].map((c) => c.dataset.state).join(',');

    status = answer({ state: 'downloading' });
    rerender(ui({ onUpdate }));
    expect(screen.getByText(/downloading the update/i)).toBeInTheDocument();
    expect(stepStates()).toBe('current,todo,todo');

    status = answer({ state: 'installing' });
    rerender(ui({ onUpdate }));
    expect(screen.getByText(/installing the update/i)).toBeInTheDocument();
    expect(stepStates()).toBe('done,current,todo');

    status = answer({ state: 'waiting', waitingFor: 'publishing' });
    rerender(ui({ onUpdate }));
    expect(screen.getByText(/once publishing finishes/i)).toBeInTheDocument();
    expect(stepStates()).toBe('done,done,current');

    status = answer({ state: 'waiting', waitingFor: 'agent' });
    rerender(ui({ onUpdate }));
    expect(screen.getByText(/once the Radar agent finishes/i)).toBeInTheDocument();

    status = answer({ state: 'restarting' });
    rerender(ui({ onUpdate }));
    expect(screen.getByText(/restarting pendpost/i)).toBeInTheDocument();

    // The server is gone while it restarts: the last answer stays, the poll errors.
    status = { ...answer({ state: 'restarting' }), isError: true };
    rerender(ui({ onUpdate }));
    expect(screen.getByText(/restarting pendpost/i)).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('a tab opened mid-update shows the step too (no click in this tab)', () => {
    status = answer({ state: 'installing' });
    renderToast();
    expect(screen.getByText(/installing the update/i)).toBeInTheDocument();
  });

  it('never silently falls back to the offer while the update runs', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const onUpdate = vi.fn().mockResolvedValue({ ok: true, started: true });
    status = answer();
    const { rerender } = renderToast({ onUpdate });
    await act(async () => { screen.getByRole('button', { name: /^update$/i }).click(); });
    status = answer({ state: 'installing' });
    rerender(ui({ onUpdate }));
    await act(async () => { vi.advanceTimersByTime(120_000); });
    expect(screen.getByText(/installing the update/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^update$/i })).not.toBeInTheDocument();
  });

  it('the server had nothing to do: the toast goes away instead of spinning', async () => {
    const onUpdate = vi.fn().mockResolvedValue({ ok: true, started: false, reason: 'up-to-date' });
    status = answer();
    const { rerender, container } = renderToast({ onUpdate });
    await clickUpdate();
    status = upToDate();
    rerender(ui({ onUpdate }));
    expect(container).toBeEmptyDOMElement();
  });
});

describe('UpdateToast: done', () => {
  it('the server comes back on the new commit -> "Updated to", then it disappears', async () => {
    const onUpdate = vi.fn().mockResolvedValue({ ok: true, started: true });
    const onReload = vi.fn();
    status = answer();
    const { rerender, container } = renderToast({ onUpdate, onReload });
    await clickUpdate();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    status = upToDate({ pid: 2, running: NEW });
    rerender(ui({ onUpdate, onReload }));
    expect(screen.getByText('Updated to 2.10.0')).toBeInTheDocument();
    expect(onReload).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(4500); });
    expect(container).toBeEmptyDOMElement();
  });

  it('a new bundle reloads the page by itself, and the reloaded page says "Updated to"', async () => {
    const onUpdate = vi.fn().mockResolvedValue({ ok: true, started: true });
    const onReload = vi.fn();
    status = answer();
    const first = renderToast({ onUpdate, onReload });
    await clickUpdate();
    status = upToDate({ pid: 2, buildId: 'B', running: NEW });
    first.rerender(ui({ onUpdate, onReload }));
    expect(onReload).toHaveBeenCalledTimes(1);
    first.unmount(); // the reload
    renderToast();
    expect(screen.getByText('Updated to 2.10.0')).toBeInTheDocument();
    expect(storage.getItem('pendpost.update.done')).toBe(null);
  });

  it('an update survives a reload mid-way: the new page still sees it finish', async () => {
    const onUpdate = vi.fn().mockResolvedValue({ ok: true, started: true });
    status = answer();
    const first = renderToast({ onUpdate });
    await clickUpdate();
    first.unmount(); // the owner reloads while it installs
    status = { ...answer({ state: 'restarting' }), isError: true };
    const second = renderToast();
    expect(screen.getByText(/restarting pendpost/i)).toBeInTheDocument();
    status = upToDate({ pid: 2, running: NEW });
    second.rerender(ui());
    expect(screen.getByText('Updated to 2.10.0')).toBeInTheDocument();
  });

  it('after the update the same commit is never offered again', async () => {
    const onUpdate = vi.fn().mockResolvedValue({ ok: true, started: true });
    status = answer();
    const first = renderToast({ onUpdate });
    await clickUpdate();
    status = upToDate({ pid: 2, running: NEW });
    first.rerender(ui({ onUpdate }));
    first.unmount();
    // Even a server answer that still lists that commit as available stays hidden.
    status = answer({ pid: 2, running: NEW, target: NEW, id: NEW.commit });
    const again = renderToast();
    expect(again.container).toBeEmptyDOMElement();
  });
});

describe('UpdateToast: failure', () => {
  const failedRun = (step, at = new Date(Date.now() + 1000).toISOString()) => ({ ok: false, step, reason: `${step}-failed`, at, target: NEW.commit });

  it('names what failed in one sentence and offers Try again', async () => {
    const onUpdate = vi.fn().mockResolvedValue({ ok: true, started: true });
    status = answer();
    const { rerender } = renderToast({ onUpdate });
    await clickUpdate();
    status = answer({ lastRun: failedRun('build') });
    rerender(ui({ onUpdate }));
    expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'assertive');
    expect(screen.getByText(/failed to install/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(onUpdate).toHaveBeenCalledTimes(2);
  });

  it('open edits after a click: a calm wait that names the files, never "commit or stash"', async () => {
    const onUpdate = vi.fn().mockResolvedValue({ ok: true, started: true, state: 'installing' });
    status = answer();
    const { rerender } = renderToast({ onUpdate });
    await clickUpdate();
    status = answer({ state: 'waiting', waitingFor: 'edits', dirtyFiles: ['lib/a.mjs', 'app/src/B.jsx'] });
    rerender(ui({ onUpdate }));
    expect(screen.getByText(/waiting for the changes in progress/i)).toBeInTheDocument();
    expect(screen.queryByText(/commit or stash/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /try again/i })).toBeNull();
    expect(screen.queryByTestId('update-steps')).toBeNull();
    await tabTo(screen.getByRole('button', { name: 'Details' }));
    expect((await screen.findByRole('tooltip')).textContent).toContain('Changed files: lib/a.mjs, app/src/B.jsx');
  });

  it('a build failure shows the log tail behind the info icon', async () => {
    status = answer({ lastRun: { ...failedRun('build', '2020-01-01T00:00:00.000Z'), detail: 'vite: Could not resolve "jsdom"' } });
    renderToast();
    await tabTo(screen.getByRole('button', { name: 'Details' }));
    expect((await screen.findByRole('tooltip')).textContent).toContain('Could not resolve "jsdom"');
  });

  it('Try again visibly runs, and a repeat failure says "failed again" with the time', async () => {
    const onUpdate = vi.fn().mockResolvedValue({ ok: false, code: 'invalid_input' });
    status = answer();
    renderToast({ onUpdate });
    await clickUpdate();
    expect(await screen.findByText(/turned down the update request/i)).toBeInTheDocument();
    expect(screen.queryByText(/failed again/i)).toBeNull();
    let release;
    onUpdate.mockImplementationOnce(() => new Promise((r) => { release = r; }));
    await userEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(screen.getByText('Starting the update …')).toBeInTheDocument();
    release({ ok: false, code: 'invalid_input' });
    expect(await screen.findByText(/failed again at \d{1,2}:\d{2}/i, {}, { timeout: 2000 })).toBeInTheDocument();
  });

  it('the failure is still there after a reload (the server keeps it for that commit)', () => {
    status = answer({ lastRun: failedRun('pull', '2020-01-01T00:00:00.000Z') });
    renderToast();
    expect(screen.getByText(/could not download the update/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  it('a failure for an older commit is not shown against a newer offer', () => {
    status = answer({ target: NEWER, id: NEWER.commit, lastRun: failedRun('pull') });
    renderToast();
    expect(screen.queryByText(/could not download/i)).not.toBeInTheDocument();
    expect(screen.getByText('pendpost 2.10.1 is ready')).toBeInTheDocument();
  });

  it('Try again does not flash the previous failure', async () => {
    let resolve;
    const onUpdate = vi.fn(() => new Promise((r) => { resolve = r; }));
    status = answer({ lastRun: failedRun('build', new Date(Date.now() - 60_000).toISOString()) });
    renderToast({ onUpdate });
    await userEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(screen.queryByText(/failed to install/i)).not.toBeInTheDocument();
    expect(screen.getByText(/starting the update/i)).toBeInTheDocument();
    await act(async () => { resolve({ ok: true, started: true }); });
  });

  it('a refused request (no Studio token, 403) says so instead of hiding', async () => {
    const onUpdate = vi.fn().mockResolvedValue({ ok: false, code: 'owner_token_required' });
    status = answer();
    renderToast({ onUpdate });
    await clickUpdate();
    expect(await screen.findByText(/turned down the update request/i)).toBeInTheDocument();
  });

  it('an HTTP refusal without an ok field is a failure, never an endless "Starting"', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url, init) => (String(url).includes('dashboard-update') && init?.method === 'POST'
      ? new Response(JSON.stringify({ code: 'invalid_input', message: 'origin not allowed' }), { status: 403 })
      : new Response('{}', { status: 200 })));
    try {
      const body = await postDashboardUpdate();
      expect(body.ok).toBe(false);
    } finally { globalThis.fetch = realFetch; }
  });

  it('no answer at all (network) is a failure too', async () => {
    const onUpdate = vi.fn().mockResolvedValue(null);
    status = answer();
    renderToast({ onUpdate });
    await clickUpdate();
    expect(await screen.findByText(/turned down the update request/i)).toBeInTheDocument();
  });

  it('a restart that never comes back becomes a failure, not an endless spinner', async () => {
    const onUpdate = vi.fn().mockResolvedValue({ ok: true, started: true });
    status = answer();
    const { rerender } = renderToast({ onUpdate });
    await clickUpdate();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    status = { ...answer({ state: 'restarting' }), isError: true };
    rerender(ui({ onUpdate }));
    expect(screen.getByText(/restarting pendpost/i)).toBeInTheDocument();
    await act(async () => { vi.advanceTimersByTime(3 * 60_000 + 1000); });
    expect(screen.getByText(/did not come back after the restart/i)).toBeInTheDocument();
  });

  it('dismissing a failure hides it for that commit', async () => {
    status = answer({ lastRun: failedRun('build') });
    const first = renderToast();
    await userEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(first.container).toBeEmptyDOMElement();
    first.unmount();
    const again = renderToast();
    expect(again.container).toBeEmptyDOMElement();
  });
});

// A quiet offer (lib/self-update.mjs): only local commits moved and the version did
// not, so the server applies it by itself. The Studio shows no toast for it, nor for
// its progress or a refused try; after the restart a new bundle reloads the page by
// itself and the reloaded page says "Updated to", unless the owner is typing.
describe('UpdateToast: quiet local update', () => {
  const LOCAL = { version: RUN.version, commit: NEW.commit };
  const quietOffer = (over = {}) => answer({ quiet: true, target: LOCAL, id: LOCAL.commit, ...over });

  it('a quiet offer shows no toast', () => {
    status = quietOffer();
    const { container } = renderToast();
    expect(container).toBeEmptyDOMElement();
  });

  it('the quiet apply shows no progress, not even while it builds', () => {
    status = quietOffer({ state: 'installing', building: true });
    const { container, rerender } = renderToast();
    expect(container).toBeEmptyDOMElement();
    status = quietOffer({ state: 'waiting', waitingFor: 'agent' });
    rerender(ui());
    expect(container).toBeEmptyDOMElement();
    status = quietOffer({ state: 'restarting' });
    rerender(ui());
    expect(container).toBeEmptyDOMElement();
  });

  it('a failed quiet apply never shows, even once the offer stops being quiet', () => {
    const quietRun = { ok: false, step: 'build', reason: 'build-failed', quiet: true, at: '2026-11-01T12:00:00.000Z', target: LOCAL.commit };
    status = quietOffer({ lastRun: quietRun });
    const { container, rerender } = renderToast();
    expect(container).toBeEmptyDOMElement();
    // A dirty tree used to flip `quiet` off and surface the refusal the owner never asked for.
    status = quietOffer({ quiet: false, lastRun: quietRun });
    rerender(ui());
    expect(screen.queryByText(/failed|uncommitted|commit or stash/i)).toBeNull();
  });

  it('a quiet wait for open edits shows nothing', () => {
    status = quietOffer({ state: 'waiting', waitingFor: 'edits', dirtyFiles: ['lib/a.mjs'] });
    const { container } = renderToast();
    expect(container).toBeEmptyDOMElement();
  });

  it('after the quiet restart a new bundle reloads by itself and says "Updated to"', () => {
    const onReload = vi.fn();
    status = quietOffer();
    const first = renderToast({ onReload });
    status = upToDate({ pid: 2, buildId: 'B', running: LOCAL });
    first.rerender(ui({ onReload }));
    expect(onReload).toHaveBeenCalledTimes(1);
    first.unmount(); // the reload
    renderToast();
    expect(screen.getByText('Updated to 2.9.0')).toBeInTheDocument();
  });

  it('the reload also happens when this tab missed the progress (asleep in the background)', () => {
    const onReload = vi.fn();
    status = quietOffer();
    const { rerender } = renderToast({ onReload });
    // A newer local commit already waits quietly on the restarted server.
    status = quietOffer({ pid: 2, buildId: 'B', running: LOCAL, target: { version: RUN.version, commit: NEWER.commit }, id: NEWER.commit });
    rerender(ui({ onReload }));
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it('no new bundle -> no reload and no note', () => {
    const onReload = vi.fn();
    status = quietOffer();
    const { container, rerender } = renderToast({ onReload });
    status = upToDate({ pid: 2, running: LOCAL });
    rerender(ui({ onReload }));
    expect(onReload).not.toHaveBeenCalled();
    expect(container).toBeEmptyDOMElement();
  });

  it('never reloads under the owner while they type: the usual Reload offer instead', () => {
    const onReload = vi.fn();
    const input = document.createElement('textarea');
    document.body.appendChild(input);
    input.focus();
    try {
      status = quietOffer();
      const { rerender } = renderToast({ onReload });
      status = upToDate({ pid: 2, buildId: 'B', running: LOCAL });
      rerender(ui({ onReload }));
      expect(onReload).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: /reload/i })).toBeInTheDocument();
    } finally {
      input.remove();
    }
  });

  it('a new version is still offered with the toast', () => {
    status = answer({ quiet: false });
    renderToast();
    expect(screen.getByText('pendpost 2.10.0 is ready')).toBeInTheDocument();
  });
});

describe('UpdateToast: other states', () => {
  it('asks for a manual restart when the server cannot restart itself', () => {
    status = answer({ available: false, state: 'manual' });
    renderToast();
    expect(screen.getByText(/restart pendpost to finish/i)).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('a background rebuild shows "preparing", and its new bundle offers Reload', async () => {
    const onReload = vi.fn();
    status = upToDate({ building: true });
    const { rerender } = renderToast({ onReload }, 'de-CH');
    expect(screen.getByText(/wird vorbereitet/i)).toBeInTheDocument();
    status = upToDate({ buildId: 'B' });
    rerender(ui({ onReload }, 'de-CH'));
    await userEvent.click(screen.getByRole('button', { name: /neu laden/i }));
    expect(onReload).toHaveBeenCalledTimes(1);
  });
});

describe('UpdateToast: what is new', () => {
  const N210 = NOTE('2.10.0', ['Bulk actions in the List.', 'A tray groups problems.'], ['Mehrere Beiträge auf einmal.', 'Eine Leiste fasst Probleme zusammen.']);
  const N290 = NOTE('2.9.0', ['Clear refusals.'], ['Klare Absagen.']);

  it('shows nothing when there are no unseen notes', () => {
    news = newsFor('2.10.0', []);
    const { container } = renderToast();
    expect(container).toBeEmptyDOMElement();
  });

  it('says "Updated to" with What\'s new, which opens the unseen notes newest first', async () => {
    news = newsFor('2.10.0', [N210, N290]);
    renderToast();
    expect(screen.getByRole('status')).toHaveTextContent('Updated to 2.10.0');
    await userEvent.click(screen.getByRole('button', { name: "What's new" }));
    const dialog = screen.getByRole('dialog', { name: "What's new" });
    const headings = within(dialog).getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(headings).toEqual(['2.10.0', '2.9.0']);
    expect(dialog).toHaveTextContent('Bulk actions in the List.');
    expect(within(dialog).getByRole('link', { name: 'All releases' })).toHaveAttribute('href', 'https://example.test/releases');
    // The toast steps aside while its dialog is open.
    expect(screen.queryByRole('status')).toBeNull();
    expect(seenCalls).toEqual([]);
  });

  it('closing the notes remembers the version and the toast does not come back', async () => {
    news = newsFor('2.10.0', [N210]);
    renderToast();
    await userEvent.click(screen.getByRole('button', { name: "What's new" }));
    // The glyph top-right (the backdrop is a Close button too).
    await userEvent.click(within(screen.getByRole('dialog')).getAllByRole('button', { name: 'Close' }).at(-1));
    expect(seenCalls).toEqual(['2.10.0']);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('dismissing the toast remembers the version without opening anything', async () => {
    news = newsFor('2.10.0', [N210]);
    renderToast();
    await userEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(seenCalls).toEqual(['2.10.0']);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('an update offer or a failure wins over the notes', () => {
    news = newsFor('2.10.0', [N210]);
    status = answer({ running: { version: '2.10.0', commit: RUN.commit }, target: NEWER, id: NEWER.commit });
    renderToast();
    expect(screen.getByRole('status')).toHaveTextContent('pendpost 2.10.1 is ready');
    expect(screen.queryByRole('button', { name: "What's new" })).toBeNull();
  });

  it('takes the place of the short "Updated to" note and stays until acted on', () => {
    vi.useFakeTimers();
    storage.setItem('pendpost.update.done', JSON.stringify({ ...NEW, at: Date.now() }));
    news = newsFor('2.10.0', [N210]);
    renderToast();
    expect(screen.getByRole('button', { name: "What's new" })).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(screen.getByRole('status')).toHaveTextContent('Updated to 2.10.0');
    expect(screen.getByRole('button', { name: "What's new" })).toBeInTheDocument();
  });

  it('reads in de-CH, items included', async () => {
    news = newsFor('2.10.0', [N210]);
    renderToast({}, 'de-CH');
    expect(screen.getByRole('status')).toHaveTextContent('Aktualisiert auf 2.10.0');
    await userEvent.click(screen.getByRole('button', { name: 'Neuerungen' }));
    const dialog = screen.getByRole('dialog', { name: 'Neuerungen' });
    expect(dialog).toHaveTextContent('Mehrere Beiträge auf einmal.');
    expect(dialog).toHaveTextContent('2. November 2026');
  });
});
