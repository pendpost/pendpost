import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { LintPanel } from '../Composer.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// The editor opened from a Mastodon blocker showed the lint line in raw English, and it
// contradicted the blocker: "560 chars (cap 500 for mastodon) - ... will be truncated at
// publish". A capped lane refuses an over-long text, it never truncates. The line now says so
// in the owner's language.
const finding = (rule, match) => ({ rule, severity: 'warn', match, index: 500, hint: 'Caption is over the platform\'s cap and will be truncated at publish. Trim it or split the thought.' });

function renderPanel(findings, locale) {
  return render(
    <I18nProvider locale={locale}>
      <LintPanel lint={{ ok: true, clean: false, findings }} />
    </I18nProvider>,
  );
}

describe('LintPanel over-the-cap line', () => {
  it('de-CH: says the text is too long to publish on that platform, no truncation claim', () => {
    renderPanel([finding('caption-length', '560 chars (cap 500 for mastodon)')], 'de-CH');
    expect(screen.getByText('Dieser Text hat 560 Zeichen, und Mastodon nimmt höchstens 500. Kürze ihn, sonst kann er dort nicht erscheinen.')).toBeInTheDocument();
    expect(screen.queryByText(/truncated|chars \(cap/)).toBeNull();
  });

  it('en: the X hard cap reads the same way', () => {
    renderPanel([{ ...finding('caption-hard-cap', '300 chars (hard cap 280 on x)'), severity: 'error' }], 'en');
    expect(screen.getByText('This text has 300 characters, and X takes at most 280. Shorten it, or it cannot publish there.')).toBeInTheDocument();
  });

  it('without a platform: the general sentence', () => {
    renderPanel([finding('caption-length', '2300 chars (cap 2200)')], 'en');
    expect(screen.getByText('This text has 2300 characters, more than the 2200 most platforms take. Shorten it.')).toBeInTheDocument();
  });
});
