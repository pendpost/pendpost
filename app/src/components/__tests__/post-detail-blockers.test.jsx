import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { axeClean } from '../../test-utils/axe.js';
import PostDetail from '../PostDetail.jsx';
import { PlatformBlockers } from '../ui.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// B2 part 2: PostDetail must surface platform_validate problems[]/warnings[]
// (and validate_media spec-check failures) as quiet, read-only blocker rows in
// the Platforms Section. Distinct red (problems) / amber (warnings); clean =>
// no rows. We mock the new read-only hooks usePlatformValidate / useValidateMedia.
const platformValidateState = { data: undefined };
const presubmitState = { data: undefined };
const validateMediaState = { data: undefined };
// CI-2: spy on the raw args useValidateMedia is called with (campaign, postId,
// enabled) so a test can assert the `enabled` gate without needing a real fetch.
const validateMediaCalls = [];
// Controls the cloud-aware delivery statement. resolved:false by default so the
// unrelated tests below see NO delivery line (only the delivery-specific tests opt in).
const cloudDeliveryState = { cloudOn: false, cloudLanes: [], resolved: false };

const lintText = vi.fn(() =>
  Promise.resolve({ ok: true, clean: true, errors: 0, warnings: 0, findings: [] }),
);

vi.mock('../../lib/api.js', () => ({
  useInsights: () => ({ data: undefined }),
  useActiveClient: () => ({ activeClient: null, activeClientId: null }),
  usePendpostHealth: () => ({ data: { setup: { platforms: [] } } }),
  useConfig: () => ({ data: null }),
  useAccounts: () => ({ data: { meta: { paused: false } } }),
  usePlatformValidate: () => platformValidateState,
  useRedditFlairs: () => ({ data: undefined, isLoading: false }),
  usePresubmitCheck: () => presubmitState,
  useValidateMedia: (...args) => { validateMediaCalls.push(args); return validateMediaState; },
  useAssets: () => ({ data: { dir: 'data/media', assets: [] } }),
  lintText: (...a) => lintText(...a),
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
  updatePost: (...a) => updatePost(...a),
}));
const updatePost = vi.fn(() => Promise.resolve({ ok: true }));

// Keep every real cloud export (so nothing in the tree hits a missing-export), but
// pin the delivery derivation to a controllable value - no real /api/cloud fetch.
vi.mock('../../lib/cloud.js', async (importOriginal) => ({
  ...(await importOriginal()),
  useCloudDelivery: () => cloudDeliveryState,
}));

const basePost = {
  id: 'p1',
  campaign: 'spring',
  title: 'Spring promo',
  caption: 'A caption',
  platforms: ['instagram'],
  approval: 'approved',
  derivedState: 'scheduled',
  scheduledAt: '2026-07-01T10:00:00Z',
  type: 'reel',
  rev: 1,
  executionMode: 'fully-scheduled',
  image: null,
  ids: {},
  cover: null,
  media: { file: 'reel.mp4', exists: true, bytes: 1000, url: '/media?p=reel.mp4', cover: '/media?p=reel.jpg', path: 'reel.mp4' },
};

function renderDetail(post = basePost, onNavigate = () => {}, onEdit = () => {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale="en">
        <TooltipProvider>
          <ConfirmProvider>
            <PostDetail post={post} onClose={() => {}} onEdit={onEdit} onNavigate={onNavigate} />
          </ConfirmProvider>
        </TooltipProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  lintText.mockClear();
  platformValidateState.data = undefined;
  presubmitState.data = undefined;
  validateMediaState.data = undefined;
  cloudDeliveryState.cloudOn = false;
  cloudDeliveryState.cloudLanes = [];
  cloudDeliveryState.resolved = false;
  updatePost.mockClear();
  validateMediaCalls.length = 0;
});

