import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi } from 'vitest';
import Composer from '../Composer.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';

// r2-1 / r2-3: the X tweet-text counter must not signal over-limit by COLOR ALONE
// (WCAG 1.4.1) and must not re-announce the full count on every keystroke. Over
// limit it pairs the red color with a lucide AlertTriangle icon + an over-limit
// word + an sr-only severity; the visible count is reachable via
// aria-describedby (NOT a live region), and a SEPARATE polite status region
// announces only the over/under transition. These assertions are structural so
// they survive the orchestrator's central locale merge (new keys may resolve to
// their raw id in isolation).

vi.mock('../ui/confirm.jsx', async (orig) => {
  const actual = await orig();
  return {
    ...actual,
    ConfirmProvider: ({ children }) => children,
    useConfirm: () => vi.fn(() => Promise.resolve(true)),
  };
});

vi.mock('../../lib/api.js', () => ({
  useActiveClient: () => ({ activeClient: null, activeClientId: null }),
  useAssets: () => ({ data: { assets: [], dir: '/tmp/assets' } }),
  useConfig: () => ({ data: { posting: { hashtagPresets: [] } } }),
  usePlatformValidate: () => ({ data: undefined }),
  useValidateMedia: () => ({ data: undefined }),
  createPost: vi.fn(() => Promise.resolve({ ok: true })),
  updatePost: vi.fn(() => Promise.resolve({ ok: true })),
  lintText: vi.fn(() => Promise.resolve({ ok: true, clean: true, findings: [] })),
}));

function renderComposer(props = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <Composer
          mode="create"
          post={null}
          campaigns={[{ id: 'launch', active: true, posts: [] }]}
          onClose={vi.fn()}
          onSaved={vi.fn()}
          {...props}
        />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

// Reveal the X-only tweet-text field by selecting the X platform.
async function showXField(user) {
  await user.click(screen.getByRole('button', { name: 'X' }));
  return screen.findByLabelText('Tweet text (X)');
}

describe('Composer X tweet-text counter signals over-limit beyond color (r2-1/r2-3)', () => {
  it('under the limit: neutral counter, no warning icon, no live region', async () => {
    const user = userEvent.setup();
    renderComposer();
    await showXField(user);

    const counter = document.getElementById('composer-x-counter');
    expect(counter).toBeInTheDocument();
    // Color-only is not the sole signal: under limit there is NO icon at all.
    expect(counter.querySelector('svg')).toBeNull();
    expect(counter).not.toHaveClass('text-red-600');
    // r2-3: the visible counter is NOT a live region (reachable via describedby).
    expect(counter).not.toHaveAttribute('aria-live');
    const textarea = screen.getByLabelText('Tweet text (X)');
    expect(textarea).toHaveAttribute('aria-describedby', 'composer-x-counter');
  });

  it('over the limit: pairs red color with an icon + sr-only severity', async () => {
    const user = userEvent.setup();
    renderComposer();
    const textarea = await showXField(user);

    await user.click(textarea);
    await user.paste('a'.repeat(281));

    const counter = document.getElementById('composer-x-counter');
    await waitFor(() => expect(counter).toHaveClass('text-red-600'));
    // Color is paired with an icon (the lucide AlertTriangle svg) ...
    expect(counter.querySelector('svg')).not.toBeNull();
    // ... and an sr-only severity span so a non-sighted operator hears it.
    expect(within(counter).getByText((_, el) => el?.classList.contains('sr-only'))).toBeInTheDocument();
    // Still not a live region on the count itself.
    expect(counter).not.toHaveAttribute('aria-live');
  });

  it('announces the over-limit transition in a separate polite status region', async () => {
    const user = userEvent.setup();
    renderComposer();
    const textarea = await showXField(user);

    // The dedicated announce region exists and is a polite sr-only status node,
    // separate from the visible counter <p id="composer-x-counter">.
    const region = document.querySelector('p[role="status"][aria-live="polite"].sr-only');
    expect(region).toBeInTheDocument();
    expect(region.id).not.toBe('composer-x-counter');
    // Empty until the limit is crossed (no per-keystroke chatter under limit).
    expect(region.textContent).toBe('');

    await user.click(textarea);
    await user.paste('a'.repeat(281));
    // Crossing the limit populates the transition announcement.
    await waitFor(() => expect(region.textContent.length).toBeGreaterThan(0));
  });
});
