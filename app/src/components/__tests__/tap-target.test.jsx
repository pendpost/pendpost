import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { RowMenu } from '../ui/RowMenu.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { TAP_TARGET, BTN_GHOST, BTN_QUIET } from '../ui/recipes.js';

// Canon Tier 2, "tap targets >= 44px" (WCAG 2.5.5, Apple HIG). The overflow trigger shared by
// the Radar feed rows, the "Needs you" strip and the planner/Freigaben cards used to hit at
// roughly 28px, so the rule was broken once and broken everywhere.
//
// What is on trial here is the FIX'S SHAPE, not just its presence: the hit area had to grow to
// 44px WITHOUT the row growing with it. So this locks both halves. The hit box is 44x44 (the
// numbers are parsed off the token, not string-matched, so a future edit to a smaller step
// fails here), and the trigger still carries no size utility of its own, which is what keeps
// the glyph, the row height and every neighbour's alignment exactly where they were.

// Tailwind's spacing scale: one step is 0.25rem, and the app's root font size is the browser
// default 16px. So `h-11` is 11 * 4 = 44px. Reading the number back out of the class is the
// point: it turns "does it say after:h-11" into "is it at least 44 pixels".
const STEP_PX = 4;
function pxOf(classes, prop) {
  const hit = classes.split(/\s+/).find((c) => c.startsWith(`after:${prop}-`));
  if (!hit) return 0;
  const step = Number(hit.slice(`after:${prop}-`.length));
  return Number.isFinite(step) ? step * STEP_PX : 0;
}

const wrap = (ui) => render(<TooltipProvider>{ui}</TooltipProvider>);
const items = [{ key: 'edit', label: 'Open in editor', run: () => {} }];

describe('TAP_TARGET (the 44px floor)', () => {
  it('declares a hit box of at least 44px in BOTH axes', () => {
    expect(pxOf(TAP_TARGET, 'h')).toBeGreaterThanOrEqual(44);
    expect(pxOf(TAP_TARGET, 'min-w')).toBeGreaterThanOrEqual(44);
  });

  it('positions that box over the control instead of adding to the layout', () => {
    // Absolutely positioned and centred on a `relative` control: it takes no space, so a row
    // that was 28px tall before is 28px tall after.
    expect(TAP_TARGET).toMatch(/\brelative\b/);
    expect(TAP_TARGET).toMatch(/after:absolute/);
    expect(TAP_TARGET).toMatch(/after:left-1\/2/);
    expect(TAP_TARGET).toMatch(/after:top-1\/2/);
    expect(TAP_TARGET).toMatch(/after:-translate-x-1\/2/);
    expect(TAP_TARGET).toMatch(/after:-translate-y-1\/2/);
    // A pseudo-element with no `content` never renders, so the box must claim one.
    expect(TAP_TARGET).toMatch(/after:content-\['']/);
  });

  it('changes no painted geometry: the base recipes keep their own padding and text size', () => {
    // Guards the density promise from the other side. If the fix ever migrates into the button
    // recipes as real height, these two stay honest about it.
    expect(BTN_GHOST).toMatch(/\bpx-2 py-1\b/);
    expect(BTN_GHOST).toMatch(/\btext-xs\b/);
    expect(BTN_QUIET).toMatch(/\bpx-3 py-1\.5\b/);
    expect(BTN_QUIET).toMatch(/\btext-xs\b/);
  });
});

