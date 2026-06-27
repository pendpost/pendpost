import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect } from 'vitest';
import { axeClean } from '../../test-utils/axe.js';
import ClientBand from '../ClientBand.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { I18nProvider } from '../../lib/i18n.js';
import { bestContrastOn, parseHex } from '../../lib/theme.js';
import { EYEBROW } from '../ui.jsx';

// B4 — always-on per-client header band. ClientBand is purely presentational: it
// is handed the active client (or null) and renders the displayName + logo/monogram
// on an accent tint, contrast-safe foreground (bestContrastOn). It is read-only
// signage (switching stays in the sidebar / Cmd-K), so it carries NO switch control.

function renderBand(props = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <I18nProvider locale="en">
      <QueryClientProvider client={qc}>
        <TooltipProvider>
          <ClientBand {...props} />
        </TooltipProvider>
      </QueryClientProvider>
    </I18nProvider>,
  );
}

const ACME = { id: 'acme', displayName: 'Acme Retail', status: 'active', accent: '#22566d' };

describe('ClientBand', () => {
  it('renders the active client displayName', () => {
    renderBand({ client: ACME });
    expect(screen.getByText('Acme Retail')).toBeInTheDocument();
  });

  it('tints an element with the client accent and uses the contrast-safe foreground', () => {
    const { container } = renderBand({ client: ACME });
    // jsdom serializes inline style colors to rgb(); compare on the parsed RGB so
    // the assertion is independent of hex-vs-rgb representation.
    const toRgb = (hex) => {
      const c = parseHex(hex);
      return `rgb(${c.r}, ${c.g}, ${c.b})`;
    };
    const accentRgb = toRgb(ACME.accent);
    // Some element carries the client accent as a background color.
    const tinted = [...container.querySelectorAll('*')].find((el) => el.style.backgroundColor === accentRgb);
    expect(tinted).toBeTruthy();
    // The contrast-safe foreground (bestContrastOn) is applied for text on the accent.
    const fgRgb = toRgb(bestContrastOn(parseHex(ACME.accent)).fg);
    const usesContrast = [...container.querySelectorAll('*')].some((el) => el.style.color === fgRgb);
    expect(usesContrast).toBe(true);
  });

  it('degrades to a neutral no-client state without crashing and never implies a wrong client', () => {
    const { container } = renderBand({ client: null });
    // No throw, something renders, and no stale/other client name leaks in.
    expect(container).toBeTruthy();
    expect(screen.queryByText('Acme Retail')).not.toBeInTheDocument();
    // A neutral "no client" label is shown (English baseline).
    expect(screen.getByText(/no project/i)).toBeInTheDocument();
  });

  it('does not crash on a registry-error / undefined client', () => {
    expect(() => renderBand({ client: undefined })).not.toThrow();
  });

  it('renders the no-client eyebrow with the canonical EYEBROW token (no 11px fork)', () => {
    renderBand({ client: null });
    const eyebrow = screen.getByText(/active project/i);
    expect(eyebrow.className).toBe(EYEBROW);
  });

  it('renders the active eyebrow at the canonical 11px and never dims the contrast-safe fg with opacity', () => {
    renderBand({ client: ACME });
    const eyebrow = screen.getByText(/active project/i);
    // Size matches the EYEBROW token (11px), not the old 10px fork.
    expect(eyebrow.className).toContain('text-[11px]');
    expect(eyebrow.className).not.toContain('text-[10px]');
    // opacity-80 erodes bestContrastOn below AA on a validated mid-tone accent: gone.
    expect(eyebrow.className).not.toContain('opacity-80');
    expect(eyebrow.className).not.toMatch(/opacity-/);
  });

  it('has no axe violations (active client)', async () => {
    const { container } = renderBand({ client: ACME });
    expect(await axeClean(container)).toHaveNoViolations();
  });

  it('has no axe violations (no client)', async () => {
    const { container } = renderBand({ client: null });
    expect(await axeClean(container)).toHaveNoViolations();
  });
});
