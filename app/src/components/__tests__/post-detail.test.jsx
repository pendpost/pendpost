import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { axeClean } from '../../test-utils/axe.js';
import PostDetail from '../PostDetail.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// B3: PostDetail full useT migration. Every user-facing literal flows through
// the translator under postDetail.* (reusing approvals.* where it fits). The
// locale guard only catches statically-resolvable translator keys absent from
// en.json - it CANNOT see an un-migrated hardcoded English literal. This render
// test is the completeness backstop: locale='en' => no raw key id is visible
// (no leftover 'postDetail.' text) AND the prior English copy still renders
// verbatim; locale='de-CH' => a backfilled string renders in German and a
// deliberately-omitted key silently falls back to English.
const accountsState = { data: { meta: { paused: false } } };

vi.mock('../../lib/api.js', () => ({
  useActiveClient: () => ({ activeClient: { id: 'acme', displayName: 'Acme Retail', accent: '#22566d' }, activeClientId: 'acme' }),
  useAccounts: () => accountsState,
  usePlatformValidate: () => ({ data: undefined }),
  useValidateMedia: () => ({ data: undefined }),
  approvePost: vi.fn(),
  rejectPost: vi.fn(),
  deletePost: vi.fn(),
  unschedulePost: vi.fn(),
  reschedulePost: vi.fn(),
  markPosted: vi.fn(),
  verifyPost: vi.fn(),
  setCoverFrame: vi.fn(),
  uploadCover: vi.fn(),
  clearCover: vi.fn(),
}));

const basePost = {
  id: 'p1',
  campaign: 'spring',
  title: 'Spring promo',
  caption: 'A caption',
  firstComment: 'First comment text',
  approvalNote: 'Tighten the hook',
  platforms: ['instagram', 'facebook'],
  approval: 'pending',
  derivedState: 'scheduled',
  scheduledAt: '2026-07-01T10:00:00Z',
  type: 'reel',
  rev: 1,
  executionMode: 'fully-scheduled',
  image: null,
  ids: {},
  cover: null,
  publishedVia: null,
  externalUrl: null,
  verify: null,
  media: { file: 'reel.mp4', exists: true, bytes: 1000, url: '/media?p=reel.mp4', cover: '/media?p=reel.jpg', path: 'reel.mp4' },
};

function renderDetail({ post = basePost, locale = 'en' } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale={locale}>
        <TooltipProvider>
          <ConfirmProvider>
            <PostDetail post={post} onClose={() => {}} onEdit={() => {}} />
          </ConfirmProvider>
        </TooltipProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  accountsState.data = { meta: { paused: false } };
});

describe('PostDetail i18n migration (en)', () => {
  it('renders the prior English Section titles verbatim', () => {
    renderDetail();
    expect(screen.getByText('Platforms')).toBeInTheDocument();
    expect(screen.getByText('Caption')).toBeInTheDocument();
    // First comment / Approval note / File are shown inline (no disclosure toggle).
    expect(screen.getByText('First comment')).toBeInTheDocument();
    expect(screen.getByText('Approval note')).toBeInTheDocument();
    expect(screen.getByText('File')).toBeInTheDocument();
  });

  it('renders the Approve/Reject/Delete actions with English labels from t()', async () => {
    const user = userEvent.setup();
    renderDetail();
    // Approve is the one visible primary; Reject + Delete live in the ⋯ overflow.
    expect(screen.getByRole('button', { name: /approve/i })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /more actions/i }));
    expect(screen.getByRole('button', { name: /reject/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /delete post/i })).toBeInTheDocument();
  });

  it('renders the per-client band naming the active client in the SlideOver header (B4)', () => {
    renderDetail();
    // The active client appears as signage; the post title still renders too.
    expect(screen.getAllByText('Acme Retail').length).toBeGreaterThan(0);
  });

  it('the delete confirm NAMES the active client (B4 criterion 4)', async () => {
    const user = userEvent.setup();
    renderDetail();
    // Delete lives in the ⋯ overflow now: open it, then click the menu item.
    await user.click(screen.getByRole('button', { name: /more actions/i }));
    await user.click(screen.getByRole('button', { name: /delete post/i }));
    // PostDetail itself is a Modal (role=dialog "Post p1"); target the CONFIRM
    // dialog specifically (its title is the accessible name) so we assert the
    // delete confirmation - not the panel behind it - names the active client.
    const dialog = await screen.findByRole('dialog', { name: /delete post/i });
    expect(dialog).toHaveTextContent(/Acme Retail/);
  });

  it('shows the campaign meta line with the schedule (placeholder interpolation)', () => {
    renderDetail();
    // scheduledFor {when} + campaignMeta {campaign}{id}{type} are interpolated,
    // not shown as raw braces. The reused approvals.card.campaignMeta key renders
    // "Campaign: Spring · p1 · Reel".
    expect(screen.queryByText(/\{when\}/)).not.toBeInTheDocument();
    expect(screen.queryByText(/\{campaign\}/)).not.toBeInTheDocument();
    expect(screen.getByText(/Campaign: Spring · p1 · Reel/)).toBeInTheDocument();
  });

  it('leaks no raw key id anywhere in the rendered SlideOver', () => {
    const { container } = renderDetail();
    // No leftover "postDetail.*" / "approvals.*" raw key id text.
    expect(screen.queryByText(/postDetail\./)).toBeNull();
    expect(container.textContent).not.toMatch(/postDetail\./);
    expect(container.textContent).not.toMatch(/approvals\.[a-z]/);
  });

  it('surfaces the Meta-paused notice copy from t() when the lane is paused', () => {
    accountsState.data = { meta: { paused: true, pauseReason: 'manual hold' } };
    renderDetail();
    expect(screen.getByText(/Meta lane is paused/i)).toBeInTheDocument();
    expect(screen.getByText('manual hold')).toBeInTheDocument();
  });
});

describe('PostDetail i18n migration (de-CH)', () => {
  it('renders a backfilled German Section title', () => {
    renderDetail({ locale: 'de-CH' });
    // postDetail.section.platforms is backfilled in de-CH.
    expect(screen.getByText('Plattformen')).toBeInTheDocument();
  });

  it('renders the de-CH backfill for every postDetail section and never a raw key id', () => {
    renderDetail({ locale: 'de-CH' });
    // Every postDetail.* section title is backfilled in de-CH, so the German
    // string renders - never blank, never a raw key id. Caption and the inline
    // detail rows (first comment) are shown directly - no disclosure toggle.
    expect(screen.getByText('Bildtext')).toBeInTheDocument(); // postDetail.section.caption
    expect(screen.getByText('Erster Kommentar')).toBeInTheDocument(); // postDetail.section.firstComment
    expect(screen.queryByText(/postDetail\./)).toBeNull();
  });

  it('uses real Swiss-German orthography in the backfilled de-CH strings (never an eszett)', () => {
    const { container } = renderDetail({ locale: 'de-CH' });
    // Mandate A: real umlauts ä/ö/ü are now correct; the eszett ß is never used.
    expect(container.textContent).not.toMatch(/ß/);
  });
});

describe('PostDetail accessibility', () => {
  it('has no axe violations on the rendered SlideOver (en)', async () => {
    const { container } = renderDetail();
    expect(await axeClean(container)).toHaveNoViolations();
  });

  it('has no axe violations on the rendered SlideOver (de-CH)', async () => {
    const { container } = renderDetail({ locale: 'de-CH' });
    expect(await axeClean(container)).toHaveNoViolations();
  });
});
