import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import PostDetail from '../PostDetail.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// Two defects, one screen - both found on the live post radar-reddit-mrkw3vy3ud.
//
// 1. Approve was a NO-OP and said nothing. setApproval (lib/writes.mjs) checks the actor and
//    self-approval and never connectivity, and the button was never disabled. So the operator
//    could press Freigeben on a Reddit reply for a project whose Reddit was never connected,
//    and pendpost would flip a field and publish nothing, forever. The fix is a SWAP, not a
//    warning bolted beside a button that still lies: the same slot offers the action that
//    actually works - take the text, post it yourself.
// 2. The reply showed the answer and not the question. radarReplyTo carried only
//    { url, source, externalId }, so the approver was asked to bless a reply to a thread they
//    could not read.
const healthState = { data: { setup: { platforms: [] } } };
const platformValidateState = { data: undefined };
const cloudDeliveryState = { cloudOn: false, cloudLanes: [], resolved: true };
const markPosted = vi.fn(() => Promise.resolve({ ok: true }));
const approvePost = vi.fn(() => Promise.resolve({ ok: true }));

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
  useAssets: () => ({ data: { dir: 'data/media', assets: [] } }),
  lintText: vi.fn(() => Promise.resolve({ ok: true, clean: true, errors: 0, warnings: 0, findings: [] })),
  approvePost: (...a) => approvePost(...a),
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

