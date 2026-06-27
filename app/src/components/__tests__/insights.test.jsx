import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { axeClean } from '../../test-utils/axe.js';
import Insights from '../Insights.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// Insights shows the fabricated metrics the mock driver produces. When any lane
// resolves to mock, a single quiet provenance footnote must disclose that the
// shown numbers are fabricated and do not reflect real platform data (A7,
// US-ONB-07). B8 adds digest Copy/Download controls and a client-side
// per-platform totals strip. We mock the data layer so the tests assert the
// component's behavior, not the network. Strings resolve through the default
// English i18n context (no provider needed).
let insightsData;
let digestData;

vi.mock('../../lib/api.js', () => ({
  useInsights: () => ({
    data: insightsData,
    isLoading: false,
    isError: false,
    error: null,
  }),
  useDigest: () => ({ data: digestData }),
  fetchInsights: vi.fn(),
}));

const SINGLE_ITEM = {
  lastFetch: '2026-06-16T08:00:00.000Z',
  metricLabels: { likes: 'Likes' },
  items: [
    {
      campaign: 'acme-launch',
      postId: 'p1',
      platform: 'linkedin',
      caption: 'Hello world',
      metrics: { likes: 12 },
      history: [],
      fetchedAt: '2026-06-16T08:00:00.000Z',
    },
  ],
};

// Two platforms (linkedin + instagram), each with two posts carrying numeric
// metrics so the per-platform sums are non-trivial and order-independent.
const MULTI_PLATFORM = {
  lastFetch: '2026-06-16T08:00:00.000Z',
  metricLabels: { likes: 'Likes', comments: 'Comments' },
  items: [
    {
      campaign: 'acme-launch',
      postId: 'li-1',
      platform: 'linkedin',
      caption: 'LI one',
      metrics: { likes: 10, comments: 2 },
      history: [],
      fetchedAt: '2026-06-16T08:00:00.000Z',
    },
    {
      campaign: 'acme-launch',
      postId: 'li-2',
      platform: 'linkedin',
      caption: 'LI two',
      metrics: { likes: 5, comments: 3 },
      history: [],
      fetchedAt: '2026-06-16T08:00:00.000Z',
    },
    {
      campaign: 'acme-launch',
      postId: 'ig-1',
      platform: 'instagram',
      caption: 'IG one',
      metrics: { likes: 100, comments: 7 },
      history: [],
      fetchedAt: '2026-06-16T08:00:00.000Z',
    },
  ],
};

function renderInsights(props = {}, { locale = 'en' } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <I18nProvider locale={locale}>
      <QueryClientProvider client={qc}>
        <TooltipProvider>
          <Insights active platformFilter={[]} campaignFilter="all" {...props} />
        </TooltipProvider>
      </QueryClientProvider>
    </I18nProvider>,
  );
}

beforeEach(() => {
  insightsData = SINGLE_ITEM;
  digestData = null;
});

// Mock is gone from the product: real instances are always live, so Insights no
// longer carries any "mock"/"fabricated" provenance marker or Mode badge.
describe('Insights has no mock provenance UI', () => {
  it('renders neither a fabricated-data footnote nor a Mock badge', () => {
    renderInsights();
    expect(screen.queryByText(/fabricated/i)).not.toBeInTheDocument();
    expect(screen.queryByText('Mock')).not.toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = renderInsights();
    expect(await axeClean(container)).toHaveNoViolations();
  });
});

// B8 (US-INS-05): per-platform totals strip computed CLIENT-SIDE over the
// already-filtered items array. It must respect platformFilter + campaignScope
// (it sums the same rows the user can see) and omit platforms with no items.
describe('Insights per-platform totals strip (B8)', () => {
  beforeEach(() => {
    insightsData = MULTI_PLATFORM;
  });

  it('renders a labelled totals region summing each numeric metric per platform', () => {
    renderInsights();
    const strip = screen.getByRole('region', { name: /per-platform totals/i });
    expect(strip).toBeInTheDocument();
    // LinkedIn likes: 10 + 5 = 15; comments: 2 + 3 = 5.
    expect(strip).toHaveTextContent('LinkedIn');
    expect(strip).toHaveTextContent('15');
    expect(strip).toHaveTextContent('5');
    // Instagram likes: 100; comments: 7.
    expect(strip).toHaveTextContent('Instagram');
    expect(strip).toHaveTextContent('100');
    expect(strip).toHaveTextContent('7');
  });

  it('respects platformFilter so only the filtered platform totals appear and the sums match the visible rows', () => {
    renderInsights({ platformFilter: ['instagram'] });
    const strip = screen.getByRole('region', { name: /per-platform totals/i });
    // Only Instagram remains; its totals (100 / 7) show...
    expect(strip).toHaveTextContent('Instagram');
    expect(strip).toHaveTextContent('100');
    // ...and the filtered-out LinkedIn platform is omitted entirely.
    expect(strip).not.toHaveTextContent('LinkedIn');
    // The visible-row total can never include the now-hidden LinkedIn sum (15).
    expect(strip).not.toHaveTextContent('15');
  });

  it('omits the totals strip entirely when there are no items', () => {
    insightsData = { ...MULTI_PLATFORM, items: [] };
    renderInsights();
    expect(screen.queryByRole('region', { name: /per-platform totals/i })).not.toBeInTheDocument();
  });

  it('has no axe violations with the totals strip present', async () => {
    const { container } = renderInsights();
    expect(await axeClean(container)).toHaveNoViolations();
  });
});

