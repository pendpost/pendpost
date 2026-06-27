#!/usr/bin/env node
// scripts/check-encoding.mjs - source-hygiene gate. Fails when any tracked,
// non-binary file contains a NUL byte (U+0000) or invalid UTF-8.
//
// WHY: a single NUL - or any byte that fails a UTF-8 decode - makes git classify
// the whole file as *binary*. `git grep` and plain `grep` then silently suppress
// every match in that file, so a symbol "disappears" from code search with no
// error. lib/cloud-client.mjs once shipped 2 literal NUL bytes inside a
// template-literal Map-key delimiter; `file` reported it as `data` and
// `grep "export"` found nothing. This gate keeps that from recurring.
//
// The signal is CONTENT-based, on purpose. We do NOT test `file "$f" | grep text`:
// `file` labels JSON as "JSON data" (no "text" substring), which would
// false-positive every tracked .json. The correct, precise signal is "does the
// byte stream contain a NUL, or fail to decode as UTF-8".
//
// Pure guard - it never edits files. On a violation it prints file:line @offset
// + kind so a human can normalize the byte (e.g. NUL -> `\x00` in a JS string).
//
// Run as a CLI (exit 1 on any violation) or import { scanBuffer, isBinaryPath,
// scanRepo } for tests. Zero runtime deps - node: built-ins only.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

// Known-binary file extensions to skip. These legitimately carry NUL bytes /
// non-UTF-8 data; scanning them would only produce noise. Extend this set when a
// new binary asset type joins the tree - that is the deliberate, auditable knob.
// (Text-ish formats like .svg/.json/.csv are intentionally NOT here: they are
// scanned, because a NUL in them is a real defect.)
export const BINARY_EXTENSIONS = new Set([
  // raster + vector-raster images
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'tiff', 'tif', 'ico', 'icns',
  // fonts
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  // audio / video
  'mp3', 'mp4', 'm4a', 'mov', 'webm', 'avi', 'mkv', 'wav', 'ogg', 'flac',
  // archives / compressed
  'zip', 'gz', 'tgz', 'bz2', 'xz', 'zst', '7z', 'rar', 'tar',
  // documents / installers / disk images
  'pdf', 'dmg', 'pkg', 'exe', 'msi', 'deb', 'rpm', 'iso',
  // compiled / native modules
  'node', 'wasm', 'so', 'dylib', 'dll', 'class', 'jar', 'bin', 'o', 'a',
  // misc binary
  'ds_store', 'parquet', 'mcpb',
]);

// true when `filePath`'s extension marks it as a known binary asset (skip it).
// Extension-less files (Dockerfile, .gitignore, LICENSE) return false and ARE
// scanned - they are text. Matching is case-insensitive.
export function isBinaryPath(filePath) {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  return ext !== '' && BINARY_EXTENSIONS.has(ext);
}

// Offset of the first byte that breaks UTF-8 well-formedness (Unicode 15 Table
// 3-7), or -1 if the whole buffer decodes. Rejects overlong forms, lone or
// excess continuation bytes, UTF-16 surrogates (U+D800..DFFF), code points above
// U+10FFFF, and sequences truncated at EOF. Note: a NUL (0x00) is *valid* UTF-8,
// so this never flags one - the NUL scan is a separate, independent check.
export function firstInvalidUtf8(buf) {
  const n = buf.length;
  let i = 0;
  while (i < n) {
    const b0 = buf[i];
    if (b0 <= 0x7f) { i += 1; continue; } // ASCII

    let len;
    let lo1;
    let hi1; // allowed range for the FIRST continuation byte (guards overlong/surrogate/range)
    if (b0 >= 0xc2 && b0 <= 0xdf) { len = 2; lo1 = 0x80; hi1 = 0xbf; }
    else if (b0 === 0xe0) { len = 3; lo1 = 0xa0; hi1 = 0xbf; }
    else if (b0 >= 0xe1 && b0 <= 0xec) { len = 3; lo1 = 0x80; hi1 = 0xbf; }
    else if (b0 === 0xed) { len = 3; lo1 = 0x80; hi1 = 0x9f; }
    else if (b0 >= 0xee && b0 <= 0xef) { len = 3; lo1 = 0x80; hi1 = 0xbf; }
    else if (b0 === 0xf0) { len = 4; lo1 = 0x90; hi1 = 0xbf; }
    else if (b0 >= 0xf1 && b0 <= 0xf3) { len = 4; lo1 = 0x80; hi1 = 0xbf; }
    else if (b0 === 0xf4) { len = 4; lo1 = 0x80; hi1 = 0x8f; }
    else { return i; } // 0x80..0xC1 (stray/overlong lead) or 0xF5..0xFF (out of range)

    if (i + len > n) return i; // multibyte sequence truncated at EOF
    if (buf[i + 1] < lo1 || buf[i + 1] > hi1) return i;
    for (let k = 2; k < len; k += 1) {
      if (buf[i + k] < 0x80 || buf[i + k] > 0xbf) return i;
    }
    i += len;
  }
  return -1;
}