const REPLY_TO = {
  url: 'https://reddit.com/r/askswitzerland/comments/abc/x',
  source: 'reddit',
  externalId: 't3_abc',
  author: 'WorthObjective6266',
  community: 'askswitzerland',
  excerpt: 'Looking for an ADHD coach for women if possible.',
};
const replyPost = (over = {}) => ({
  id: 'radar-reddit-mrkw3vy3ud',
  campaign: 'radar-replies-2026-07',
  caption: 'A few things that helped me choose.',
  platforms: ['reddit'],
  approval: 'pending',
  derivedState: 'waiting-due',
  scheduledAt: '2026-07-14T16:53:05.787Z',
  type: 'text',
  rev: 1,
  executionMode: 'fully-scheduled',
  image: null,
  ids: {},
  cover: null,
  media: { file: null, exists: false, bytes: 0, url: null, cover: null, path: null },
  radarReplyTo: REPLY_TO,
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

const connected = [{ platform: 'reddit', status: 'connected' }];
const incomplete = [{ platform: 'reddit', status: 'incomplete' }];

beforeEach(() => {
  markPosted.mockClear();
  approvePost.mockClear();
  healthState.data = { setup: { platforms: connected } };
  platformValidateState.data = undefined;
  vi.stubGlobal('open', vi.fn());
});

describe('an unconnected lane hands the post back instead of faking an approval', () => {
  it('offers Approve when the lane IS connected (pendpost will really post it)', () => {
    renderDetail(replyPost());
    expect(screen.getByRole('button', { name: /approve/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /copy and post yourself/i })).not.toBeInTheDocument();
  });

  it('replaces Approve with the hand-off when the lane is NOT connected', () => {
    healthState.data = { setup: { platforms: incomplete } };
    renderDetail(replyPost());
    expect(screen.getByRole('button', { name: /copy and post yourself/i })).toBeInTheDocument();
    // The whole point: no button remains that claims pendpost will publish this.
    expect(screen.queryByRole('button', { name: /^approve/i })).not.toBeInTheDocument();
  });

  it('states the CONSEQUENCE in the pill row, replacing the approval promise it contradicts', () => {
    healthState.data = { setup: { platforms: incomplete } };
    renderDetail(replyPost());
    // "Waiting for approval" is the wrong promise: there is no approval to wait for. The
    // consequence badge REPLACES it rather than stacking a third pill beside it.
    expect(screen.getByText(/you post this yourself/i)).toBeInTheDocument();
    expect(screen.queryByText(/waiting for approval/i)).not.toBeInTheDocument();
  });

  it('keeps the ordinary approval pill when the lane is connected', () => {
    renderDetail(replyPost());
    expect(screen.queryByText(/you post this yourself/i)).not.toBeInTheDocument();
  });

  // US-PRE-10: the "cannot publish" fact moved INTO the lane's own delivery row
  // as the blocked-class label (never "Pending" beside a contradicting sentence).
  it('says plainly why, on the lane row itself', () => {
    healthState.data = { setup: { platforms: incomplete } };
    renderDetail(replyPost());
    expect(screen.getByText(/Blocked - connect Reddit/)).toBeInTheDocument();
    expect(screen.queryByText(/Pending/)).not.toBeInTheDocument();
    // ...and NOT the old mechanism line, which read the same whether Reddit was
    // live or had never been authorized.
    expect(screen.queryByText(/needs pendpost running/i)).not.toBeInTheDocument();
  });

  it('copies the text and opens the thread, then closes the loop with mark-as-posted', async () => {
    // userEvent.setup() installs its OWN clipboard stub, so the spy has to go on AFTER it.
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText');
    healthState.data = { setup: { platforms: incomplete } };
    renderDetail(replyPost());
    await user.click(screen.getByRole('button', { name: /copy and post yourself/i }));
    expect(writeText).toHaveBeenCalledWith('A few things that helped me choose.');
    expect(window.open).toHaveBeenCalledWith(REPLY_TO.url, '_blank', 'noopener,noreferrer');
    // ONE control, two steps: the operator never has to hunt the overflow menu for the way
    // to close the loop, which would leave the hand-off a dead end.
    const done = await screen.findByRole('button', { name: /mark as posted/i });
    await user.click(done);
    // mark-as-posted prompts for the link of what was just posted - which is exactly right
    // here: the operator has it in their address bar, and it gives the manual post real
    // provenance instead of a bare "trust me, it went out".
    await user.type(screen.getByPlaceholderText(/https/i), 'https://reddit.com/r/askswitzerland/comments/abc/x/reply');
    await user.click(screen.getByRole('button', { name: /^confirm$/i }));
    // A single-lane post takes the whole-post mark path, so the lane-scoped 4th
    // arg (platform, R5) is undefined here.
    expect(markPosted).toHaveBeenCalledWith('radar-replies-2026-07', 'radar-reddit-mrkw3vy3ud', 'https://reddit.com/r/askswitzerland/comments/abc/x/reply', undefined);
  });

  it('does not hand off a post whose lane is merely SKIPPED (that is a decision, not a fault)', () => {
    healthState.data = { setup: { platforms: [{ platform: 'reddit', status: 'skipped' }] } };
    renderDetail(replyPost());
    expect(screen.getByRole('button', { name: /approve/i })).toBeInTheDocument();
  });
});

// The hand-off's third defect, found on a launch post: it copied the caption and opened
// NOTHING. radarReplyTo/externalUrl are the only targets it knew, and a normal planned post
// carries neither - so the operator was handed a clipboard and no destination, which is the
// dead end this feature exists to remove, one step further along.
describe('the hand-off says where the text is supposed to go', () => {
  const planned = (over = {}) => replyPost({ radarReplyTo: undefined, caption: 'Sharing a self-hosted option.', ...over });

  beforeEach(() => { healthState.data = { setup: { platforms: incomplete } }; });

  it('names the destination on screen, before the click', () => {
    renderDetail(planned({ redditSubreddit: 'selfhosted' }));
    const link = screen.getByRole('link', { name: /post it on r\/selfhosted/i });
    expect(link).toHaveAttribute('href', expect.stringContaining('https://www.reddit.com/r/selfhosted/submit'));
  });

  it('copies the text AND opens the prefilled submit page', async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText');
    renderDetail(planned({ redditSubreddit: 'selfhosted' }));
    await user.click(screen.getByRole('button', { name: /copy and post yourself/i }));
    expect(writeText).toHaveBeenCalledWith('Sharing a self-hosted option.');
    expect(window.open).toHaveBeenCalledWith(
      expect.stringContaining('text=Sharing+a+self-hosted+option.'),
      '_blank',
      'noopener,noreferrer',
    );
  });

  it('never opens a tab when the clipboard refuses (copy stays first)', async () => {
    const user = userEvent.setup();
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValueOnce(new Error('denied'));
    renderDetail(planned({ redditSubreddit: 'selfhosted' }));
    await user.click(screen.getByRole('button', { name: /copy and post yourself/i }));
    expect(window.open).not.toHaveBeenCalled();
  });

  it('lets the thread win for a Radar reply - the reply belongs under the question', () => {
    renderDetail(replyPost({ redditSubreddit: 'selfhosted' }));
    expect(screen.getByRole('link', { name: /open thread/i })).toHaveAttribute('href', REPLY_TO.url);
  });

  it('opens NEITHER when two offline lanes offer two destinations', async () => {
    const user = userEvent.setup();
    healthState.data = { setup: { platforms: [{ platform: 'reddit', status: 'incomplete' }, { platform: 'x', status: 'incomplete' }] } };
    renderDetail(planned({ platforms: ['reddit', 'x'], redditSubreddit: 'selfhosted' }));
    // Both are offered; picking one for the operator would send them to the wrong network.
    expect(screen.getByRole('link', { name: /post it on r\/selfhosted/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /post it on X/i })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /copy and post yourself/i }));
    expect(window.open).not.toHaveBeenCalled();
  });

  // The wrench and the "Set up <lane>" link in the Before-publishing card are one job.
  it('drops the wrench glyph when the labelled setup link is already offered below', () => {
    platformValidateState.data = {
      ok: true, postId: 'radar-reddit-mrkw3vy3ud',
      platforms: { reddit: { ready: false, problems: ['x'], warnings: [], needsSetup: true } },
    };
    renderDetail(planned({ redditSubreddit: 'selfhosted' }));
    expect(screen.getByRole('button', { name: /set up reddit/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /connect reddit so pendpost/i })).not.toBeInTheDocument();
  });

  it('keeps the wrench when platform-validate has no data - otherwise the fact has no way out', () => {
    platformValidateState.data = undefined;
    renderDetail(planned({ redditSubreddit: 'selfhosted' }));
    expect(screen.queryByRole('button', { name: /set up reddit/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /connect reddit so pendpost/i })).toBeInTheDocument();
  });

  it('names a lane with no honest URL plainly - never a fabricated link, never silence', () => {
    healthState.data = { setup: { platforms: [{ platform: 'instagram', status: 'incomplete' }] } };
    renderDetail(planned({ platforms: ['instagram'] }));
    expect(screen.queryByRole('link', { name: /post it on/i })).not.toBeInTheDocument();
    // The destination NAME is still true: the section says where, and that the text is on
    // the clipboard - a plain statement instead of the old silence.
    expect(screen.getByText('Where this goes')).toBeInTheDocument();
    expect(screen.getByText(/paste the text on instagram yourself/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /copy and post yourself/i })).toBeInTheDocument();
  });
});

