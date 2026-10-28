import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import PostDetail from '../PostDetail.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// #43: an approved post shows when its approval ages out ("Approval expires in 5
// hours") on the identity line, only while posting.approvalExpiryHours is set. The
// setting itself stays config/MCP only (owner decision 2026-10-28).
let configData = null;

vi.mock('../../lib/api.js', () => ({
  useInsights: () => ({ data: undefined }),
  useActiveClient: () => ({ activeClient: { id: 'acme', displayName: 'Acme Retail', accent: '#22566d' }, activeClientId: 'acme' }),
  usePendpostHealth: () => ({ data: { setup: { platforms: [] } } }),
  useConfig: () => ({ data: configData }),
  useAccounts: () => ({ data: { meta: { paused: false } } }),
  usePlatformValidate: () => ({ data: undefined }),
  useRedditFlairs: () => ({ data: undefined, isLoading: false }),
  usePresubmitCheck: () => ({ data: undefined }),
  useValidateMedia: () => ({ data: undefined }),
  useAssets: () => ({ data: { dir: 'data/media', assets: [] } }),
  approvePost: vi.fn(),
  rejectPost: vi.fn(),
  runPublishDue: vi.fn(),
  deletePost: vi.fn(),
  unschedulePost: vi.fn(),
  reschedulePost: vi.fn(),
  markPosted: vi.fn(),
  verifyPost: vi.fn(),
  setCoverFrame: vi.fn(),
  uploadCover: vi.fn(),
  clearCover: vi.fn(),
  updatePost: vi.fn(),
  editPublished: vi.fn(),
  discordScheduleEvent: vi.fn(),
  mastodonPin: vi.fn(),
}));

const HOUR = 3600 * 1000;
const approvedPost = {
  id: 'p1',
  campaign: 'launch',
  caption: 'Hello world',
  platforms: ['telegram'],
  approval: 'approved',
  approvalAt: new Date(Date.now() - HOUR).toISOString(),
  derivedState: 'waiting-due',
  status: 'planned',
  scheduledAt: new Date(Date.now() + 48 * HOUR).toISOString(),
  type: 'text',
  rev: 1,
  executionMode: 'fully-scheduled',
  image: null,
  ids: {},
  cover: null,
  publishedVia: null,
  externalUrl: null,
  verify: null,
  media: { file: null, exists: false, bytes: 0, url: null, cover: null, path: null },
};

function renderDetail(post, locale = 'en') {
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

beforeEach(() => { configData = null; });

describe('PostDetail approval expiry line (#43)', () => {
  it('shows when the approval expires on an approved post while an expiry is set', () => {
    configData = { ok: true, posting: { approvalExpiryHours: 72 } };
    renderDetail(approvedPost);
    expect(screen.getByText('Approval expires in 3 days')).toBeInTheDocument();
  });

  it('stays silent without an expiry setting', () => {
    renderDetail(approvedPost);
    expect(screen.queryByText(/approval expires/i)).not.toBeInTheDocument();
  });

  it('stays silent on a post that is not approved', () => {
    configData = { ok: true, posting: { approvalExpiryHours: 6 } };
    renderDetail({ ...approvedPost, approval: 'pending' });
    expect(screen.queryByText(/approval expires/i)).not.toBeInTheDocument();
  });

  it('stays silent on a post handed off to the platform scheduler', () => {
    configData = { ok: true, posting: { approvalExpiryHours: 6 } };
    renderDetail({ ...approvedPost, platforms: ['youtube'], status: 'scheduled', ids: { ytVideoId: 'abc' } });
    expect(screen.queryByText(/approval expires/i)).not.toBeInTheDocument();
  });

  // The approval lapses BEFORE the slot: the post drops back to review before it can publish,
  // so the line warns (amber) and names the two ways out instead of reading neutrally.
  it('warns when the approval lapses before the scheduled slot', () => {
    configData = { ok: true, posting: { approvalExpiryHours: 6 } };
    renderDetail(approvedPost, 'de-CH');
    const line = screen.getByText('Freigabe verfällt vor dem Termin (in 5 Stunden). Gib den Beitrag dann nochmals frei oder plane ihn früher.').closest('p');
    expect(line).toHaveClass('text-amber-700');
    // Never colour alone: the warning carries the house warning glyph.
    expect(line.querySelector('svg.lucide-triangle-alert, svg.lucide-alert-triangle')).not.toBeNull();
    expect(line).toHaveAttribute('data-approval-expiry', 'before-slot');
  });

  it('stays neutral when the approval outlives the slot', () => {
    configData = { ok: true, posting: { approvalExpiryHours: 72 } };
    renderDetail(approvedPost);
    const line = screen.getByText('Approval expires in 3 days').closest('p');
    expect(line).not.toHaveClass('text-amber-700');
    // The same place as the warning: its own line under the identity row, with its own glyph.
    expect(line).toHaveAttribute('data-approval-expiry', 'ok');
    expect(line.querySelector('svg')).not.toBeNull();
    expect(screen.queryByText(/before the slot/)).toBeNull();
  });
});
