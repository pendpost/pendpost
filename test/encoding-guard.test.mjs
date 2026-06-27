#!/usr/bin/env node
// test/encoding-guard.test.mjs - NFR source-hygiene gate: no tracked, non-binary
// source file may contain a NUL byte or invalid UTF-8.
//
// WHY this gate exists: a single literal NUL (U+0000) - or any byte that fails a
// UTF-8 decode - makes git treat the whole file as *binary*. `git grep` and plain
// `grep` then silently suppress ALL matches in that file: a code-search/CI hazard
// where a symbol "vanishes" from search with no error. This actually happened -
// lib/cloud-client.mjs shipped 2 literal NUL bytes inside a template-literal
// Map-key delimiter, `file` reported it as `data`, and `grep "export"` returned
// nothing. The fix is to escape the byte (NUL -> `\x00`); this gate keeps it fixed.
//
// The detector is content-based (NUL scan + strict UTF-8 decode), NOT
// `file ... | grep text` - `file` labels every JSON as "JSON data" (no "text"
// substring), which would false-positive ~27 clean files. See scripts/check-encoding.mjs.
//
// IMPORTANT: every NUL / invalid-UTF-8 test vector below is built from explicit
// bytes (Buffer.from([...])), NEVER a source literal - a raw NUL in this file is
// the very hazard the gate bans and would make the gate flag its own test.
//
// Zero-dep node:assert. Exercises the pure detector against synthetic byte
// vectors, then asserts the REAL tracked tree is clean.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { scanBuffer, isBinaryPath, scanRepo } from '../scripts/check-encoding.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

// ---- scanBuffer: flags a NUL byte, reports offset + 1-based line ------------
// 'ab\ncd\n' is 6 bytes with newlines at offsets 2 and 5, so the appended NUL
// sits at offset 6 on line 3.
{
  const buf = Buffer.concat([Buffer.from('ab\ncd\n', 'utf8'), Buffer.from([0x00]), Buffer.from('ef', 'utf8')]);
  const v = scanBuffer(buf);
  ok(v && v.kind === 'nul', 'scanBuffer flags a NUL byte (kind:nul)');
  ok(v && v.offset === 6, `scanBuffer reports the NUL byte offset (got ${v && v.offset}, want 6)`);
  ok(v && v.line === 3, `scanBuffer reports the NUL's 1-based line (got ${v && v.line}, want 3)`);
}

// ---- scanBuffer: flags invalid UTF-8 of several shapes ----------------------
ok(scanBuffer(Buffer.from([0x41, 0x80, 0x42]))?.kind === 'utf8', 'scanBuffer flags a lone continuation byte (0x80) as invalid UTF-8');
ok(scanBuffer(Buffer.from([0x41, 0x80, 0x42]))?.offset === 1, 'scanBuffer reports the offset of the first invalid UTF-8 byte');
ok(scanBuffer(Buffer.from([0xC0, 0xAF]))?.kind === 'utf8', 'scanBuffer flags an overlong 2-byte sequence (0xC0 0xAF) as invalid UTF-8');
ok(scanBuffer(Buffer.from([0x41, 0xE2, 0x82]))?.kind === 'utf8', 'scanBuffer flags a truncated 3-byte sequence at EOF as invalid UTF-8');
ok(scanBuffer(Buffer.from([0xED, 0xA0, 0x80]))?.kind === 'utf8', 'scanBuffer flags a UTF-16 surrogate (0xED 0xA0 0x80) as invalid UTF-8');
ok(scanBuffer(Buffer.from([0xF4, 0x90, 0x80, 0x80]))?.kind === 'utf8', 'scanBuffer flags an out-of-range code point (> U+10FFFF) as invalid UTF-8');
ok(scanBuffer(Buffer.from([0xFF]))?.kind === 'utf8', 'scanBuffer flags a stray 0xFF as invalid UTF-8');

// ---- scanBuffer: clean content returns null (no false positives) -----------
ok(scanBuffer(Buffer.from('export const x = 1;\n', 'utf8')) === null, 'scanBuffer passes clean ASCII source (returns null)');
ok(scanBuffer(Buffer.from('a é € 😀 — ✓ z\n', 'utf8')) === null, 'scanBuffer passes valid multibyte UTF-8 (accent, euro, emoji, em-dash, check)');
ok(scanBuffer(Buffer.from('', 'utf8')) === null, 'scanBuffer passes an empty buffer (returns null)');

// ---- isBinaryPath: known-binary extensions are skipped ---------------------
for (const p of ['a/b.png', 'x.JPG', 'm.mp4', 'f.woff2', 'd.pdf', 'z.zip', 'i.dmg', 'n.node', 'w.wasm', 'icon.ico', 'clip.mov', 'g.gif', 'p.webp']) {
  ok(isBinaryPath(p) === true, `isBinaryPath skips a known-binary extension (${p})`);
}
// ---- isBinaryPath: text/source extensions (and extension-less files) are scanned ----
for (const p of ['lib/x.mjs', 'a.js', 'p.json', 'r.md', 'favicon.svg', 's.css', 'Dockerfile', '.gitignore', 'q.astro']) {
  ok(isBinaryPath(p) === false, `isBinaryPath scans text/source paths (${p})`);
}

// ---- scanRepo: detects a planted NUL, and honours the binary skip-list -----
// Proves the guard "would fail if a NUL were reintroduced" - deterministically,
// in-process, without mutating the tracked tree. 'export const k = 1;' is 19
// bytes, so the appended NUL sits at offset 19.
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-enc-'));
try {
  const taintedBytes = Buffer.concat([Buffer.from('export const k = 1;', 'utf8'), Buffer.from([0x00]), Buffer.from('\n', 'utf8')]);
  fs.writeFileSync(path.join(WS, 'tainted.mjs'), taintedBytes);
  fs.writeFileSync(path.join(WS, 'art.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00])); // NUL, but binary ext
  fs.writeFileSync(path.join(WS, 'clean.js'), Buffer.from('const ok = true;\n', 'utf8'));

  const hits = scanRepo({ root: WS, files: ['tainted.mjs', 'art.png', 'clean.js'] });
  const tainted = hits.find((h) => h.file === 'tainted.mjs');
  ok(Boolean(tainted), 'scanRepo flags a planted NUL in a .mjs file (the recurrence it must catch)');
  ok(tainted && tainted.kind === 'nul' && tainted.offset === 19, `scanRepo reports kind+offset for the planted NUL (got ${tainted && tainted.kind}@${tainted && tainted.offset})`);
  ok(!hits.some((h) => h.file === 'art.png'), 'scanRepo does NOT flag a NUL inside a known-binary extension (.png skipped)');
  ok(!hits.some((h) => h.file === 'clean.js'), 'scanRepo does NOT flag a clean text file');
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}

// ---- scanRepo: the REAL tracked tree is clean ------------------------------
// The actual CI invariant. If this fails, a tracked source file carries a NUL or
// invalid UTF-8 - normalize the byte (the report names file:line + offset).
const violations = scanRepo({ root: REPO });
ok(
  violations.length === 0,
  `every tracked, non-binary source file is NUL-free + valid UTF-8 (offenders: ${violations.map((v) => `${v.file}:${v.line} @${v.offset} ${v.kind}`).join(', ') || 'none'})`,
);

console.log(`[encoding-guard] OK - NUL/UTF-8 source-hygiene gate: detector vectors + binary skip-list + clean tracked tree (${pass} assertions).`);