describe('PostDetail validate-media probe gating (CI-2)', () => {
  it('does NOT enable the validate-media probe for a media-less text post', () => {
    platformValidateState.data = { ok: true, postId: 'p1', platforms: { x: { ready: true, problems: [], warnings: [] } } };
    renderDetail({ ...basePost, type: 'text', platforms: ['x'], link: null, image: null });
    expect(validateMediaCalls.at(-1)?.[2]).toBe(false);
  });

  it('does NOT enable the validate-media probe for a media-less poll post', () => {
    platformValidateState.data = { ok: true, postId: 'p1', platforms: { telegram: { ready: true, problems: [], warnings: [] } } };
    renderDetail({ ...basePost, type: 'poll', platforms: ['telegram'], poll: { options: ['A', 'B'], durationMinutes: 60 } });
    expect(validateMediaCalls.at(-1)?.[2]).toBe(false);
  });

  it('does NOT enable the validate-media probe for a media-less nostr-longform post', () => {
    platformValidateState.data = { ok: true, postId: 'p1', platforms: { nostr: { ready: true, problems: [], warnings: [] } } };
    renderDetail({ ...basePost, type: 'nostr-longform', platforms: ['nostr'] });
    expect(validateMediaCalls.at(-1)?.[2]).toBe(false);
  });

  it('DOES enable the validate-media probe for a media-backed reel post', () => {
    platformValidateState.data = { ok: true, postId: 'p1', platforms: { instagram: { ready: true, problems: [], warnings: [] } } };
    renderDetail(); // basePost is type:'reel'
    expect(validateMediaCalls.at(-1)?.[2]).toBe(true);
  });
});

