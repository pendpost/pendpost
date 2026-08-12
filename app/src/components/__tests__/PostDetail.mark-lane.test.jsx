import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import PostDetail from '../PostDetail.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// R5 piece 1 (ux-audit 2026-08-04, dim-1 G4/L4) - the GUI side of lane-scoped
// mark-posted. On a MIXED multi-lane post the ⋯ overflow shows one "Mark <lane>
// posted" entry per still-owed lane and calls markPosted with that platform, so
// recording one lane by hand never closes the siblings pendpost still owes. A
// single-lane post keeps the whole-post mark (no platform arg).
const healthState = { data: { setup: { platforms: [] } } };
const platformValidateState = { data: undefined };
const cloudDeliveryState = { cloudOn: false, cloudLanes: [], resolved: true };
const markPosted = vi.fn(() => Promise.resolve({ ok: true }));

vi.mock('../../lib/api.js', () => ({
  useInsights: () => ({ data: undefined }),
  useActiveClient: () => ({ activeClient: null, activeClientId: null }),
  usePendpostHealth: () => healthState,
  useConfig: () => ({ data: null }),
  useAccounts: () => ({ data: { meta: { paused: false } } }),
  usePlatformValidate: () => platformValidateState,
  useRedditFlairs: () => ({ data: undefined, isLoading: false }),
  usePresubmitCheck: () => ({ data: undefined }),
  useValidateMedia: () => ({ data: undefined }),
  lintText: vi.fn(() => Promise.resolve({ ok: true, clean: true, errors: 0, warnings: 0, findings: [] })),
  approvePost: vi.fn(() => Promise.resolve({ ok: true })),
  rejectPost: vi.fn(),
  deletePost: vi.fn(),
  unschedulePost: vi.fn(),
  reschedulePost: vi.fn(),
  markPosted: (...a) => markPosted(...a),
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
vi.mock('../../lib/cloud.js', () => ({ useCloudDelivery: () => cloudDeliveryState }));

const basePost = (over = {}) => ({
  id: 'p-mixed',
  campaign: 'camp',
  caption: 'hello world',
  platforms: ['reddit', 'telegram'],
  approval: 'approved',
  derivedState: 'waiting-due',
  scheduledAt: '2026-08-14T16:53:05.787Z',
  type: 'text',
  rev: 1,
  executionMode: 'fully-scheduled',
  image: null,
  ids: {},
  cover: null,
  media: { file: null, exists: false, bytes: 0, url: null, cover: null, path: null },
  ...over,
});

function renderDetail(post) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale="en">
        <TooltipProvider>
          <ConfirmProvider>
            <PostDetail post={post} onClose={() => {}} onEdit={() => {}} onNavigate={() => {}} />
          </ConfirmProvider>
        </TooltipProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  markPosted.mockClear();
  healthState.data = { setup: { platforms: [
    { platform: 'reddit', status: 'connected' },
    { platform: 'telegram', status: 'connected' },
  ] } };
  platformValidateState.data = undefined;
  vi.stubGlobal('open', vi.fn());
});

describe('R5: lane-scoped mark-posted in the ⋯ overflow', () => {
  it('a mixed post shows one Mark-<lane>-posted entry per owed lane (not one whole-post mark)', async () => {
    const user = userEvent.setup();
    renderDetail(basePost());
    await user.click(screen.getByRole('button', { name: /more actions/i }));
    expect(screen.getByRole('button', { name: /mark reddit as posted/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /mark telegram as posted/i })).toBeInTheDocument();
    // The bare whole-post "Mark as posted" is gone on a mixed post - it would close
    // every lane at once, the exact bug this piece fixes.
    expect(screen.queryByRole('button', { name: /^mark as posted$/i })).not.toBeInTheDocument();
  });

  it('marking one lane calls markPosted with that platform', async () => {
    const user = userEvent.setup();
    renderDetail(basePost());
    await user.click(screen.getByRole('button', { name: /more actions/i }));
    await user.click(screen.getByRole('button', { name: /mark reddit as posted/i }));
    await user.type(screen.getByPlaceholderText(/https/i), 'https://reddit.com/r/x/abc');
    await user.click(screen.getByRole('button', { name: /^confirm$/i }));
    expect(markPosted).toHaveBeenCalledWith('camp', 'p-mixed', 'https://reddit.com/r/x/abc', 'reddit');
  });

  it('a lane already carrying a manual marker drops out of the owed entries', async () => {
    const user = userEvent.setup();
    renderDetail(basePost({ manualCompletions: { reddit: { at: '2026-08-14T17:00:00Z' } } }));
    await user.click(screen.getByRole('button', { name: /more actions/i }));
    expect(screen.queryByRole('button', { name: /mark reddit as posted/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /mark telegram as posted/i })).toBeInTheDocument();
  });

  it('a single-lane post keeps the whole-post mark (no platform arg)', async () => {
    const user = userEvent.setup();
    renderDetail(basePost({ id: 'p-solo', platforms: ['telegram'] }));
    await user.click(screen.getByRole('button', { name: /more actions/i }));
    await user.click(screen.getByRole('button', { name: /^mark as posted$/i }));
    await user.click(screen.getByRole('button', { name: /^confirm$/i }));
    expect(markPosted).toHaveBeenCalledWith('camp', 'p-solo', undefined, undefined);
  });
});
