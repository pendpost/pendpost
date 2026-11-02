import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import PostDetail from '../PostDetail.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// Studio fix flow: the PostDetail failure banner became the IssueCard, and it renders for a
// BLOCKED post too. Before, a post on an unconnected lane had no card at all, only a
// "Blocked: connect X" link deep in the Delivery section. Now the dialog leads with what is
// missing, why, and its one fix, and the Delivery row stops being a second control.
// The Bluesky case is the owner's real dead end: four Radar replies that read "a permission is
// missing, reconnect" for a lane Setup has no card for.

let healthData;

vi.mock('../../lib/api.js', () => ({
  useInsights: () => ({ data: undefined }),
  useActiveClient: () => ({ activeClient: { id: 'acme', displayName: 'Acme Retail', accent: '#22566d' }, activeClientId: 'acme' }),
  usePendpostHealth: () => ({ data: healthData }),
  useConfig: () => ({ data: null }),
  useAccounts: () => ({ data: { meta: { paused: false } } }),
  usePlatformValidate: () => ({ data: undefined }),
  useRedditFlairs: () => ({ data: undefined, isLoading: false }),
  usePresubmitCheck: () => ({ data: undefined }),
  useValidateMedia: () => ({ data: undefined }),
  useAssets: () => ({ data: { dir: 'data/media', assets: [] } }),
  approvePost: vi.fn(),
  rejectPost: vi.fn(),
  runPublishDue: vi.fn(() => Promise.resolve({ ran: [] })),
  deletePost: vi.fn(() => Promise.resolve({ ok: true })),
  unschedulePost: vi.fn(),
  reschedulePost: vi.fn(() => Promise.resolve({ ok: true })),
  markPosted: vi.fn(() => Promise.resolve({ ok: true })),
  verifyPost: vi.fn(() => Promise.resolve({ ok: true })),
  setCoverFrame: vi.fn(),
  uploadCover: vi.fn(),
  clearCover: vi.fn(),
  updatePost: vi.fn(),
  editPublished: vi.fn(),
  discordScheduleEvent: vi.fn(),
  mastodonPin: vi.fn(),
  resumeLane: vi.fn(),
  connectPlatform: vi.fn(() => Promise.resolve({ ok: true })),
  connectStatus: vi.fn(() => Promise.resolve({ ok: true, state: 'running' })),
  recheckHealth: vi.fn(() => Promise.resolve({ ok: true })),
  agentFixPost: vi.fn(() => Promise.resolve({ ok: true })),
}));

const base = {
  id: 'p1', campaign: 'launch', caption: 'Hello world', platforms: ['linkedin'], approval: 'approved',
  status: 'planned', derivedState: 'waiting-due', scheduledAt: '2099-06-01T10:00:00Z', type: 'text', rev: 1,
  executionMode: 'fully-scheduled', image: null, ids: {}, cover: null, publishedVia: null, externalUrl: null, verify: null,
  media: { file: null, exists: true, bytes: 10, url: null, cover: null, path: null },
};

function renderDetail(post, { locale = 'en', seed = [] } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // seed: [[queryKey, data]], e.g. another project's ['pendpost-health', clientId].
  for (const [key, data] of seed) qc.setQueryData(key, data);
  const onNavigate = vi.fn();
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale={locale}>
        <TooltipProvider>
          <ConfirmProvider>
            <PostDetail post={post} onClose={() => {}} onEdit={() => {}} onNavigate={onNavigate} />
          </ConfirmProvider>
        </TooltipProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
  return { onNavigate };
}

const issueCard = (title) => {
  const el = screen.getAllByRole('status').concat(screen.queryAllByRole('alert')).find((n) => n.textContent.includes(title));
  expect(el).toBeTruthy();
  return el;
};

beforeEach(() => {
  healthData = { setup: { platforms: [{ platform: 'linkedin', status: 'incomplete' }] } };
});

