import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Composer from '../Composer.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// US-CFG-12: on a brand-new project the Composer campaign <select> is empty, so
// `campaign` is '' and createPost('', ...) silently fails. save() must refuse and
// surface an error instead, and the select must show a placeholder so the empty
// state is visible.
const createPost = vi.fn(() => Promise.resolve({ ok: true }));

vi.mock('../../lib/api.js', () => ({
  useActiveClient: () => ({ activeClient: null, activeClientId: null }),
  useAssets: () => ({ data: { assets: [], dir: '/tmp/assets' } }),
  useConfig: () => ({ data: { posting: { hashtagPresets: [] } } }),
  usePlatformValidate: () => ({ data: undefined }),
  useValidateMedia: () => ({ data: undefined }),
  createPost: (...a) => createPost(...a),
  updatePost: vi.fn(() => Promise.resolve({ ok: true })),
  lintText: vi.fn(() => Promise.resolve({ ok: true, clean: true, findings: [] })),
}));

function renderCreate(campaigns) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale="en">
        <TooltipProvider>
          <ConfirmProvider>
            <Composer mode="create" post={null} campaigns={campaigns} onClose={vi.fn()} onSaved={vi.fn()} />
          </ConfirmProvider>
        </TooltipProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => createPost.mockClear());

describe('Composer campaign guard (US-CFG-12)', () => {
  it('refuses to create a post when no campaign is selected, showing an error', async () => {
    const user = userEvent.setup();
    renderCreate([]); // empty workspace -> campaign === ''
    await user.click(screen.getByRole('button', { name: /create draft/i }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(createPost).not.toHaveBeenCalled();
  });

  it('offers a disabled placeholder option in the campaign select', () => {
    renderCreate([]);
    const select = screen.getByLabelText('Campaign');
    const placeholder = select.querySelector('option[value=""]');
    expect(placeholder).toBeTruthy();
    expect(placeholder).toBeDisabled();
  });

  it('moves focus to the campaign select when the no-campaign guard fires', async () => {
    const user = userEvent.setup();
    renderCreate([]); // empty workspace -> campaign === ''
    await user.click(screen.getByRole('button', { name: /create draft/i }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByLabelText('Campaign')).toHaveFocus();
  });

  it('moves focus to the first platform toggle when the no-platforms guard fires', async () => {
    const user = userEvent.setup();
    renderCreate([{ id: 'launch', active: true, posts: [] }]); // campaign ok
    // Deselect the only (default Instagram) platform so platforms is empty.
    await user.click(screen.getByRole('button', { name: 'Instagram' }));
    await user.click(screen.getByRole('button', { name: /create draft/i }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    // The fieldset's first toggle (Facebook, first in PLATFORMS order) receives
    // focus, not just the alert, so a keyboard user lands on the blocking field.
    expect(screen.getByRole('button', { name: 'Facebook' })).toHaveFocus();
  });
});
