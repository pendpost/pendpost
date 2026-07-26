import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { PlatformBlockers } from '../ui.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// Spec 39 §4j: platformValidate rows localize through the PARALLEL problemCodes[]
// (blockers.validate.* keys), one row at a time - problems[] stays the stable
// English REST/MCP face. An uncoded row (null) and an unknown code both fall back
// to the raw English problem, never a blank row.

function renderBlockers(platforms, locale = 'en') {
  return render(
    <I18nProvider locale={locale}>
      <PlatformBlockers approval="approved" platformValidate={{ ok: true, postId: 'p1', platforms }} />
    </I18nProvider>,
  );
}

describe('PlatformBlockers - validate problemCodes (spec 39 §4j)', () => {
  it('renders a coded row via its blockers.validate.* key with params (de-CH)', () => {
    renderBlockers({
      youtube: {
        ready: false,
        problems: ['youtube does not publish an image post (the image TYPE is for reddit, pinterest and instagram)'],
        problemCodes: [{ code: 'validate.imageTypeLane', params: { platform: 'youtube' } }],
        warnings: [],
        needsSetup: false,
      },
    }, 'de-CH');
    expect(screen.getByText(/youtube veröffentlicht keinen Bild-Beitrag/)).toBeInTheDocument();
  });

  it('renders the IG url-missing code localized (en)', () => {
    renderBlockers({
      instagram: {
        ready: false,
        problems: ['Instagram needs a public image URL (set imageUrl; the engine hosts no media)'],
        problemCodes: [{ code: 'validate.igImageUrlMissing', params: {} }],
        warnings: [],
        needsSetup: false,
      },
    });
    expect(screen.getByText(/Instagram needs a public image URL \(set Image URL/)).toBeInTheDocument();
  });

  it('an uncoded row (null) falls back to the raw English problem', () => {
    renderBlockers({
      instagram: {
        ready: false,
        problems: ['local media file is missing'],
        problemCodes: [null],
        warnings: [],
        needsSetup: false,
      },
    }, 'de-CH');
    expect(screen.getByText('local media file is missing')).toBeInTheDocument();
  });

  it('an unknown code falls back to the raw problem, never a blank row', () => {
    renderBlockers({
      instagram: {
        ready: false,
        problems: ['some future problem string'],
        problemCodes: [{ code: 'validate.notYetInvented', params: {} }],
        warnings: [],
        needsSetup: false,
      },
    });
    expect(screen.getByText('some future problem string')).toBeInTheDocument();
  });

  it('a payload WITHOUT problemCodes (older server) renders problems verbatim', () => {
    renderBlockers({
      instagram: { ready: false, problems: ['a plain problem'], warnings: [], needsSetup: false },
    });
    expect(screen.getByText('a plain problem')).toBeInTheDocument();
  });
});
