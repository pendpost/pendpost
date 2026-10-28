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
        problems: ['youtube does not publish an image post (the image TYPE is for reddit, pinterest, instagram, x, telegram, discord and mastodon)'],
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

  // Warnings localize the same way through warningCodes[] (advise.* codes): the LinkedIn
  // no-image advisory used to show its English engine line in a de-CH Studio.
  it('renders a coded warning in German, never the engine line', () => {
    renderBlockers({
      linkedin: {
        ready: false, problems: [], problemCodes: [], needsSetup: false,
        warnings: ['no image set - the LinkedIn article card will have no thumbnail (set post.image to the Cloudinary hero URL)'],
        warningCodes: [{ code: 'advise.linkedinNoImage', params: {} }],
      },
    }, 'de-CH');
    expect(screen.getByText('Kein Bild gesetzt: Die LinkedIn-Linkvorschau erscheint ohne Vorschaubild. Füge im Editor ein Bild hinzu')).toBeInTheDocument();
    expect(screen.queryByText(/Cloudinary/)).toBeNull();
  });

  it('a YouTube category warning names the category in the owner\'s language', () => {
    renderBlockers({
      youtube: {
        ready: false, problems: [], problemCodes: [], needsSetup: false,
        warnings: ['YouTube category Education (27) will be sent (set on this post)'],
        warningCodes: [{ code: 'advise.youtubeCategory', params: { youtubeCategoryId: '27', category: 'Education (27)' } }],
      },
    }, 'de-CH');
    expect(screen.getByText('Die YouTube-Kategorie Bildung wird mit diesem Beitrag gesendet')).toBeInTheDocument();
  });

  it('an uncoded warning still falls back to its line', () => {
    renderBlockers({ x: { ready: false, problems: [], problemCodes: [], needsSetup: false, warnings: ['a plain warning'], warningCodes: [null] } });
    expect(screen.getByText('a plain warning')).toBeInTheDocument();
  });

  // Brand-lint rows name the rule by its human name, never the slug ("broken-link").
  it('a brand-lint blocker names the rule in words', () => {
    renderBlockers({
      linkedin: {
        ready: false, needsSetup: false, warnings: [],
        problems: ['brand-lint error (broken-link) on the linkedin text - approval is refused until it is fixed: ...'],
        problemCodes: [{ code: 'validate.brandLint', params: { platform: 'LinkedIn', rule: 'broken-link' }, fix: 'edit' }],
      },
    }, 'de-CH');
    expect(screen.getByText(/Markenregel "Kaputter Link"/)).toBeInTheDocument();
    expect(screen.queryByText(/broken-link/)).toBeNull();
  });
});
