import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import PostDetail from '../PostDetail.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// The vanishing-chip defect: the quick-edit platform picker derived its rendered set from
// the LIVE draft selection (visiblePlatforms ∪ platformsDraft). For a post targeting a lane
// the owner has not connected (exactly the hand-off case), one deselect click removed the
// lane from both sets, so the chip unrendered - a control that deletes itself on first use,
// with no way to re-select. The picker union must come from the post's ORIGINAL targets:
// deselect un-highlights, the chip stays, the toggle stays reversible.
const healthState = { data: { setup: { platforms: [{ platform: 'reddit', status: 'incomplete' }] } } };
const accountsState = { data: { meta: { paused: false } } };

vi.mock('../../lib/api.js', () => ({
  useInsights: () => ({ data: undefined }),
  useActiveClient: () => ({ activeClient: null, activeClientId: null }),
  usePendpostHealth: () => healthState,
  useConfig: () => ({ data: null }),
  useAccounts: () => accountsState,
  usePlatformValidate: () => ({ data: undefined }),
  useRedditFlairs: () => ({ data: undefined, isLoading: false }),
  usePresubmitCheck: () => ({ data: undefined }),
  useValidateMedia: () => ({ data: undefined }),
  useAssets: () => ({ data: { dir: 'data/media', assets: [] } }),
  lintText: vi.fn(() => Promise.resolve({ ok: true, clean: true, errors: 0, warnings: 0, findings: [] })),
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
  runPublishDue: vi.fn(),
  updatePost: vi.fn(() => Promise.resolve({ ok: true })),
  editPublished: vi.fn(),
  discordScheduleEvent: vi.fn(),
  mastodonPin: vi.fn(),
}));
vi.mock('../../lib/cloud.js', () => ({ useCloudDelivery: () => ({ cloudOn: false, cloudLanes: [], resolved: true }) }));

const post = (over = {}) => ({
  id: 'reddit-r-mcp',
  campaign: 'launch-oss-2026-07',
  caption: 'I wanted an agent to schedule my posts.',
  platforms: ['reddit'],
  approval: 'draft',
  derivedState: 'waiting-approval',
  scheduledAt: '2026-07-18T13:36:31.700Z',
  type: 'text',
  rev: 1,
  executionMode: 'fully-scheduled',
  image: null,
  ids: {},
  cover: null,
  media: { file: null, exists: false, bytes: 0, url: null, cover: null, path: null },
  ...over,
});

function renderDetail(p = post()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale="en">
        <TooltipProvider>
          <ConfirmProvider>
            <PostDetail post={p} onClose={() => {}} onEdit={() => {}} onNavigate={() => {}} />
          </ConfirmProvider>
        </TooltipProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  healthState.data = { setup: { platforms: [{ platform: 'reddit', status: 'incomplete' }] } };
});

describe('the platform chip on a targeted-but-unconnected lane', () => {
  it('renders pressed for the post target even though the lane is not connected', () => {
    renderDetail();
    const chip = screen.getByRole('button', { name: 'Reddit', pressed: true });
    expect(chip).toBeInTheDocument();
  });

  it('deselect DEACTIVATES the chip and keeps it on screen - it never unrenders', async () => {
    const user = userEvent.setup();
    renderDetail();
    await user.click(screen.getByRole('button', { name: 'Reddit', pressed: true }));
    // The defect: this chip vanished here. Now it stays, merely un-highlighted.
    expect(screen.getByRole('button', { name: 'Reddit', pressed: false })).toBeInTheDocument();
  });

  it('re-select restores it - the toggle is reversible', async () => {
    const user = userEvent.setup();
    renderDetail();
    const chip = () => screen.getByRole('button', { name: 'Reddit' });
    await user.click(chip());
    expect(chip()).toHaveAttribute('aria-pressed', 'false');
    await user.click(chip());
    expect(chip()).toHaveAttribute('aria-pressed', 'true');
  });
});
