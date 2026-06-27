import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// NFR-LIC-02: local-first means NO runtime font CDN. Fonts are self-hosted static
// assets; index.html must not preconnect/link to Google Fonts, and index.css must
// declare the family via @font-face from a vendored woff2.
const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('NFR-LIC-02: self-hosted fonts, no runtime CDN', () => {
  it('index.html loads no fonts from a CDN', () => {
    const html = fs.readFileSync(path.join(APP_ROOT, 'index.html'), 'utf8');
    expect(html).not.toMatch(/fonts\.googleapis\.com/);
    expect(html).not.toMatch(/fonts\.gstatic\.com/);
  });

  it('index.css self-hosts Inter via @font-face from a local woff2', () => {
    const css = fs.readFileSync(path.join(APP_ROOT, 'src', 'index.css'), 'utf8');
    expect(css).toMatch(/@font-face/);
    expect(css).toMatch(/Inter/);
    expect(css).toMatch(/\.woff2/);
  });

  it('the vendored Inter woff2 + OFL license exist', () => {
    expect(fs.existsSync(path.join(APP_ROOT, 'src', 'fonts', 'inter-latin-variable.woff2'))).toBe(true);
    expect(fs.existsSync(path.join(APP_ROOT, 'src', 'fonts', 'OFL.txt'))).toBe(true);
  });
});
