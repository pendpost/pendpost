#!/usr/bin/env node
// test/engine-cover-fallback.test.mjs - the displayed cover must be the published
// cover. Two root causes this guards against (2026-08-20 title-image incident):
//
//   1. CLIENT-ROOT bug: every engine resolved post.cover.path against the REPO
//      root (path.resolve(__dirname,'..')) while covers.mjs stores it relative to
//      the CLIENT root (activeRoot()), so for any non-default client an explicitly
//      set cover silently never applied (41 LinkedIn frame covers never reached
//      LinkedIn). resolveCoverPath must anchor at PENDPOST_ROOT, exactly like
//      resolveMediaPath three lines up.
//   2. NO SIBLING FALLBACK: with no post.cover, engines applied NO cover at all,
//      while the app displayed the render-sibling <base>.jpg title card
//      (plans.mjs findCover). resolveCoverPath must fall back to that sibling so
//      display truth == publish truth.
//
// Plus the IG default: the render pipeline BAKES the title card into frame 0, so
// the coverless container default must be thumb_offset '0', not the old '1000'
// that skipped exactly past the card (source assertion, same pattern as
// ig-image.test.mjs's containerParams.alt_text guard - no reel-publish scaffold
// exists).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0;
let failures = 0;
const ok = (cond, msg) => { if (cond) { pass += 1; console.log(`  ok - ${msg}`); } else { failures += 1; console.error(`  FAIL - ${msg}`); } };

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// A throwaway CLIENT root, set BEFORE importing anything lib-backed (mirrors
// meta-delete-idempotent.test.mjs).
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-cover-fallback-'));
process.env.PENDPOST_ROOT = WS;
delete process.env.PENDPOST_MODE;

try {
  // ---------- findCoverSibling (lib/assets.mjs) ----------
  const { findCoverSibling } = await import('../lib/assets.mjs');

  const mediaDir = path.join(WS, 'data', 'media');
  fs.mkdirSync(mediaDir, { recursive: true });
  const videoAbs = path.join(mediaDir, 'clip one.mp4');
  const siblingAbs = path.join(mediaDir, 'clip one.jpg');
  fs.writeFileSync(videoAbs, 'v');

  ok(findCoverSibling(videoAbs) === null, 'findCoverSibling: video without a sibling JPEG -> null');
  fs.writeFileSync(siblingAbs, 'j');
  ok(findCoverSibling(videoAbs) === siblingAbs, 'findCoverSibling: <base>.mp4 -> existing <base>.jpg sibling');
  const movAbs = path.join(mediaDir, 'clip one.MOV');
  fs.writeFileSync(movAbs, 'v');
  ok(findCoverSibling(movAbs) === siblingAbs, 'findCoverSibling: .MOV (case-insensitive) derives the same sibling');
  ok(findCoverSibling(path.join(mediaDir, 'still.png')) === null, 'findCoverSibling: a non-video ref has no cover concept -> null');
  ok(findCoverSibling(null) === null, 'findCoverSibling: null media -> null');

  // ---------- resolveCoverPath: identical contract in all three engines ----------
  // Explicit cover under the CLIENT root (how covers.mjs stores it).
  const coverDir = path.join(WS, 'data', 'plans', 'camp1', 'covers');
  fs.mkdirSync(coverDir, { recursive: true });
  const overrideRel = 'data/plans/camp1/covers/p1.jpg';
  fs.writeFileSync(path.join(WS, overrideRel), 'o');

  for (const [name, mod] of [
    ['meta-social', '../scripts/meta-social.mjs'],
    ['yt-social', '../scripts/yt-social.mjs'],
    ['linkedin-social', '../scripts/linkedin-social.mjs'],
  ]) {
    const { resolveCoverPath } = await import(mod);
    ok(typeof resolveCoverPath === 'function', `${name}: resolveCoverPath is exported for this contract test`);

    // (1) The client-root fix: an explicit cover stored client-root-relative resolves.
    const withCover = { cover: { source: 'frame', offsetMs: 1500, path: overrideRel } };
    ok(resolveCoverPath(withCover, videoAbs) === path.join(WS, overrideRel),
      `${name}: explicit post.cover.path anchors at PENDPOST_ROOT (client root), not the repo root`);

    // (2) Sibling fallback: no cover -> the render-sibling title card.
    ok(resolveCoverPath({}, videoAbs) === siblingAbs,
      `${name}: no post.cover -> render-sibling <base>.jpg (display truth == publish truth)`);

    // Stale override pointer falls through to the sibling (plans.mjs overrideExists parity).
    const stale = { cover: { source: 'file', path: 'data/plans/camp1/covers/gone.jpg' } };
    ok(resolveCoverPath(stale, videoAbs) === siblingAbs,
      `${name}: stale override pointer falls through to the sibling`);

    // Nothing anywhere -> null (cover lanes stay skipped, publish untouched).
    const bare = path.join(mediaDir, 'no-sibling.mp4');
    fs.writeFileSync(bare, 'v');
    ok(resolveCoverPath({}, bare) === null, `${name}: no cover + no sibling -> null`);
    ok(resolveCoverPath({}, null) === null, `${name}: no cover + no media -> null`);
  }

  // ---------- IG coverless default = frame 0 (source assertion) ----------
  const metaSrc = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'meta-social.mjs'), 'utf8');
  ok(!/thumb_offset = '1000'/.test(metaSrc),
    "engine: the old 1000 ms coverless default is gone (it skipped past the baked frame-0 title card)");
  ok(/containerParams\.thumb_offset = '0'/.test(metaSrc),
    "engine: coverless IG reels request thumb_offset '0' - the frame the render pipeline bakes the title card into");
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