describe('PostDetail platform-validate blocker rows', () => {
  it('renders each problem string as a blocker row in the Platforms section', () => {
    platformValidateState.data = {
      ok: true,
      postId: 'p1',
      platforms: {
        instagram: {
          ready: false,
          problems: [
            'local media file is missing',
            'caption is 2500 chars - instagram caps at 2200',
          ],
          warnings: [],
        },
      },
    };
    renderDetail();
    expect(screen.getByText('local media file is missing')).toBeInTheDocument();
    expect(screen.getByText('caption is 2500 chars - instagram caps at 2200')).toBeInTheDocument();
  });

  it('renders no blocker rows when every platform is ready and clean', () => {
    platformValidateState.data = {
      ok: true,
      postId: 'p1',
      platforms: { instagram: { ready: true, problems: [], warnings: [] } },
    };
    renderDetail();
    expect(screen.queryByText('local media file is missing')).not.toBeInTheDocument();
    expect(screen.queryByText(/caps at/)).not.toBeInTheDocument();
  });

  it('renders warnings as advisory rows distinct from blocking problems', () => {
    platformValidateState.data = {
      ok: true,
      postId: 'p1',
      platforms: {
        instagram: {
          ready: true,
          problems: [],
          warnings: ['no image set - the LinkedIn article card will have no thumbnail'],
        },
      },
    };
    renderDetail();
    expect(
      screen.getByText('no image set - the LinkedIn article card will have no thumbnail'),
    ).toBeInTheDocument();
  });

  it('surfaces validate_media spec-check failures as advisory rows', () => {
    // Real specChecks shape (lib/assets.mjs): codecOk:false / faststart:false /
    // resolution:'other' are the failures the UI should advise on.
    validateMediaState.data = {
      ok: true,
      media: { path: 'reel.mp4', bytes: 1000 },
      probe: {},
      checks: { resolution: 'story-9x16', codecOk: true, faststart: false },
    };
    platformValidateState.data = {
      ok: true,
      postId: 'p1',
      platforms: { instagram: { ready: true, problems: [], warnings: [] } },
    };
    renderDetail();
    // The failing faststart spec-check surfaces as an advisory row.
    expect(screen.getByText(/faststart/i)).toBeInTheDocument();
  });

  it('does not restate the approval state in the platforms panel (header pill owns it)', () => {
    // A connected lane (no problems) on a draft post: the panel must NOT repeat the
    // approval state - the header ApprovalPill ("Draft") is the single source. So the
    // blocker block does not render at all here.
    platformValidateState.data = {
      ok: true,
      postId: 'p1',
      platforms: { instagram: { ready: false, problems: [], warnings: [], needsSetup: false } },
    };
    renderDetail({ ...basePost, approval: 'draft' });
    expect(screen.queryByText('waiting for your approval')).not.toBeInTheDocument();
    expect(screen.queryByText('Before publishing')).not.toBeInTheDocument();
    // The approval axis is shown once, by the header pill.
    expect(screen.getByText('Draft')).toBeInTheDocument();
  });

  // Flair is a CLOSED set of valid values, so the panel must offer the control rather
  // than advise the operator to go and do it on reddit.com. The picker itself is the
  // Composer's (spec 16) - this row opens it instead of growing a second one here.
  it('turns the flair advisory into the action that fixes it', () => {
    presubmitState.data = {
      ok: true,
      platforms: { reddit: { problems: [{ code: 'flairRequired', text: '' }], warnings: [] } },
    };
    const onEdit = vi.fn();
    renderDetail({ ...basePost, platforms: ['reddit'], approval: 'pending', derivedState: 'waiting-due' }, () => {}, onEdit);
    expect(screen.queryByText(/set one on reddit\.com/i)).not.toBeInTheDocument();
    screen.getByRole('button', { name: /choose a flair/i }).click();
    expect(onEdit).toHaveBeenCalled();
  });

  // No onFix (a read-only host, e.g. the approvals card) falls back to the plain sentence
  // rather than offering a control that would go nowhere.
  it('keeps the plain advisory when no fix handler is wired', () => {
    render(
      <I18nProvider locale="en">
        <PlatformBlockers
          presubmit={{ ok: true, platforms: { reddit: { problems: [{ code: 'flairRequired', text: '' }], warnings: [] } } }}
          showApproval={false}
        />
      </I18nProvider>,
    );
    expect(screen.queryByRole('button', { name: /choose a flair/i })).not.toBeInTheDocument();
    expect(screen.getByText(/set one on reddit\.com/i)).toBeInTheDocument();
  });

  it('collapses a disconnected lane to one amber "Set up <lane>" link', () => {
    platformValidateState.data = {
      ok: true,
      postId: 'p1',
      platforms: {
        linkedin: { ready: false, problems: ['LinkedIn ist nicht verbunden'], warnings: [], needsSetup: true },
      },
    };
    const onNavigate = vi.fn();
    renderDetail(basePost, onNavigate);
    // One actionable link, NOT the raw auth string.
    const link = screen.getByRole('button', { name: 'Set up LinkedIn' });
    expect(link).toBeInTheDocument();
    expect(screen.queryByText('LinkedIn ist nicht verbunden')).not.toBeInTheDocument();
    link.click();
    // ...and it opens THAT lane's card, not the Setup index: the deep link is the point
    // (5645c9c), and a test that only pinned the route let the platform argument rot.
    expect(onNavigate).toHaveBeenCalledWith('setup', 'linkedin');
  });

  it('renders nothing when an approved post has every lane connected and clean', () => {
    platformValidateState.data = {
      ok: true,
      postId: 'p1',
      platforms: { instagram: { ready: true, problems: [], warnings: [], needsSetup: false } },
    };
    renderDetail(); // basePost is approved
    expect(screen.queryByText('Before publishing')).not.toBeInTheDocument();
    expect(screen.queryByText('waiting for your approval')).not.toBeInTheDocument();
  });

  it('states one calm "Publishes automatically" when the cloud fires every pending lane', () => {
    cloudDeliveryState.cloudOn = true;
    cloudDeliveryState.cloudLanes = ['meta', 'linkedin', 'x'];
    cloudDeliveryState.resolved = true;
    platformValidateState.data = {
      ok: true,
      postId: 'p1',
      platforms: { instagram: { ready: true, problems: [], warnings: [] } },
    };
    renderDetail(); // instagram -> setup id 'meta' is in cloudLanes -> cloud-fired
    expect(screen.getByText('Publishes automatically')).toBeInTheDocument();
    expect(screen.queryByText(/Needs pendpost running/)).not.toBeInTheDocument();
  });

  it('names the lane that still needs the local machine (cloud does not cover it)', () => {
    cloudDeliveryState.cloudOn = true;
    cloudDeliveryState.cloudLanes = ['meta', 'linkedin', 'x'];
    cloudDeliveryState.resolved = true;
    platformValidateState.data = {
      ok: true,
      postId: 'p1',
      platforms: { reddit: { ready: true, problems: [], warnings: [] } },
    };
    renderDetail({ ...basePost, platforms: ['reddit'] }); // reddit is local-only
    expect(screen.getByText(/Needs pendpost running:/)).toHaveTextContent('Reddit');
    expect(screen.queryByText('Publishes automatically')).not.toBeInTheDocument();
  });

  it('caption is editable inline; editing reveals Save which calls updatePost with the new caption', async () => {
    const user = userEvent.setup();
    platformValidateState.data = { ok: true, postId: 'p1', platforms: { instagram: { ready: true, problems: [], warnings: [] } } };
    renderDetail(); // basePost is approved + scheduled -> editable
    const textarea = screen.getByLabelText('Post text');
    expect(textarea.tagName).toBe('TEXTAREA');
    expect(textarea).toHaveValue('A caption');
    // Save is the PERMANENT primary now: visible but disabled while clean.
    expect(screen.getByRole('button', { name: /save changes/i })).toBeDisabled();
    await user.type(textarea, ' edited');
    const save = await screen.findByRole('button', { name: /save changes/i });
    expect(save).toBeEnabled();
    await user.click(save);
    expect(updatePost).toHaveBeenCalledWith('spring', 'p1', 1, { caption: 'A caption edited' });
  });

  it('drops the right column for a pure-text post (no link/image): single full-width body', () => {
    // A5: a pure text post has nothing to preview, so its body goes single-column
    // full-width - no empty "Text only" placeholder tile reserving ~38% of the row.
    platformValidateState.data = { ok: true, postId: 'p1', platforms: { x: { ready: true, problems: [], warnings: [] } } };
    renderDetail({ ...basePost, type: 'text', platforms: ['x'], link: null, image: null });
    expect(screen.queryByText('Text only')).not.toBeInTheDocument();
    // The editable body still renders (the single column carries the fields).
    expect(screen.getByLabelText('Post text')).toBeInTheDocument();
  });

  it('warns the lane needs the machine when the cloud is off', () => {
    cloudDeliveryState.resolved = true; // cloudOn stays false
    platformValidateState.data = {
      ok: true,
      postId: 'p1',
      platforms: { x: { ready: true, problems: [], warnings: [] } },
    };
    renderDetail({ ...basePost, platforms: ['x'] });
    expect(screen.getByText(/Needs pendpost running:/)).toBeInTheDocument();
  });

  it('has no axe violations with blocker rows present', async () => {
    platformValidateState.data = {
      ok: true,
      postId: 'p1',
      platforms: {
        instagram: {
          ready: false,
          problems: ['local media file is missing'],
          warnings: ['advisory note'],
        },
      },
    };
    const { container } = renderDetail();
    expect(await axeClean(container)).toHaveNoViolations();
  });
});