describe('a blocked post gets the IssueCard it never had', () => {
  it('names the missing connection, says why, and offers ONE Connect that starts the LinkedIn reconnect on Setup', async () => {
    const user = userEvent.setup();
    const { onNavigate } = renderDetail(base);
    const card = issueCard('LinkedIn not connected');
    expect(within(card).getByText(/connect it once and this post goes out/i)).toBeInTheDocument();
    const fix = within(card).getByRole('button', { name: 'Connect LinkedIn' });
    await user.click(fix);
    expect(onNavigate).toHaveBeenCalledWith('setup', 'linkedin', { action: 'reconnect' });
    // ONE connect control: the Delivery row now only says the word.
    expect(screen.queryByText('Blocked: connect LinkedIn')).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /connect linkedin/i })).toHaveLength(1);
  });

  it('carries a Details disclosure with the lane', () => {
    renderDetail(base);
    const card = issueCard('LinkedIn not connected');
    const summary = within(card).getByText('Details');
    expect(summary.tagName).toBe('SUMMARY');
    expect(within(card).getByText('Platform').nextSibling).toHaveTextContent('LinkedIn');
  });

  it('a calm, connected post shows no card', () => {
    healthData = { setup: { platforms: [{ platform: 'linkedin', status: 'connected' }] } };
    renderDetail(base);
    expect(screen.queryByText(/not connected/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /connect linkedin/i })).not.toBeInTheDocument();
  });
});

// 2026-11-01: a post opened from All-projects mode carries its clientId, and the detail judges
// it by THAT project's setup (lib/setupByClient.js), not by whichever project the bare health
// cache holds (the active one, mid-switch the previous one).
describe('a post from another project is judged by its own project\'s setup', () => {
  it('reads blocked when its own project lacks the lane, although the active project has it', () => {
    healthData = { setup: { platforms: [{ platform: 'linkedin', status: 'connected' }] } };
    renderDetail({ ...base, clientId: 'globex', clientName: 'Globex' }, {
      seed: [[['pendpost-health', 'globex'], { setup: { platforms: [{ platform: 'linkedin', status: 'incomplete' }] } }]],
    });
    const card = issueCard('LinkedIn not connected');
    expect(within(card).getByRole('button', { name: 'Connect LinkedIn' })).toBeInTheDocument();
  });

  it('reads calm when its own project has the lane, although the active project lacks it', () => {
    healthData = { setup: { platforms: [{ platform: 'linkedin', status: 'incomplete' }] } };
    renderDetail({ ...base, clientId: 'globex', clientName: 'Globex' }, {
      seed: [[['pendpost-health', 'globex'], { setup: { platforms: [{ platform: 'linkedin', status: 'connected' }] } }]],
    });
    expect(screen.queryByText(/not connected/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /connect linkedin/i })).not.toBeInTheDocument();
  });
});

describe('the Bluesky dead end goes away', () => {
  const reply = {
    ...base, id: 'b1', platforms: ['bluesky'], derivedState: 'publish-failed',
    radarReplyTo: { source: 'bluesky', url: 'https://bsky.app/profile/someone/post/1', externalId: 'at://x' },
    lastFailure: { lane: 'bluesky', at: '2026-11-01T08:00:00Z', code: 'not_connected', message: 'Bluesky is not connected (BLUESKY_IDENTIFIER / BLUESKY_APP_PASSWORD not set)', terminal: true, recovery: 'reconnect' },
    attempts: [{ platform: 'bluesky', ok: false, errorCode: 'not_connected' }],
  };

  it('reads "not connected", never "a permission is missing", and connects in place', async () => {
    const user = userEvent.setup();
    healthData = { setup: { platforms: [] } };
    const { onNavigate } = renderDetail(reply);
    const card = issueCard('Bluesky not connected');
    expect(screen.queryByText(/permission/i)).not.toBeInTheDocument();
    expect(within(card).getByText('not_connected')).toBeInTheDocument();
    expect(within(card).getByText('Failed attempts').nextSibling).toHaveTextContent('1');
    await user.click(within(card).getByRole('button', { name: 'Connect Bluesky' }));
    expect(onNavigate).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Connect Bluesky' })).toBeInTheDocument();
  });

  it('in German too', () => {
    healthData = { setup: { platforms: [] } };
    renderDetail(reply, { locale: 'de-CH' });
    const card = issueCard('Bluesky nicht verbunden');
    expect(within(card).getByRole('button', { name: 'Bluesky verbinden' })).toHaveTextContent(/^Verbinden$/);
    expect(screen.queryByText(/Berechtigung/)).not.toBeInTheDocument();
  });
});
