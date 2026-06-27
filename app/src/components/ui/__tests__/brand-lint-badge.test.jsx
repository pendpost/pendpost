import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { axeClean } from '../../../test-utils/axe.js';
import BrandLintBadge from '../BrandLintBadge.jsx';
import { I18nProvider } from '../../../lib/i18n.js';

// The badge mirrors the publish-time gate (lib/scheduler.mjs lintBlock): it reads
// the LIVE server lint via lintText (one call per target platform) and shows a
// quiet error-count badge ONLY when some target platform trips a severity:'error'
// finding. Warnings are advisory and SILENT here, exactly like the gate. We mock
// lintText to return controlled brandLint envelopes so the tests assert the
// badge's presentation contract, not the network.
const lintText = vi.fn();

vi.mock('../../../lib/api.js', () => ({
  lintText: (...args) => lintText(...args),
}));

// brandLint envelope shape (lib/lint.mjs brandLint): { ok, clean, errors, warnings, findings }.
const envelope = ({ errors = 0, warnings = 0 } = {}) => ({
  ok: true,
  clean: errors === 0,
  errors,
  warnings,
  findings: [
    ...Array.from({ length: errors }, (_, i) => ({ rule: 'banned', severity: 'error', match: `x${i}`, index: i, hint: 'no' })),
    ...Array.from({ length: warnings }, (_, i) => ({ rule: 'soft', severity: 'warn', match: `w${i}`, index: i, hint: 'maybe' })),
  ],
});

function renderBadge(props = {}, { locale = 'en' } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale={locale}>
        <BrandLintBadge caption="hello" platforms={['instagram']} {...props} />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  lintText.mockReset();
});

describe('BrandLintBadge', () => {
  it('renders a quiet error-count badge with an advisory label when a target platform trips errors', async () => {
    lintText.mockResolvedValue(envelope({ errors: 1 }));
    renderBadge({ caption: 'bad caption', platforms: ['instagram'] });
    // The badge surfaces the error count.
    const badge = await screen.findByText(/1 brand error/i);
    expect(badge).toBeInTheDocument();
    // Its accessible label names it advisory, not a gate.
    const labelled = screen.getByRole('status');
    expect(labelled).toHaveAttribute('aria-label', expect.stringMatching(/advisory/i));
  });

  it('renders nothing when the caption is clean', async () => {
    lintText.mockResolvedValue(envelope({ errors: 0 }));
    const { container } = renderBadge({ caption: 'clean caption', platforms: ['instagram'] });
    await waitFor(() => expect(lintText).toHaveBeenCalled());
    // No badge text, no status role.
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(container.querySelector('[data-brand-lint-badge]')).toBeNull();
  });

  it('renders nothing when the caption has only warnings (warn-only is silent, matching the gate)', async () => {
    lintText.mockResolvedValue(envelope({ errors: 0, warnings: 3 }));
    renderBadge({ caption: 'warny caption', platforms: ['instagram'] });
    await waitFor(() => expect(lintText).toHaveBeenCalled());
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('shows an error when ANY target platform trips, mirroring the per-platform gate', async () => {
    // instagram clean, linkedin trips -> badge appears (error if ANY platform trips).
    lintText.mockImplementation((_text, platform) =>
      Promise.resolve(platform === 'linkedin' ? envelope({ errors: 2 }) : envelope({ errors: 0 })),
    );
    renderBadge({ caption: 'cap', platforms: ['instagram', 'linkedin'] });
    expect(await screen.findByRole('status')).toBeInTheDocument();
    // Lints each distinct target platform (mirrors lintBlock looping lane platforms).
    await waitFor(() => {
      expect(lintText).toHaveBeenCalledWith('cap', 'instagram');
      expect(lintText).toHaveBeenCalledWith('cap', 'linkedin');
    });
  });

  it('the badge contains no interactive descendant (sibling status, never interactive-in-interactive)', async () => {
    lintText.mockResolvedValue(envelope({ errors: 1 }));
    renderBadge({ caption: 'bad', platforms: ['instagram'] });
    const badge = await screen.findByRole('status');
    expect(badge.querySelector('button, a, input, select, textarea, [tabindex]')).toBeNull();
  });

  it('has no axe violations', async () => {
    lintText.mockResolvedValue(envelope({ errors: 1 }));
    const { container } = renderBadge({ caption: 'bad', platforms: ['instagram'] });
    await screen.findByRole('status');
    expect(await axeClean(container)).toHaveNoViolations();
  });

  it('uses the de-CH label (no raw key id, never an eszett) under the de-CH locale', async () => {
    lintText.mockResolvedValue(envelope({ errors: 1 }));
    renderBadge({ caption: 'bad', platforms: ['instagram'] }, { locale: 'de-CH' });
    const badge = await screen.findByRole('status');
    const label = badge.getAttribute('aria-label') || '';
    // Never a raw key id.
    expect(label).not.toMatch(/approvals\.lint\./);
    // Mandate A: real Swiss-German orthography - umlauts allowed, eszett never.
    expect(label).not.toMatch(/ß/);
  });
});
