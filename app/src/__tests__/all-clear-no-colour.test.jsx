// Canon Tier 2 (colour is spent only on attention): an ALL-CLEAR state ("Verbunden", "Aktiv",
// delivery running, "Gepostet") gets no colour. Green on every healthy row makes green the
// background and dulls the genuinely urgent amber and red. The judge found three all-clear
// states painted green/teal (the Setup "Aktiv" pill, the Settings "Aktiv" pill, the sidebar
// "Zustellung" monitor) and a sweep found the same mistake hand-rolled across the app.
//
// Two layers guard it:
//   1. the shared tone maps (IconBadge tone="ok", recipes PILL_TONES.ok / STATUS_INK.ok) render
//      an all-clear exactly like neutral, so every caller that says tone="ok" is grey;
//   2. a source scan: a green/teal/emerald utility class may only appear in the files listed
//      below, each for a reason that is NOT an all-clear state (an action button, a transient
//      "just done" confirmation right after the owner's own action, data direction in a chart).
//      A new green class anywhere else fails here and has to argue its case in this list.
import fs from 'node:fs';
import path from 'node:path';
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { CheckCircle2 } from 'lucide-react';
import { IconBadge } from '../components/ui/IconBadge.jsx';
import { PILL_TONES, STATUS_INK } from '../components/ui/recipes.js';
import { TooltipProvider } from '../components/ui/Tooltip.jsx';

const GREEN = /(?:^|[\s'"`:])(?:[a-z]+:)*(?:bg|text|ring|border|fill|stroke|from|via|to|decoration|outline|shadow)-(?:emerald|green|teal)-\d{2,3}(?:\/\d+)?/g;

describe('shared tone maps: an all-clear renders neutral', () => {
  it('IconBadge tone="ok" carries no green, teal or emerald class and matches neutral', () => {
    render(
      <TooltipProvider>
        <IconBadge icon={CheckCircle2} tone="ok" text="Verbunden" label="probe ok" />
        <IconBadge icon={CheckCircle2} tone="neutral" text="Übersprungen" label="skipped" />
      </TooltipProvider>,
    );
    const ok = screen.getByText('Verbunden').parentElement;
    const neutral = screen.getByText('Übersprungen').parentElement;
    expect(ok.className).not.toMatch(/emerald|green|teal/);
    expect(ok.className).toBe(neutral.className);
  });

  it('PILL_TONES.ok equals neutral and STATUS_INK.ok is grey', () => {
    expect(PILL_TONES.ok).toBe(PILL_TONES.neutral);
    expect(PILL_TONES.ok).not.toMatch(/emerald|green|teal|brand/);
    expect(STATUS_INK.ok).not.toMatch(/emerald|green|teal|brand/);
    // Attention tones keep their colour: only the all-clear goes grey.
    expect(PILL_TONES.attention).toMatch(/amber/);
    expect(PILL_TONES.danger).toMatch(/red/);
  });
});

// file (relative to app/src) -> why green is allowed there. Keep this list short.
const ALLOWED = {
  'components/ui/ActionButton.jsx': 'the approve ACTION button and the transient success flash after a click',
  'components/ui/Button.jsx': 'the success ACTION button variant',
  'components/Insights.jsx': 'data direction (a metric went up), not a status',
  'components/Composer.jsx': 'per-upload "done" check right after the owner uploads (transient)',
  'components/Assets.jsx': 'per-upload "done" check right after the owner uploads (transient)',
  'components/CommentsPanel.jsx': '"gesendet" right after the owner sends a comment (transient)',
  'components/Setup.jsx': '"Kopiert", "Gespeichert" and "Board erstellt" right after the owner acts (transient)',
  'components/PlaylistPanel.jsx': '"hinzugefügt" right after the owner adds to a playlist (transient)',
  'components/ZapModal.jsx': '"Zap gesendet" right after the owner sends (transient)',
  'components/ThreadComposer.jsx': 'per-tweet "gespeichert" right after a save run (transient)',
  'components/RadarSearches.jsx': '"Gespeichert" right after the owner saves a search (transient)',
  'components/radar/NeedsYou.jsx': 'the resolved line that replaces a row right after the owner acts (transient)',
  'components/radar/RadarFeed.jsx': '"Autor hat geantwortet": a follow-up that asks the owner to look (attention)',
  'components/CloudIssues.jsx': 'the pulsing dot on the handover glyph: this Mac is publishing in the cloud\'s place (activity, not an all-clear)',
  'components/ui.jsx': 'the decorative background blob behind the shell (not a status)',
  // Owner decision 2026-11-01 (q4 a): green status dot on the delivery indicator only. The
  // sidebar Delivery card and the header ConnectionStatus button both paint their dot through
  // this one component, so it is the single exception; nothing else gets green back.
  'components/DeliveryGlyph.jsx': 'owner decision 2026-11-01, green dot on the delivery indicator only (q4 a)',
  'lib/format.js': 'the post LIFECYCLE palette (in motion, published) shared by the planner views',
};

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '__tests__' || e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(jsx?|mjs)$/.test(e.name)) out.push(p);
  }
  return out;
}

describe('source scan: green only where it is not an all-clear', () => {
  const root = path.resolve(__dirname, '..');
  const offenders = walk(root)
    .map((f) => ({ rel: path.relative(root, f).split(path.sep).join('/'), hits: fs.readFileSync(f, 'utf8').match(GREEN) || [] }))
    .filter((x) => x.hits.length && !ALLOWED[x.rel]);

  it('no file outside the allowlist paints anything green, teal or emerald', () => {
    expect(offenders.map((o) => `${o.rel}: ${o.hits.map((h) => h.trim()).join(' ')}`)).toEqual([]);
  });

  it('the allowlist names only files that still need it', () => {
    const stale = Object.keys(ALLOWED).filter((rel) => {
      const f = path.join(root, rel);
      return !fs.existsSync(f) || !(fs.readFileSync(f, 'utf8').match(GREEN) || []).length;
    });
    expect(stale).toEqual([]);
  });
});
