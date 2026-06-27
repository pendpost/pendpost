import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { axeClean } from '../../test-utils/axe.js';
import PostDetail from '../PostDetail.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// B2 part 2: PostDetail must surface platform_validate problems[]/warnings[]
// (and validate_media spec-check failures) as quiet, read-only blocker rows in
// the Platforms Section. Distinct red (problems) / amber (warnings); clean =>
// no rows. We mock the new read-only hooks usePlatformValidate / useValidateMedia.
const platformValidateState = { data: undefined };
const validateMediaState = { data: undefined };

const lintText = vi.fn(() =>
  Promise.resolve({ ok: true, clean: true, errors: 0, warnings: 0, findings: [] }),
);

vi.mock('../../lib/api.js', () => ({
  useActiveClient: () => ({ activeClient: null, activeClientId: null }),
  useAccounts: () => ({ data: { meta: { paused: false } } }),
  usePlatformValidate: () => platformValidateState,
  useValidateMedia: () => validateMediaState,
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

function renderDetail(post = basePost, onNavigate = () => {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale="en">
        <TooltipProvider>
          <ConfirmProvider>
            <PostDetail post={post} onClose={() => {}} onEdit={() => {}} onNavigate={onNavigate} />
          </ConfirmProvider>
        </TooltipProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  lintText.mockClear();
  platformValidateState.data = undefined;
  validateMediaState.data = undefined;
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

  it('shows a connected draft as a neutral "waiting for approval" line, never a red blocker', () => {
    // A connected lane (no problems) on a draft post: the panel explains the
    // pending state in ONE neutral line; the Entwurf status badge carries the rest.
    platformValidateState.data = {
      ok: true,
      postId: 'p1',
      platforms: { instagram: { ready: false, problems: [], warnings: [], needsSetup: false } },
    };
    renderDetail({ ...basePost, approval: 'draft' });
    expect(screen.getByText('waiting for your approval')).toBeInTheDocument();
    // The old red "approval is draft - only approved posts publish" blocker is gone.
    expect(screen.queryByText(/only approved posts publish/i)).not.toBeInTheDocument();
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
    expect(onNavigate).toHaveBeenCalledWith('setup');
  });

  it('renders nothing when an approved post has every lane connected and clean', () => {
    platformValidateState.data = {
      ok: true,
      postId: 'p1',
      platforms: { instagram: { ready: true, problems: [], warnings: [], needsSetup: false } },
    };
    renderDetail(); // basePost is approved
    expect(screen.queryByText("Won't publish yet")).not.toBeInTheDocument();
    expect(screen.queryByText('waiting for your approval')).not.toBeInTheDocument();
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