// Spec 12 review (adversarial findings on edit-after-publish, spec 12):
// finding #5 - a published poll's question/options are immutable on every
// edit-capable lane, so it must never be offered as an "editable" published
// post; finding #4 - a posted post's editedSinceApproval flag is publish-inert
// (canApprove already excludes 'posted') and CANNOT be cleared (no re-approve
// gate on a posted post), so the amber "Re-approve" header pill is pure noise
// there and must be suppressed - but only there, never for a non-posted post.
describe('PostDetail spec 12 review (poll edit exclusion + posted re-approve pill)', () => {
  it('excludes a published poll from editableLanes: no "Edit published" action offered', async () => {
    const user = userEvent.setup();
    platformValidateState.data = { ok: true, postId: 'p1', platforms: { telegram: { ready: true, problems: [], warnings: [] } } };
    renderDetail({
      ...basePost, type: 'poll', platforms: ['telegram'], derivedState: 'posted',
      approval: 'approved', ids: { tgMessageId: '999' }, poll: { options: ['A', 'B'], durationMinutes: 60 },
    });
    await user.click(screen.getByRole('button', { name: /more actions/i }));
    expect(screen.queryByRole('button', { name: /edit published/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /open in editor/i })).not.toBeInTheDocument();
  });

  it('still offers "Edit published" for a published NON-poll telegram post (the poll exclusion is type-specific)', async () => {
    const user = userEvent.setup();
    platformValidateState.data = { ok: true, postId: 'p1', platforms: { telegram: { ready: true, problems: [], warnings: [] } } };
    renderDetail({
      ...basePost, type: 'text', platforms: ['telegram'], derivedState: 'posted',
      approval: 'approved', ids: { tgMessageId: '999' },
    });
    await user.click(screen.getByRole('button', { name: /more actions/i }));
    expect(screen.getByRole('button', { name: /edit published/i })).toBeInTheDocument();
  });

  it('suppresses the amber "Re-approve" pill for a posted post (unclearable + publish-inert there)', () => {
    renderDetail({ ...basePost, derivedState: 'posted', approval: 'approved', editedSinceApproval: true });
    expect(screen.queryByText('Re-approve')).not.toBeInTheDocument();
  });

  it('still shows the amber "Re-approve" pill for a NON-posted approved post edited since approval', () => {
    renderDetail({ ...basePost, derivedState: 'scheduled', approval: 'approved', editedSinceApproval: true });
    expect(screen.getByText('Re-approve')).toBeInTheDocument();
  });
});