// The destination leads the body: for any post the operator must publish by hand, WHERE it
// goes is the decision's subject, so it can never hide inside the Delivery fine print. The
// launch post reddit-r-mcp shipped with no subreddit and no radarReplyTo and rendered NO
// destination anywhere - the screenshot that triggered this fix.
describe('the Destination section', () => {
  const planned = (over = {}) => replyPost({ radarReplyTo: undefined, caption: 'Sharing a self-hosted option.', ...over });

  beforeEach(() => { healthState.data = { setup: { platforms: incomplete } }; });

  it('leads with the submit link for a hand-off post that can resolve one', () => {
    renderDetail(planned({ redditSubreddit: 'selfhosted' }));
    expect(screen.getByText('Where this goes')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /post it on r\/selfhosted/i });
    expect(link).toHaveAttribute('href', expect.stringContaining('https://www.reddit.com/r/selfhosted/submit'));
  });

  it('turns reddit-without-a-subreddit into the fix, not silence: the row opens the editor', async () => {
    const user = userEvent.setup();
    const onEdit = vi.fn();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <I18nProvider locale="en">
          <TooltipProvider>
            <ConfirmProvider>
              <PostDetail post={planned()} onClose={() => {}} onEdit={onEdit} onNavigate={() => {}} />
            </ConfirmProvider>
          </TooltipProvider>
        </I18nProvider>
      </QueryClientProvider>,
    );
    const fix = screen.getByRole('button', { name: /no subreddit set/i });
    await user.click(fix);
    expect(onEdit).toHaveBeenCalled();
  });

  it('does not render for a posted post (nothing left to hand over)', () => {
    renderDetail(planned({ redditSubreddit: 'selfhosted', derivedState: 'posted', approval: 'approved' }));
    expect(screen.queryByText('Where this goes')).not.toBeInTheDocument();
  });

  it('keeps the destination OUT of the delivery line (one visual answer, not two)', () => {
    renderDetail(planned({ redditSubreddit: 'selfhosted' }));
    const links = screen.getAllByRole('link', { name: /post it on r\/selfhosted/i });
    expect(links).toHaveLength(1);
  });
});

describe('the thread a reply answers is readable at the moment of approval', () => {
  it('shows who asked, where, and what they said', () => {
    renderDetail(replyPost());
    expect(screen.getByText('WorthObjective6266')).toBeInTheDocument();
    expect(screen.getByText('askswitzerland')).toBeInTheDocument();
    expect(screen.getByText(/Looking for an ADHD coach for women/)).toBeInTheDocument();
  });

  it('opens the real thread (no dead end)', () => {
    renderDetail(replyPost());
    const link = screen.getByRole('link', { name: /open thread/i });
    expect(link).toHaveAttribute('href', REPLY_TO.url);
  });

  it('renders link-only for a reply queued before the snapshot existed, never an invented quote', () => {
    renderDetail(replyPost({ radarReplyTo: { url: REPLY_TO.url, source: 'reddit', externalId: 't3_abc' } }));
    expect(screen.getByRole('link', { name: /open thread/i })).toHaveAttribute('href', REPLY_TO.url);
    expect(screen.queryByText(/Looking for an ADHD coach/)).not.toBeInTheDocument();
    // ...and the address stands in for the identity, so the row is not a lone glyph and a
    // link floating apart. It is what we know, never a stand-in for the quote we do not have.
    expect(screen.getByText('reddit.com/r/askswitzerland/comments/abc/x')).toBeInTheDocument();
  });

  it('shows no thread block on an ordinary post', () => {
    renderDetail(replyPost({ radarReplyTo: undefined }));
    expect(screen.queryByText(/^Answering$/)).not.toBeInTheDocument();
  });
});
