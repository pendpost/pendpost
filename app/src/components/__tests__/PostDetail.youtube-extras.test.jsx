import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi } from 'vitest';
import PostDetail from '../PostDetail.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// Issue #39: a YouTube post carries its category and the altered/synthetic-content
// disclosure (set through MCP/API only, no Composer control). PostDetail shows each as a
// read-only Details row ONLY when set, so the reviewer sees both before approving.
vi.mock('../../lib/api.js', () => ({
  useInsights: () => ({ data: undefined }),
  useActiveClient: () => ({ activeClient: { id: 'acme', displayName: 'Acme Retail', accent: '#22566d' }, activeClientId: 'acme' }),
  usePendpostHealth: () => ({ data: { setup: { platforms: [] } } }),
  useConfig: () => ({ data: null }),
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

const ytPost = {
  id: 'yt1',
  campaign: 'launch',
  title: 'How the gate works',
  description: 'A short tour.',
  caption: '',
  platforms: ['youtube'],
  approval: 'pending',
  derivedState: 'waiting-due',
  status: 'planned',
  scheduledAt: '2026-11-01T10:00:00Z',
  type: 'youtube-short',
  rev: 1,
  executionMode: 'fully-scheduled',
  image: null,
  ids: {},
  cover: null,
  publishedVia: null,
  externalUrl: null,
  verify: null,
  media: { file: 'clip.mp4', exists: true, bytes: 1000, url: null, cover: null, path: 'data/media/clip.mp4' },
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

describe('PostDetail YouTube category + synthetic-content rows (#39)', () => {
  it('names the category and shows the disclosure when both are set', () => {
    renderDetail({ ...ytPost, youtubeCategoryId: '27', containsSyntheticMedia: true });
    expect(screen.getByText('YouTube category')).toBeInTheDocument();
    expect(screen.getByText('Education')).toBeInTheDocument();
    expect(screen.getByText('Discloses altered or synthetic content')).toBeInTheDocument();
  });

  it('speaks German on the de-CH surface', () => {
    renderDetail({ ...ytPost, youtubeCategoryId: '28', containsSyntheticMedia: true }, 'de-CH');
    expect(screen.getByText('YouTube-Kategorie')).toBeInTheDocument();
    expect(screen.getByText('Wissenschaft & Technik')).toBeInTheDocument();
    expect(screen.getByText('Weist veränderte oder synthetische Inhalte aus')).toBeInTheDocument();
  });

  it('shows no row when neither is set (or the disclosure is false)', () => {
    renderDetail({ ...ytPost, containsSyntheticMedia: false });
    expect(screen.queryByText('YouTube category')).not.toBeInTheDocument();
    expect(screen.queryByText('Discloses altered or synthetic content')).not.toBeInTheDocument();
  });

  it('an id outside the assignable set shows as-is rather than a wrong name', () => {
    renderDetail({ ...ytPost, youtubeCategoryId: '44' });
    expect(screen.getByText('44')).toBeInTheDocument();
  });

  it('never shows on a post that does not target YouTube', () => {
    renderDetail({ ...ytPost, platforms: ['telegram'], type: 'text', youtubeCategoryId: '27', containsSyntheticMedia: true });
    expect(screen.queryByText('YouTube category')).not.toBeInTheDocument();
  });
});
