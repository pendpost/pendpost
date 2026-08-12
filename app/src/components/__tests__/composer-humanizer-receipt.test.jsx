import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Composer, { LintPanel } from '../Composer.jsx';
import HumanizerReceipt from '../HumanizerReceipt.jsx';
import { updatePost } from '../../lib/api.js';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// R6b humanizer receipt (dim-6 P4/C2): the always-on humanizer gate rewrites
// prose at save, and until now the author was never told what changed. The
// create/update response carries {fixes, findings} (lib/writes.mjs); the
// Composer threads it to onSaved, and the App shell shows ONE quiet dismissable
// line. No per-post receipt store, no diffs (net-simplify ruling).
vi.mock('../../lib/api.js', () => ({
  useActiveClient: () => ({ activeClient: null, activeClientId: null }),
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
      <I18nProvider>
        <TooltipProvider>
          <ConfirmProvider>{ui}</ConfirmProvider>
        </TooltipProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

function editPost(extra = {}) {
  return {
    id: 'p1',
    campaign: 'launch',
    type: 'text',
    platforms: ['instagram'],
    approval: 'draft',
    derivedState: 'scheduled',
    scheduledAt: '2026-07-01T10:00:00Z',
    caption: 'Hello there',
    rev: 1,
    media: { file: null, exists: false, url: null, cover: null, path: null },
    ...extra,
  };
}

beforeEach(() => {
  vi.mocked(updatePost).mockClear();
});

describe('HumanizerReceipt - the quiet post-save line', () => {
  it('names each fix kind with its count, in plain language', () => {
    wrap(
      <HumanizerReceipt
        fixes={[{ kind: 'em-dash', count: 2 }, { kind: 'curly-quote', count: 3 }]}
        onDismiss={vi.fn()}
      />,
    );
    const line = screen.getByRole('status');
    expect(line).toHaveTextContent('Auto-fixed: 2 em dashes, 3 quotes straightened');
  });

  it('uses singular phrasing for a single occurrence, and covers the eszett kind', () => {
    wrap(
      <HumanizerReceipt
        fixes={[{ kind: 'em-dash', count: 1 }, { kind: 'eszett', count: 1 }]}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Auto-fixed: 1 em dash, 1 eszett written as ss');
  });

  it('renders NOTHING when the save was clean (no fixes)', () => {
    const { container } = wrap(<HumanizerReceipt fixes={[]} onDismiss={vi.fn()} />);
    expect(container.querySelector('[role="status"]')).toBeNull();
    const empty = wrap(<HumanizerReceipt fixes={null} onDismiss={vi.fn()} />);
    expect(empty.container.querySelector('[role="status"]')).toBeNull();
  });

  it('is dismissable: the close button fires onDismiss', async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    wrap(<HumanizerReceipt fixes={[{ kind: 'em-dash', count: 2 }]} onDismiss={onDismiss} />);
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onDismiss).toHaveBeenCalled();
  });
});

describe('Composer - threads the response receipt to onSaved', () => {
  it('passes the humanizer report as the third onSaved argument when the response carries one', async () => {
    const user = userEvent.setup();
    const humanizer = { fixes: [{ kind: 'em-dash', count: 2 }], findings: [] };
    vi.mocked(updatePost).mockResolvedValueOnce({ ok: true, post: {}, rev: 2, humanizer });
    const onSaved = vi.fn();
    wrap(
      <Composer
        mode="edit"
        post={editPost()}
        campaigns={[{ id: 'launch', active: true, posts: [] }]}
        onClose={vi.fn()}
        onSaved={onSaved}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSaved).toHaveBeenCalledWith('launch', 'p1', humanizer);
  });

  it('passes no receipt when the save response is clean (absence when clean)', async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    wrap(
      <Composer
        mode="edit"
        post={editPost()}
        campaigns={[{ id: 'launch', active: true, posts: [] }]}
        onClose={vi.fn()}
        onSaved={onSaved}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSaved).toHaveBeenCalledWith('launch', 'p1', undefined);
  });
});

describe('LintPanel - em-dash warn is display-filtered (guaranteed auto-fix)', () => {
  const emDash = { rule: 'em-dash', severity: 'warn', match: '—', index: 4, hint: 'Em/en dashes are a tell.' };
  const vocab = { rule: 'ai-vocab', severity: 'warn', match: 'delve', index: 0, hint: 'Classic AI-vocabulary.' };

  it('shows the clean line when em-dash is the only finding (the save fixes it anyway)', () => {
    wrap(<LintPanel lint={{ ok: true, clean: true, errors: 0, warnings: 1, findings: [emDash], truncated: false }} />);
    expect(screen.getByText('Post text is clean (brand rules).')).toBeInTheDocument();
    expect(screen.queryByText(/Em\/en dashes/)).not.toBeInTheDocument();
  });

  it('keeps every other finding while dropping the em-dash rows', () => {
    wrap(<LintPanel lint={{ ok: true, clean: true, errors: 0, warnings: 2, findings: [emDash, vocab], truncated: false }} />);
    expect(screen.getByText(/Classic AI-vocabulary/)).toBeInTheDocument();
    expect(screen.queryByText(/Em\/en dashes/)).not.toBeInTheDocument();
  });
});