// US-I18N-01 / US-INS-01: metric labels must localize through the metric.* locale
// keys, not stay pinned to the English envelope metricLabels. The metric.* keys
// hold real Swiss-German umlauts (Kommentare) in the de-CH pack; English is the
// stable baseline. metricLabel() resolves the per-metric locale key first,
// falling back to the envelope label only for an unknown metric.
describe('Insights metric-label localization (US-I18N-01)', () => {
  beforeEach(() => {
    insightsData = MULTI_PLATFORM;
  });

  it('renders the English metric label under the English locale', () => {
    renderInsights({}, { locale: 'en' });
    expect(screen.getAllByText('Comments').length).toBeGreaterThan(0);
    expect(screen.queryByText('Kommentare')).not.toBeInTheDocument();
  });

  it('renders the de-CH metric label (Kommentare) under the de-CH locale', () => {
    renderInsights({}, { locale: 'de-CH' });
    expect(screen.getAllByText('Kommentare').length).toBeGreaterThan(0);
    // The English envelope label must no longer leak through in German.
    expect(screen.queryByText('Comments')).not.toBeInTheDocument();
  });
});

// B8 (US-INS-05): digest Copy + Download controls. Copy writes the digest to
// navigator.clipboard; Download builds a text/markdown Blob via
// URL.createObjectURL, clicks a synthesized <a download>, then revokes the URL.
// jsdom ships neither clipboard nor URL.createObjectURL, so we stub them.
describe('Insights digest Copy/Download controls (B8)', () => {
  let writeText;
  let createObjectURL;
  let revokeObjectURL;
  let realCreateElement;

  beforeEach(() => {
    digestData = { digest: '# Weekly digest\n- one\n- two', generatedAt: '2026-06-16T08:00:00.000Z' };

    writeText = vi.fn(() => Promise.resolve());

    createObjectURL = vi.fn(() => 'blob:mock-url');
    revokeObjectURL = vi.fn();
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;

    realCreateElement = document.createElement.bind(document);
  });

  afterEach(() => {
    // Always restore document.createElement so a failed Download test never
    // leaks a self-referential spy into the next test (infinite recursion).
    vi.restoreAllMocks();
  });

  it('hides both controls when the digest is absent (guard preserved)', () => {
    digestData = null;
    renderInsights();
    expect(screen.queryByRole('button', { name: /copy/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /download/i })).not.toBeInTheDocument();
  });

  it('Copy writes the digest text to navigator.clipboard', async () => {
    const user = userEvent.setup();
    // userEvent.setup() installs its own clipboard stub, so override AFTER setup
    // to assert the component's writeText call lands on our spy.
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    renderInsights();
    await user.click(screen.getByRole('button', { name: /copy/i }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('# Weekly digest\n- one\n- two'));
  });

  it('Download creates an object URL, clicks a synthesized <a download>, then revokes the URL', async () => {
    const clicks = [];
    const createElementSpy = vi.spyOn(document, 'createElement').mockImplementation((tag) => {
      const el = realCreateElement(tag);
      if (tag === 'a') {
        el.click = vi.fn(() => clicks.push({ href: el.href, download: el.download }));
      }
      return el;
    });

    const user = userEvent.setup();
    renderInsights();
    await user.click(screen.getByRole('button', { name: /download/i }));

    await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1));
    // The Blob handed to createObjectURL is a text/markdown blob.
    const blobArg = createObjectURL.mock.calls[0][0];
    expect(blobArg).toBeInstanceOf(Blob);
    expect(blobArg.type).toMatch(/markdown/);
    // A synthesized <a download> was clicked with the date-stamped filename...
    expect(clicks).toHaveLength(1);
    expect(clicks[0].download).toBe('pendpost-digest-2026-06-16.md');
    // ...and the object URL was revoked afterwards (no leak).
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-url');

    createElementSpy.mockRestore();
  });

  it('has no axe violations with the digest controls present', async () => {
    const { container } = renderInsights();
    expect(await axeClean(container)).toHaveNoViolations();
  });
});
