import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import UpdateToast from '../UpdateToast.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// UpdateToast polls the dashboard build status (GET /api/health -> buildId,
// building) and behaves like a desktop app's updater: a subtle branded
// "preparing update" indicator while a background rebuild runs, then an
// "update available - reload" prompt once a new bundle (new buildId) is served.
// We mock the hook so the tests drive the states directly.
let status;
vi.mock('../../lib/api.js', () => ({
  useBuildStatus: () => status,
}));

function renderToast(props = {}, locale = 'de-CH') {
  return render(
    <I18nProvider locale={locale}>
      <UpdateToast {...props} />
    </I18nProvider>,
  );
}

beforeEach(() => { status = { data: { buildId: 'A', building: false } }; });

describe('UpdateToast', () => {
  it('renders nothing when the bundle is current and no build is running', () => {
    status = { data: { buildId: 'A', building: false } };
    const { container } = renderToast();
    expect(container).toBeEmptyDOMElement();
  });

  it('shows a branded "preparing update" indicator while a rebuild is in progress', () => {
    status = { data: { buildId: 'A', building: true } };
    renderToast();
    expect(screen.getByText(/wird vorbereitet/i)).toBeInTheDocument();
  });

  it('prompts to reload once a new bundle (changed buildId) is served', async () => {
    const onReload = vi.fn();
    status = { data: { buildId: 'A', building: true } };
    const { rerender } = renderToast({ onReload });
    // background build finishes -> server now serves a new buildId
    status = { data: { buildId: 'B', building: false } };
    rerender(
      <I18nProvider locale="de-CH">
        <UpdateToast onReload={onReload} />
      </I18nProvider>,
    );
    expect(screen.getByText(/neue Version/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /neu laden/i }));
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it('renders the English copy under the en locale', () => {
    status = { data: { buildId: 'A', building: true } };
    renderToast({}, 'en');
    expect(screen.getByText(/preparing update/i)).toBeInTheDocument();
  });

  it('offers a one-click GitHub update when upstream is ahead and fast-forwardable', async () => {
    const onUpdate = vi.fn();
    status = { data: { buildId: 'A', building: false, update: { available: true, canPull: true, ahead: 2 } } };
    renderToast({ onUpdate });
    expect(screen.getByText(/neue Version ist verfügbar/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /aktualisieren/i }));
    expect(onUpdate).toHaveBeenCalledTimes(1);
    // Optimistic feedback: the toast flips to "preparing" immediately, before the
    // next poll observes the rebuild - so the click never looks like a no-op.
    expect(screen.getByText(/wird vorbereitet/i)).toBeInTheDocument();
  });

  it('does NOT offer the one-click update when a pull is not fast-forwardable', () => {
    status = { data: { buildId: 'A', building: false, update: { available: true, canPull: false, reason: 'dirty-tree' } } };
    const { container } = renderToast();
    expect(container).toBeEmptyDOMElement();
  });
});
