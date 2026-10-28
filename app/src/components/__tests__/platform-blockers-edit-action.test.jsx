import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { PlatformBlockers } from '../ui.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// No dead ends in the Before-publishing panel: every lane with a content blocker the owner can
// fix (a caption over the cap, a missing image link) gets the ONE action that recovers it, Edit,
// which opens the editor on the post. A not-connected lane keeps its Setup link instead, and a
// surface that IS the editor (no onEdit) shows no Edit at all.
const MASTODON_LONG = {
  ready: false,
  needsSetup: false,
  problems: ['note text is 502 chars - Mastodon caps at 500 (set a shorter mastodonCaption)'],
  warnings: [],
};

function renderBlockers(platforms, props = {}, locale = 'en') {
  return render(
    <I18nProvider locale={locale}>
      <PlatformBlockers approval="approved" showApproval={false} platformValidate={{ ok: true, postId: 'p1', platforms }} {...props} />
    </I18nProvider>,
  );
}

describe('PlatformBlockers Edit action', () => {
  it('a content blocker gets Edit, which opens the editor', async () => {
    const onEdit = vi.fn();
    const user = userEvent.setup();
    renderBlockers({ mastodon: MASTODON_LONG }, { onEdit }, 'de-CH');
    await user.click(screen.getByRole('button', { name: 'Bearbeiten' }));
    expect(onEdit).toHaveBeenCalledTimes(1);
  });

  it('one Edit per lane with blockers, none for a clean lane', () => {
    renderBlockers({
      mastodon: MASTODON_LONG,
      instagram: { ready: false, needsSetup: false, problems: ['Instagram needs a public image URL'], problemCodes: [{ code: 'validate.igImageUrlMissing', params: {} }], warnings: [] },
      x: { ready: true, needsSetup: false, problems: [], warnings: [] },
    }, { onEdit: vi.fn() });
    expect(screen.getAllByRole('button', { name: 'Edit' })).toHaveLength(2);
  });

  it('a not-connected lane gets its Setup link, not Edit', () => {
    renderBlockers({ telegram: { ready: false, needsSetup: true, problems: ['telegram: not connected'], warnings: [] } }, { onEdit: vi.fn(), onNavigate: vi.fn() });
    expect(screen.getByRole('button', { name: 'Connect Telegram' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
  });

  it('a warning alone gets no Edit, and the editor itself (no onEdit) shows none', () => {
    renderBlockers({ x: { ready: true, needsSetup: false, problems: [], warnings: ['heads up'] } }, { onEdit: vi.fn() });
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
  });

  it('without onEdit (the Composer) no Edit renders', () => {
    renderBlockers({ mastodon: MASTODON_LONG });
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
  });

  // The engine names each problem's fix: the row's action follows it, never a dead button.
  it('fix:setup offers Setup on that lane, fix:wait offers nothing', async () => {
    const onNavigate = vi.fn();
    const user = userEvent.setup();
    renderBlockers({
      instagram: { ready: false, needsSetup: false, problems: ['no public media host'], problemCodes: [{ code: 'validate.igImageUrlMissing', params: {}, fix: 'setup' }], warnings: [] },
      youtube: { ready: false, needsSetup: false, problems: ['still processing'], problemCodes: [{ code: 'validate.stillProcessing', params: {}, fix: 'wait' }], warnings: [] },
    }, { onEdit: vi.fn(), onNavigate });
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Setup' }));
    expect(onNavigate).toHaveBeenCalledWith('setup', 'instagram');
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });

  it('fix:edit offers Edit', () => {
    renderBlockers({ instagram: { ready: false, needsSetup: false, problems: ['x'], problemCodes: [{ code: 'validate.igImageUrlMissing', params: {}, fix: 'edit' }], warnings: [] } }, { onEdit: vi.fn() });
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
  });

  // A blocker and an advisory must look different (not only to a screen reader), and the
  // Edit link sits INSIDE the row it fixes.
  it('a blocker reads in the error ink with Edit inside its row; an advisory reads neutral', () => {
    renderBlockers({
      mastodon: { ...MASTODON_LONG, problemCodes: [{ code: 'validate.mastodonTooLong', params: { length: 560, max: 500 }, fix: 'edit' }], warnings: ['heads up'], warningCodes: [null] },
    }, { onEdit: vi.fn() });
    const edit = screen.getByRole('button', { name: 'Edit' });
    const blockerRow = edit.closest('li');
    expect(blockerRow).toHaveClass('text-red-600');
    expect(blockerRow).toHaveTextContent(/Mastodon takes at most 500/);
    expect(blockerRow.querySelector('svg.lucide-octagon-alert, svg.lucide-alert-octagon')).not.toBeNull();
    const advisory = screen.getByText('heads up').closest('li');
    expect(advisory).not.toHaveClass('text-red-600');
    expect(advisory).not.toHaveClass('text-amber-700');
    expect(advisory.querySelector('button')).toBeNull();
  });
});
