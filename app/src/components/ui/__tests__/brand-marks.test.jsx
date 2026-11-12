import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PLATFORM_META } from '../../ui.jsx';
import { BrandMark } from '../BrandMark.jsx';
import { marks } from '../brand-marks.json';

// lucide has no brand glyphs since 1.0, so every platform mark comes from brand-marks.json.
describe('platform brand marks', () => {
  it('every platform in PLATFORM_META has a mark that draws something', () => {
    for (const [name, meta] of Object.entries(PLATFORM_META)) {
      expect(marks[name], name).toBeTruthy();
      const { container } = render(<meta.Icon size={13} aria-label={meta.label} />);
      const svg = container.querySelector('svg');
      expect(svg.getAttribute('data-brand'), name).toBe(name);
      expect(svg.getAttribute('role'), name).toBe('img');
      expect(svg.querySelector('path, circle, rect'), name).not.toBeNull();
    }
  });

  it('an unlabelled mark is hidden from assistive tech', () => {
    const { container } = render(<BrandMark name="youtube" />);
    expect(container.querySelector('svg').getAttribute('aria-hidden')).toBe('true');
  });

  it('no app source imports a brand glyph from lucide-react', () => {
    const BRANDS = /\b(Facebook|Instagram|Linkedin|Youtube|Twitter|Github|Gitlab|Twitch|Dribbble|Figma|Slack|Chrome|Codepen|Trello|Framer|Pocket)\b/;
    const walk = (dir) => readdirSync(dir).flatMap((e) => {
      const p = join(dir, e);
      return statSync(p).isDirectory() ? walk(p) : /\.(jsx?|tsx?)$/.test(p) ? [p] : [];
    });
    const offenders = walk(join(__dirname, '../../..')).filter((f) => {
      const src = readFileSync(f, 'utf8');
      return [...src.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]lucide-react['"]/g)].some((m) => BRANDS.test(m[1]));
    });
    expect(offenders).toEqual([]);
  });
});
