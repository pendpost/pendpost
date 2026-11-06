import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SPOTS, SPOT_EVENT, PULSE_CLASS, jumpToSpot } from '../spotJump.js';
import { ICON_MAP } from '../../components/ui/ReleaseArt.jsx';

// "Show me" (docs/specs/whats-new.md): every `go` in the shipped notes must be a spot the
// Studio knows, every icon name the engine allows must have a glyph, and the jump opens the
// page, then pulses the spot once it renders, or just opens the page when it never does.
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../../..');
const notes = JSON.parse(fs.readFileSync(path.join(root, 'lib/whats-new.json'), 'utf8'));
// ICONS lives in lib/whats-new.mjs, which imports node-only modules; read the frozen list.
const mjs = fs.readFileSync(path.join(root, 'lib/whats-new.mjs'), 'utf8');
const ICONS = JSON.parse(`[${mjs.match(/export const ICONS = Object\.freeze\(\[([\s\S]*?)\]\)/)[1].replace(/'/g, '"').replace(/,\s*$/, '')}]`);

describe('whats-new data vs the Studio', () => {
  it('every go in lib/whats-new.json is a spot in SPOTS', () => {
    const gos = notes.releases.flatMap((r) => r.items.map((it) => it.go).filter(Boolean));
    expect(gos.length).toBeGreaterThan(0);
    for (const go of gos) expect(SPOTS, `go "${go}"`).toHaveProperty(go);
  });

  it('every ICONS name has a glyph in ICON_MAP, and every used icon too', () => {
    expect(ICONS.length).toBeGreaterThan(10);
    for (const name of ICONS) expect(ICON_MAP, `icon "${name}"`).toHaveProperty(name);
    for (const r of notes.releases) for (const it of r.items) expect(ICON_MAP).toHaveProperty(it.icon);
  });
});

describe('jumpToSpot', () => {
  let events;
  const onSpot = (e) => events.push(e.detail);
  beforeEach(() => {
    vi.useFakeTimers();
    events = [];
    window.addEventListener(SPOT_EVENT, onSpot);
    window.location.hash = '';
  });
  afterEach(() => {
    window.removeEventListener(SPOT_EVENT, onSpot);
    document.body.innerHTML = '';
    vi.useRealTimers();
  });

  it('sets the hash, tells the app the page and view, then pulses the spot and lets it go', () => {
    const el = document.createElement('div');
    el.setAttribute('data-spot', 'bulk-select');
    el.scrollIntoView = vi.fn();
    document.body.appendChild(el);
    expect(jumpToSpot('bulk-select')).toBe(true);
    expect(window.location.hash).toBe('#planner');
    expect(events).toEqual([{ key: 'bulk-select', page: 'planner', view: 'list' }]);
    vi.advanceTimersByTime(50);
    expect(el.scrollIntoView).toHaveBeenCalledWith(expect.objectContaining({ block: 'center' }));
    expect(el.classList.contains(PULSE_CLASS)).toBe(true);
    vi.advanceTimersByTime(2000);
    expect(el.classList.contains(PULSE_CLASS)).toBe(false);
  });

  it('waits for a spot that renders a moment later', () => {
    expect(jumpToSpot('radar')).toBe(true);
    expect(window.location.hash).toBe('#radar');
    vi.advanceTimersByTime(300);
    const el = document.createElement('div');
    el.setAttribute('data-spot', 'radar');
    document.body.appendChild(el);
    vi.advanceTimersByTime(50);
    expect(el.classList.contains(PULSE_CLASS)).toBe(true);
  });

  it('a spot that never renders just opens the page, without an error', () => {
    expect(() => {
      jumpToSpot('fix-tray');
      vi.advanceTimersByTime(3000);
    }).not.toThrow();
    expect(window.location.hash).toBe('#planner');
    expect(events[0]).toEqual({ key: 'fix-tray', page: 'planner', view: null });
  });

  it('an unknown key does nothing', () => {
    expect(jumpToSpot('nowhere')).toBe(false);
    expect(events).toEqual([]);
  });
});
