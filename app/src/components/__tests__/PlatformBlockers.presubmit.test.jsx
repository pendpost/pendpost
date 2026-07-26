import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { axeClean } from '../../test-utils/axe.js';
import { PlatformBlockers } from '../ui.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// Spec 09: PlatformBlockers accepts an optional `presubmit` prop (the SAME
// { ok, platforms:{ <p>: {ready,problems,warnings} } } shape platformValidate
// returns) and merges its per-platform rows into the existing panel - one
// panel, two sources. Rows carry { code, text } and resolve through
// blockers.presubmit.<code> locale strings (genuinely localized, unlike
// platformValidate's raw-English passthrough).

function renderBlockers(props, locale = 'en') {
  return render(
    <I18nProvider locale={locale}>
      <PlatformBlockers approval="approved" {...props} />
    </I18nProvider>,
  );
}

describe('PlatformBlockers presubmit merge (spec 09)', () => {
  it('renders a presubmit problem and warning as rows on the matching platform', () => {
    renderBlockers({
      platformValidate: { ok: true, postId: 'p1', platforms: { reddit: { ready: true, problems: [], warnings: [], needsSetup: false } } },
      presubmit: {
        ok: true,
        postId: 'p1',
        platforms: {
          reddit: {
            ready: false,
            problems: [{ code: 'restricted', text: 'restricted' }],
            warnings: [{ code: 'flairRequired', text: '' }],
          },
        },
      },
    });
    expect(screen.getByText(/This subreddit is restricted/)).toBeInTheDocument();
    expect(screen.getByText(/This subreddit requires a post flair/)).toBeInTheDocument();
  });

  it('interpolates the {text} value into the localized sentence', () => {
    renderBlockers({
      presubmit: {
        ok: true,
        postId: 'p1',
        platforms: { tiktok: { ready: false, problems: [{ code: 'captionLength', text: '2300/2200' }], warnings: [] } },
      },
    });
    expect(screen.getByText(/Caption is too long for this creator \(2300\/2200 characters\)/)).toBeInTheDocument();
  });

  it('maps the raw submissionType enum to a localized noun (en: self -> text)', () => {
    renderBlockers({
      presubmit: {
        ok: true,
        postId: 'p1',
        platforms: { reddit: { ready: false, problems: [{ code: 'submissionType', text: 'self' }], warnings: [] } },
      },
    });
    expect(screen.getByText('This subreddit only accepts text posts')).toBeInTheDocument();
  });

  it('maps the submissionType enum to a German noun (de-CH: self -> Text), never leaking the raw enum', () => {
    renderBlockers({
      presubmit: {
        ok: true,
        postId: 'p1',
        platforms: { reddit: { ready: false, problems: [{ code: 'submissionType', text: 'self' }], warnings: [] } },
      },
    }, 'de-CH');
    expect(screen.getByText('Dieser Subreddit akzeptiert nur Text-Beiträge')).toBeInTheDocument();
    expect(screen.queryByText(/self/)).not.toBeInTheDocument();
  });

  it('maps the raw subreddit_type enum to a German noun (de-CH: restricted -> eingeschränkt), never leaking the raw enum', () => {
    renderBlockers({
      presubmit: {
        ok: true,
        postId: 'p1',
        platforms: { reddit: { ready: false, problems: [{ code: 'restricted', text: 'restricted' }], warnings: [] } },
      },
    }, 'de-CH');
    expect(screen.getByText('Dieser Subreddit ist eingeschränkt - das Konto darf hier evtl. nicht posten')).toBeInTheDocument();
    // The English API token must never surface in the German sentence.
    expect(screen.queryByText(/restricted/)).not.toBeInTheDocument();
  });

  it('maps the private subreddit_type enum to a German noun (de-CH: private -> privat)', () => {
    renderBlockers({
      presubmit: {
        ok: true,
        postId: 'p1',
        platforms: { reddit: { ready: false, problems: [{ code: 'restricted', text: 'private' }], warnings: [] } },
      },
    }, 'de-CH');
    expect(screen.getByText('Dieser Subreddit ist privat - das Konto darf hier evtl. nicht posten')).toBeInTheDocument();
    expect(screen.queryByText(/private/)).not.toBeInTheDocument();
  });

  it('renders the title-length titleRule problem (spec §2: title over the subreddit limit)', () => {
    renderBlockers({
      presubmit: {
        ok: true,
        postId: 'p1',
        platforms: { reddit: { ready: false, problems: [{ code: 'titleRule', text: 'over 100 chars' }], warnings: [] } },
      },
    });
    expect(screen.getByText('Title doesn\'t meet this subreddit\'s rules (over 100 chars)')).toBeInTheDocument();
  });

  it('renders the needsScope degrade as one amber advisory row', () => {
    renderBlockers({
      presubmit: {
        ok: true,
        postId: 'p1',
        platforms: { reddit: { ready: null, problems: [], warnings: [{ code: 'needsScope', text: '' }] } },
      },
    });
    expect(screen.getByText('Authorize this connection to check the platform\'s rules before publishing')).toBeInTheDocument();
  });

  it('renders nothing when both platformValidate and presubmit are clean', () => {
    renderBlockers({
      platformValidate: { ok: true, postId: 'p1', platforms: { tiktok: { ready: true, problems: [], warnings: [], needsSetup: false } } },
      presubmit: { ok: true, postId: 'p1', platforms: { tiktok: { ready: true, problems: [], warnings: [] } } },
    });
    expect(screen.queryByText('Before publishing')).not.toBeInTheDocument();
  });

  it('renders nothing when presubmit has no reddit/tiktok platforms at all (an untargeted post)', () => {
    renderBlockers({
      platformValidate: { ok: true, postId: 'p1', platforms: { instagram: { ready: true, problems: [], warnings: [], needsSetup: false } } },
      presubmit: { ok: true, postId: 'p1', platforms: {} },
    });
    expect(screen.queryByText('Before publishing')).not.toBeInTheDocument();
  });

  it('omits presubmit rows when the read errored (ok:false), never crashing', () => {
    renderBlockers({
      platformValidate: { ok: true, postId: 'p1', platforms: { reddit: { ready: true, problems: [], warnings: [], needsSetup: false } } },
      presubmit: { ok: false, code: 'engine_failure', message: 'rules endpoint failed' },
    });
    // No presubmit-authored text leaks through, and platform-validate stays clean -> nothing renders.
    expect(screen.queryByText(/subreddit/i)).not.toBeInTheDocument();
    expect(screen.queryByText('Before publishing')).not.toBeInTheDocument();
  });

  it('shows presubmit problems even when the same lane also needs setup (both concerns coexist)', () => {
    renderBlockers({
      platformValidate: {
        ok: true,
        postId: 'p1',
        platforms: { reddit: { ready: false, problems: ['Reddit not connected'], warnings: [], needsSetup: true } },
      },
      presubmit: {
        ok: true,
        postId: 'p1',
        platforms: { reddit: { ready: false, problems: [{ code: 'restricted', text: 'restricted' }], warnings: [] } },
      },
      onNavigate: () => {},
    }, 'en');
    // The setup link collapses the raw platformValidate string...
    expect(screen.getByRole('button', { name: 'Set up Reddit' })).toBeInTheDocument();
    expect(screen.queryByText('Reddit not connected')).not.toBeInTheDocument();
    // ...but the presubmit problem still surfaces alongside it.
    expect(screen.getByText(/This subreddit is restricted/)).toBeInTheDocument();
  });

  it('renders the German (de-CH) translation for the same presubmit code', () => {
    renderBlockers({
      presubmit: {
        ok: true,
        postId: 'p1',
        platforms: { reddit: { ready: false, problems: [], warnings: [{ code: 'flairRequired', text: '' }] } },
      },
    }, 'de-CH');
    expect(screen.getByText(/Dieser Subreddit verlangt ein Flair/)).toBeInTheDocument();
  });

  it('has no axe violations with merged presubmit + platform-validate rows', async () => {
    const { container } = renderBlockers({
      platformValidate: { ok: true, postId: 'p1', platforms: { tiktok: { ready: false, problems: ['caption too long'], warnings: [], needsSetup: false } } },
      presubmit: {
        ok: true,
        postId: 'p1',
        platforms: { tiktok: { ready: false, problems: [{ code: 'privacy', text: 'PUBLIC_TO_EVERYONE' }], warnings: [{ code: 'needsScope', text: '' }] } },
      },
    });
    expect(await axeClean(container)).toHaveNoViolations();
  });
});