// 1-based line number of `offset` within `buf` (count of newlines before it + 1).
function lineOf(buf, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < buf.length; i += 1) {
    if (buf[i] === 0x0a) line += 1;
  }
  return line;
}

// Inspect a byte buffer. Returns null when clean, else the EARLIEST violation as
// { kind: 'nul' | 'utf8', offset, line }. NUL and invalid-UTF-8 are independent
// checks (a NUL is valid UTF-8); whichever sits at the lower offset wins.
export function scanBuffer(buf) {
  const nul = buf.indexOf(0);
  const bad = firstInvalidUtf8(buf);

  let kind = null;
  let offset = -1;
  if (nul !== -1) { kind = 'nul'; offset = nul; }
  if (bad !== -1 && (offset === -1 || bad < offset)) { kind = 'utf8'; offset = bad; }
  if (offset === -1) return null;
  return { kind, offset, line: lineOf(buf, offset) };
}

// The list of tracked files, as git sees them (respects .gitignore, excludes
// untracked + deleted). NUL-delimited so paths with odd characters are safe.
function trackedFiles(root) {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
  return out.toString('utf8').split('\0').filter(Boolean);
}

// Scan the tracked tree. Returns an array of { file, kind, offset, line } for
// every tracked, non-binary file that carries a NUL or invalid UTF-8 (empty when
// clean). Pass { files } to scan an explicit list (tests); pass { root } to scan
// a different checkout. Files absent on disk (tracked-but-deleted) are skipped.
export function scanRepo({ root = REPO_ROOT, files } = {}) {
  const list = files ?? trackedFiles(root);
  const violations = [];
  for (const file of list) {
    if (isBinaryPath(file)) continue;
    const abs = path.join(root, file);
    let buf;
    try {
      buf = fs.readFileSync(abs);
    } catch {
      continue; // tracked but not present on disk (e.g. mid-rebase); nothing to scan
    }
    const v = scanBuffer(buf);
    if (v) violations.push({ file, ...v });
  }
  return violations;
}

// ---- CLI -------------------------------------------------------------------
function main() {
  let violations;
  try {
    violations = scanRepo();
  } catch (err) {
    console.error(`[check-encoding] could not enumerate tracked files: ${err.message}`);
    process.exit(2);
  }

  if (violations.length > 0) {
    console.error('[check-encoding] FAIL - tracked source files contain NUL bytes or invalid UTF-8:');
    for (const v of violations) {
      const what = v.kind === 'nul' ? 'NUL byte (U+0000)' : 'invalid UTF-8';
      console.error(`  ${v.file}:${v.line} (byte offset ${v.offset}) - ${what}`);
    }
    console.error('');
    console.error('These bytes make git treat the file as binary, so git grep/grep silently');
    console.error('suppress all matches in it. Normalize the byte (e.g. a NUL inside a JS');
    console.error('string -> the `\\x00` escape, which is byte-identical at runtime).');
    process.exit(1);
  }

  console.log('[check-encoding] OK - every tracked, non-binary source file is NUL-free and valid UTF-8.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
