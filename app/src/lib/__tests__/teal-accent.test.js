import { describe, it, expect } from 'vitest';
import { DEFAULT_ACCENT, DEFAULT_ACCENT_LIGHT, validateAccent } from '../theme.js';

// US-DS-01: the canonical accent is the brand teal, retiring the legacy-
// inherited blue #22566d. The default seed must still pass the AA gate that
// validateAccent enforces (it fills primary buttons + focus rings).
describe('US-DS-01: teal accent seed', () => {
  it('retires the legacy blue for the brand teal', () => {
    expect(DEFAULT_ACCENT.toLowerCase()).not.toBe('#22566d');
    expect(DEFAULT_ACCENT.toLowerCase()).toBe('#0f766e');
    expect(DEFAULT_ACCENT_LIGHT.toLowerCase()).toBe('#5eead4');
  });

  it('both seeded accents pass the AA contrast gate', () => {
    expect(validateAccent(DEFAULT_ACCENT).ok).toBe(true);
    expect(validateAccent(DEFAULT_ACCENT_LIGHT).ok).toBe(true);
  });
});
