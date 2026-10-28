import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi } from 'vitest';
import Freigaben from '../Freigaben.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// A blocked card's disabled Approve names WHY in the owner's language: the same localized
// sentence as the blocker rows (problemCodes via lib/blockerText.js), never the engine's
// English line ("note text is 560 chars - Mastodon caps at 500 (set a shorter mastodonCaption)").
let validate = null;
vi.mock('../../lib/api.js', () => ({
  usePlatformValidate: () => ({ data: validate }),
  approvePost: vi.fn(),
  rejectPost: vi.fn(),
  markPosted: vi.fn(),
  lintText: vi.fn(() => Promise.resolve({ ok: true, clean: true, errors: 0, warnings: 0, findings: [] })),
  usePendpostHealth: () => ({ data: null }),
  useConfig: () => ({ data: null }),
  useAccounts: () => ({ data: null, isLoading: false, isError: false }),
}));

const post = {
  id: 'p1', campaign: 'spring', title: 'Blog post', caption: 'x', platforms: ['mastodon'], approval: 'pending',
  derivedState: 'draft', scheduledAt: '2026-11-01T10:00:00Z', type: 'text', image: null,
  media: { file: null, exists: false, bytes: null, url: null, cover: null, path: null },
};
const ENGINE_LINE = 'note text is 560 chars - Mastodon caps at 500 (set a shorter mastodonCaption)';

function renderCard(locale) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale={locale}>
        <TooltipProvider>
          <ConfirmProvider>
            <Freigaben campaigns={[{ id: 'spring', active: true, posts: [post] }]} onOpen={() => {}} />
          </ConfirmProvider>
        </TooltipProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe('Freigaben blocked Approve speaks the localized reason', () => {
  it('de-CH: the reason is the German blocker sentence, never the engine line', () => {
    validate = { ok: true, postId: 'p1', platforms: { mastodon: { ready: false, needsSetup: false, problems: [ENGINE_LINE], problemCodes: [{ code: 'validate.mastodonTooLong', params: { length: 560, max: 500 }, fix: 'edit' }], warnings: [] } } };
    renderCard('de-CH');
    const btn = screen.getByRole('button', { name: /^Nicht bereit:/ });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('aria-label', 'Nicht bereit: Der Mastodon-Text hat so, wie Mastodon zählt, 560 Zeichen (jeder Link zählt 23), und Mastodon nimmt höchstens 500. Kürze den Text im Feld "Beitragstext (Mastodon)".');
    expect(btn.getAttribute('title')).not.toMatch(/mastodonCaption|chars/);
  });

  it('an uncoded problem still reads as a plain sentence naming the platform', () => {
    validate = { ok: true, postId: 'p1', platforms: { mastodon: { ready: false, needsSetup: false, problems: [ENGINE_LINE], problemCodes: [null], warnings: [] } } };
    renderCard('en');
    expect(screen.getByRole('button', { name: 'Not ready: Mastodon would refuse this post as it is. Open the editor to fix it.' })).toBeDisabled();
  });

  // Without a Mastodon text of its own, the editor shows only the shared post text: the
  // reason names THAT field (params.override === false), not a Mastodon field the owner never sees.
  it('no Mastodon override: the reason names the shared "Beitragstext" field', () => {
    validate = { ok: true, postId: 'p1', platforms: { mastodon: { ready: false, needsSetup: false, problems: [ENGINE_LINE], problemCodes: [{ code: 'validate.mastodonTooLong', params: { length: 560, max: 500, override: false }, fix: 'edit' }], warnings: [] } } };
    renderCard('de-CH');
    expect(screen.getByRole('button', { name: /^Nicht bereit:/ })).toHaveAttribute('aria-label', 'Nicht bereit: Der Beitragstext hat so, wie Mastodon zählt, 560 Zeichen (jeder Link zählt 23), und Mastodon nimmt höchstens 500. Kürze den Text im Feld "Beitragstext".');
  });
});