describe('RowMenu trigger', () => {
  it('carries the 44px hit box', () => {
    wrap(<RowMenu label="More" items={items} />);
    const trigger = screen.getByRole('button', { name: 'More' });
    for (const cls of TAP_TARGET.split(/\s+/)) expect(trigger).toHaveClass(cls);
  });

  it('keeps the glyph at 16px, so the row looks untouched', () => {
    wrap(<RowMenu label="More" items={items} />);
    const glyph = screen.getByRole('button', { name: 'More' }).querySelector('svg');
    expect(glyph).toHaveAttribute('width', '16');
    expect(glyph).toHaveAttribute('height', '16');
  });

  it('grows no box of its own: no height, width or padding utility that would shift the row', () => {
    wrap(<RowMenu label="More" items={items} />);
    const classes = screen.getByRole('button', { name: 'More' }).className.split(/\s+/);
    const layoutish = classes.filter((c) => /^(h|w|min-h|min-w|size)-/.test(c));
    expect(layoutish).toEqual([]);
    // The padding it had before the fix, unchanged.
    expect(classes).toContain('px-1.5');
    expect(classes).toContain('py-1.5');
  });

  it('lets a caller override the paint without losing the hit box', () => {
    // The over-cover overlay trigger (Planner week card) passes its own className. The floor is
    // not the caller's to opt out of.
    wrap(<RowMenu label="More" items={items} triggerClassName="bg-black/45 p-1 text-white" />);
    const trigger = screen.getByRole('button', { name: 'More' });
    expect(trigger).toHaveClass('bg-black/45');
    for (const cls of TAP_TARGET.split(/\s+/)) expect(trigger).toHaveClass(cls);
  });
});

// ─────────────────────────────────────────────────────────────
// Spec 50's browser proof measured the floor on the two engage surfaces and found 24 of 26
// ledger controls and 16 of 23 strip controls under it. The fix is the token, applied at every
// site - so what is locked here is the SITES, read out of the source. A class assertion on
// rendered markup would only cover the states a test happens to render; the ledger's state lines
// are mutually exclusive by construction, and half of them never coexist on one screen.
// ─────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import { FIELD } from '../ui/tokens.js';

const src = (rel) => fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');
// Every interactive element in a file, sliced to its opening tag. A regex cannot do this: a JSX
// attribute value is an expression, and `${open ? 'a' : 'b'}` and `(v) => !v` both carry a `>`
// that would end the match early. So the scan walks to the tag's own closing bracket, counting
// braces and skipping strings, which is the difference between finding 3 controls and finding all
// of them - and a scan that silently finds 3 would pass this suite while proving nothing.
function controls(text) {
  const out = [];
  for (const m of text.matchAll(/<(?:button|a)[\s>]/g)) {
    let i = m.index;
    let depth = 0;
    let quote = '';
    for (; i < text.length; i += 1) {
      const c = text[i];
      if (quote) { if (c === quote && text[i - 1] !== '\\') quote = ''; continue; }
      if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
      if (c === '{') depth += 1;
      else if (c === '}') depth -= 1;
      else if (c === '>' && depth === 0) break;
    }
    const tag = text.slice(m.index, i + 1);
    if (!/className=/.test(tag)) continue;
    out.push(tag.replace(/\s+/g, ' '));
  }
  return out;
}

describe('the 44px floor on the spec 50 surfaces', () => {
  for (const [file, name] of [['AutonomyLedger.jsx', 'the autonomy ledger'], ['radar/NeedsYou.jsx', 'the "Needs you" strip']]) {
    it(`${name}: every button and link carries TAP_TARGET`, () => {
      const found = controls(src(file));
      expect(found.length).toBeGreaterThanOrEqual(5);
      const bare = found.filter((c) => !c.includes('TAP_TARGET'));
      // The row-header disclosures are the exception, and a measured one: they are full-width
      // rows about 58px tall, so the floor is already painted rather than hidden.
      const allowed = bare.filter((c) => /aria-controls=\{`\$\{id\}-body`\}/.test(c));
      expect(bare.filter((c) => !allowed.includes(c))).toEqual([]);
    });
  }

  it('the shared switch and the segmented control carry it too, since both surfaces use them', () => {
    expect(src('ui/Switch.jsx')).toMatch(/TAP_TARGET/);
    expect(src('ui.jsx')).toMatch(/rounded-\[10px\][^`]*\$\{TAP_TARGET\}/);
  });

  // An <input> and a <select> are replaced elements: a ::after box on them is never painted, so
  // for a field the floor has to be real height. FIELD is that height, once, for the whole app.
  it('FIELD is 44px tall, because a field cannot hide a hit area behind a pseudo-element', () => {
    expect(pxOf(`after:h-${FIELD.match(/\bh-(\d+)\b/)[1]}`, 'h')).toBeGreaterThanOrEqual(44);
  });
});
