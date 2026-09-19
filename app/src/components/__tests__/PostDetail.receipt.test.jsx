import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { axeClean } from '../../test-utils/axe.js';
import { I18nProvider } from '../../lib/i18n.js';
import { ReceiptGlyph } from '../PostDetail.jsx';

// Spec 51 (D2): the static per-platform signed-receipt glyph. It renders purely
// from post.receipt[platform] (sourced from plan_get, no extra network call) and,
// when a verify_post result is already on screen, overlays that platform's
// provenance ('verified' / 'content-changed' / 'invalid'). No standing chip, no
// "Check receipt" action - just this one glyph reusing the existing verify row.

const wrap = (ui, locale = 'en') => render(<I18nProvider locale={locale}>{ui}</I18nProvider>);
const receipt = { kid: 'abc123def4567890', payload: { outcome: { ok: true, platformId: '99', errorCode: null } } };

describe('ReceiptGlyph', () => {
  it('renders nothing without a receipt', () => {
    const { container } = wrap(<ReceiptGlyph />);
    expect(container.querySelector('[aria-label]')).toBeNull();
  });

  it('renders a static shield with a key tooltip when a receipt is present', () => {
    const { container } = wrap(<ReceiptGlyph receipt={receipt} />);
    const glyph = container.querySelector('[aria-label]');
    expect(glyph).not.toBeNull();
    expect(glyph.getAttribute('aria-label')).toContain('abc123def4567890');
    // No provenance overlay yet: default tone is 'ok' (the established
    // inline-Tailwind idiom, not a bespoke unbacked class).
    expect(glyph.querySelector('svg').getAttribute('class')).toContain('text-emerald-600');
  });

  it('reflects the verify_post provenance when present, with the matching tone color', () => {
    let c = wrap(<ReceiptGlyph receipt={receipt} provenance={{ signed: true, provenance: 'verified' }} />).container;
    let glyph = c.querySelector('[aria-label="Signed - verified"]');
    expect(glyph).not.toBeNull();
    expect(glyph.querySelector('svg').getAttribute('class')).toContain('text-emerald-600');

    c = wrap(<ReceiptGlyph receipt={receipt} provenance={{ signed: true, provenance: 'content-changed' }} />).container;
    glyph = c.querySelector('[aria-label="Signed - content changed since"]');
    expect(glyph).not.toBeNull();
    expect(glyph.querySelector('svg').getAttribute('class')).toContain('text-amber-700');

    c = wrap(<ReceiptGlyph receipt={receipt} provenance={{ signed: true, provenance: 'invalid' }} />).container;
    glyph = c.querySelector('[aria-label="Signature invalid"]');
    expect(glyph).not.toBeNull();
    expect(glyph.querySelector('svg').getAttribute('class')).toContain('text-red-600');
  });

  it('renders nothing when provenance is none', () => {
    const { container } = wrap(<ReceiptGlyph receipt={receipt} provenance={{ signed: false, provenance: 'none' }} />);
    expect(container.querySelector('[aria-label]')).toBeNull();
  });

  it('is accessible', async () => {
    const { container } = wrap(<ReceiptGlyph receipt={receipt} />);
    await axeClean(container);
  });

  it('resolves every new key in both locales (Swiss ss, no eszett)', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const en = JSON.parse(readFileSync(path.resolve(here, '../../locales/en.json'), 'utf8'));
    const de = JSON.parse(readFileSync(path.resolve(here, '../../locales/de-CH.json'), 'utf8'));
    const flat = (o) => (o.strings && typeof o.strings === 'object' ? o.strings : o);
    const enK = flat(en); const deK = flat(de);
    const keys = ['postDetail.receipt.verified', 'postDetail.receipt.contentChanged', 'postDetail.receipt.invalid', 'postDetail.receipt.tooltip', 'activity.attest.title', 'activity.error.stale_content'];
    for (const k of keys) { expect(enK[k], `en ${k}`).toBeTruthy(); expect(deK[k], `de-CH ${k}`).toBeTruthy(); }
    for (const k of keys) expect(deK[k]).not.toMatch(/ß/); // Swiss uses ss, never the eszett (this regex enforces it)
  });
});
