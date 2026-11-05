// media-cleanup.mjs - free disk space after posting, safely, and heal the inverse case.
// Spec: docs/specs/media-cleanup.md.
//
// Two halves that share one reference model:
//   - cleanup: a VIDEO in the brand's own data/media is deletable only when every post of
//     every plan file (active or not, listed or not, plus the trash) that references it is
//     done (posted / rejected / deleted / natively handed off) and the grace has passed.
//   - heal: an upcoming post whose local file is missing gets it back from the cloud by its
//     sha256 (state.fileHashes), or a clear attention row when that is impossible.
//
// The reference test is deliberately BROAD: any string anywhere in a post whose basename
// equals the file's basename counts. A false match only keeps a file; a missed reference
// would break a post. Every read that could hide a reference (an unreadable plan or trash
// file) aborts the cleanup instead of guessing.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { activeRoot, boundClientId } from './context.mjs';
import { clientRoot, readRegistry, activeClientId } from './multi-client.mjs';
import { loadState, saveState, markProbeCacheChanged } from './state.mjs';
import { getPosting } from './config.mjs';
import { storyLanesFor, STORY_ID_FIELDS } from './capabilities.mjs';
import { appendActivity } from './scheduler.mjs';
import { logLine, describeFetchFailure, errorBody } from './util.mjs';

export const VIDEO_EXTS = new Set(['.mp4', '.mov', '.m4v', '.webm']);
export const DEFAULT_GRACE_DAYS = 7;
const DAY_MS = 24 * 3600 * 1000;
// Lanes that upload the media itself when a post is natively scheduled, so a scheduled post
// on them no longer needs the local file (the platform holds the bytes until publishAt).
export const NATIVE_UPLOAD_LANES = Object.freeze({ youtube: 'ytVideoId' });
// A post field holding text a basename could hide in is any string; these keys are the
// big free-text ones that never name a file, skipped only to keep the walk cheap.
const SKIP_KEYS = new Set(['caption', 'body', 'excerpt', 'description', 'firstComment', 'receipt', 'attestation']);
const MEDIA_STRING = /\.[a-z0-9]{2,5}(?:[?#].*)?$/i;
const HEAL_EVERY_MS = 10 * 60 * 1000;
const CLEANUP_EVERY_MS = DAY_MS;

// ---------- config ----------

export function cleanupConfig(posting = getPosting()) {
  const c = posting && typeof posting.mediaCleanup === 'object' && posting.mediaCleanup ? posting.mediaCleanup : {};
  const g = Number(c.graceDays);
  return { enabled: c.enabled === true, graceDays: Number.isFinite(g) && g >= 0 ? g : DEFAULT_GRACE_DAYS };
}

// ---------- reading every plan + trash file of a root ----------

// Every plan-ish JSON under <root>/data/plans (post-plan.json files and their *.trash.json
// siblings, at any depth up to 4), plus whatever the manifest lists elsewhere. Returns
// { files: [{ abs, kind:'plan'|'trash', folder, rows:[{ post, trashedAt }] }], errors: [] }.
// A file that exists but cannot be parsed is an ERROR, never an empty plan.
export function readPlanFiles(root) {
  const plansDir = path.join(root, 'data', 'plans');
  const found = new Set();
  const walk = (dir, depth) => {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.name.startsWith('.')) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) { if (depth < 4) walk(abs, depth + 1); continue; }
      if (!e.isFile() || !e.name.endsWith('.json')) continue;
      if (e.name === 'post-plan.json' || e.name.endsWith('.trash.json') || e.name.endsWith('-plan.json')) found.add(abs);
    }
  };
  walk(plansDir, 0);
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(plansDir, 'active-plans.json'), 'utf8'));
    for (const e of manifest.plans || []) {
      if (!e || typeof e.path !== 'string') continue;
      const abs = path.resolve(root, e.path);
      if (fs.existsSync(abs)) {
        found.add(abs);
        const trash = path.join(path.dirname(abs), `${path.basename(abs, '.json')}.trash.json`);
        if (fs.existsSync(trash)) found.add(trash);
      }
    }
  } catch { /* no manifest: the directory walk above is the whole store */ }
  const files = [];
  const errors = [];
  for (const abs of [...found].sort()) {
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(abs, 'utf8'));
    } catch (err) {
      errors.push({ file: abs, error: err.message });
      continue;
    }
    if (abs.endsWith('.trash.json')) {
      const entries = Array.isArray(doc?.entries) ? doc.entries : [];
      files.push({ abs, kind: 'trash', folder: '', campaign: doc?.campaign || path.basename(path.dirname(abs)), rows: entries.filter((e) => e && e.post).map((e) => ({ post: e.post, trashedAt: e.trashedAt || null })) });
    } else if (Array.isArray(doc?.posts)) {
      files.push({ abs, kind: 'plan', folder: typeof doc.folder === 'string' ? doc.folder : '', campaign: path.basename(path.dirname(abs)), rows: doc.posts.filter((p) => p && typeof p === 'object').map((post) => ({ post, trashedAt: null })) });
    }
  }
  return { files, errors };
}

// Every string a post carries that could name a file: { basenames:Set, absolutes:Set }.
export function postFileStrings(post) {
  const basenames = new Set();
  const absolutes = new Set();
  const visit = (v, key, depth) => {
    if (depth > 6 || v == null) return;
    if (typeof v === 'string') {
      if (SKIP_KEYS.has(key) || v.length > 2048 || !MEDIA_STRING.test(v)) return;
      const clean = v.replace(/[?#].*$/, '');
      const base = clean.split(/[/\\]/).pop();
      if (base) basenames.add(base);
      if (path.isAbsolute(clean)) absolutes.add(path.resolve(clean));
      return;
    }
    if (Array.isArray(v)) { for (const x of v) visit(x, key, depth + 1); return; }
    if (typeof v === 'object') for (const [k, x] of Object.entries(v)) visit(x, k, depth + 1);
  };
  visit(post, '', 0);
  return { basenames, absolutes };
}

// ---------- classifying a post ----------

const ts = (v) => {
  const n = Date.parse(v || '');
  return Number.isFinite(n) ? n : null;
};

// Is a natively scheduled post fully handed off to a lane that holds the bytes?
function handedOff(post) {
  if (post.status !== 'scheduled') return false;
  const platforms = Array.isArray(post.platforms) ? post.platforms : [];
  if (!platforms.length) return false;
  if (storyLanesFor(post).length) return false;
  return platforms.every((p) => NATIVE_UPLOAD_LANES[p] && post[NATIVE_UPLOAD_LANES[p]]);
}

// { state: 'needs'|'done'|'handed-off'|'unknown-time', at, why }
export function classifyPost(post, { trashedAt = null } = {}) {
  if (trashedAt) {
    const at = ts(trashedAt);
    return at === null ? { state: 'unknown-time', at: null, why: 'deleted' } : { state: 'done', at, why: 'deleted' };
  }
  if (post.status === 'posted') {
    const owed = storyLanesFor(post).filter((l) => !post[STORY_ID_FIELDS[l]]);
    if (owed.length) return { state: 'needs', at: null, why: 'story-pending' };
    const at = ts(post.postedAt) ?? ts(post.scheduledAt);
    return at === null ? { state: 'unknown-time', at: null, why: 'posted' } : { state: 'done', at, why: 'posted' };
  }
  if (post.approval === 'rejected') {
    const at = ts(post.approvalAt) ?? ts(post.scheduledAt);
    return at === null ? { state: 'unknown-time', at: null, why: 'rejected' } : { state: 'done', at, why: 'rejected' };
  }
  if (handedOff(post)) return { state: 'handed-off', at: null, why: 'scheduled-native' };
  return { state: 'needs', at: null, why: post.status || 'planned' };
}

// ---------- the cleanup plan ----------

function realOrNull(p) {
  try { return fs.realpathSync(p); } catch { return null; }
}

// Every video file in the brand's data/media (recursive, symlinks skipped).
function candidateVideos(mediaDir) {
  const out = [];
  const walk = (dir, depth) => {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.name.startsWith('.')) continue;
      const abs = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) { if (depth < 4) walk(abs, depth + 1); continue; }
      if (e.isFile() && VIDEO_EXTS.has(path.extname(e.name).toLowerCase())) out.push(abs);
    }
  };
  walk(mediaDir, 0);
  return out;
}

// The roots of the OTHER brands on this install (their posts count only by absolute path).
function otherRoots(root) {
  const reg = readRegistry();
  const ids = reg && Array.isArray(reg.clients) ? reg.clients.map((c) => c && c.id).filter((id) => typeof id === 'string') : [];
  const out = [];
  for (const id of ids) {
    try {
      const r = clientRoot(id);
      if (path.resolve(r) !== path.resolve(root)) out.push(r);
    } catch { /* malformed registry id: no root to read */ }
  }
  return out;
}

const fmtPost = (r) => `${r.campaign}/${r.postId}`;

// The full decision for the ACTIVE brand. Pure read. Returns
// { ok, aborted?, deletable[], kept[], bytesDeletable, graceDays, errors[] }.
export function planCleanup({ now = Date.now(), graceDays = cleanupConfig().graceDays, root = activeRoot() } = {}) {
  const graceMs = Math.max(0, Number(graceDays) || 0) * DAY_MS;
  const mediaDir = path.join(root, 'data', 'media');
  const mediaReal = realOrNull(mediaDir);
  const own = readPlanFiles(root);
  const errors = [...own.errors];
  // basename -> [{ campaign, postId, cls }]
  const byBase = new Map();
  const add = (map, key, ref) => {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(ref);
  };
  for (const f of own.files) {
    for (const { post, trashedAt } of f.rows) {
      const ref = { campaign: f.campaign, postId: post.id || '?', cls: classifyPost(post, { trashedAt }) };
      for (const b of postFileStrings(post).basenames) add(byBase, b, ref);
    }
  }
  // Other brands: only an absolute path into THIS brand's media counts.
  const byAbs = new Map();
  for (const r of otherRoots(root)) {
    const other = readPlanFiles(r);
    errors.push(...other.errors);
    for (const f of other.files) {
      for (const { post, trashedAt } of f.rows) {
        const ref = { campaign: `${path.basename(r)}:${f.campaign}`, postId: post.id || '?', cls: classifyPost(post, { trashedAt }) };
        for (const a of postFileStrings(post).absolutes) add(byAbs, a, ref);
      }
    }
  }
  if (errors.length) {
    return { ok: false, aborted: true, reason: 'unreadable_plan', errors, deletable: [], kept: [], bytesDeletable: 0, graceDays };
  }
  const deletable = [];
  const kept = [];
  if (!mediaReal) return { ok: true, deletable, kept, bytesDeletable: 0, graceDays, errors };
  for (const abs of candidateVideos(mediaDir)) {
    const real = realOrNull(abs);
    if (!real || !real.startsWith(mediaReal + path.sep)) continue; // never outside the brand's media
    let st;
    try { st = fs.statSync(abs); } catch { continue; }
    const file = path.relative(mediaDir, abs);
    const refs = [...(byBase.get(path.basename(abs)) || []), ...(byAbs.get(path.resolve(abs)) || []), ...(real !== abs ? byAbs.get(real) || [] : [])];
    const row = { file, path: abs, bytes: st.size };
    if (!refs.length) { kept.push({ ...row, reason: 'unreferenced', detail: 'no post references this file' }); continue; }
    const needs = refs.filter((r) => r.cls.state === 'needs');
    if (needs.length) {
      kept.push({ ...row, reason: 'needed', detail: `still needed by ${needs.slice(0, 5).map(fmtPost).join(', ')}${needs.length > 5 ? ` and ${needs.length - 5} more` : ''}`, posts: needs.map(fmtPost) });
      continue;
    }
    const unknown = refs.filter((r) => r.cls.state === 'unknown-time');
    if (unknown.length) {
      kept.push({ ...row, reason: 'no-time', detail: `${unknown.map(fmtPost).join(', ')} has no posted or decided time`, posts: unknown.map(fmtPost) });
      continue;
    }
    const doneAt = refs.filter((r) => r.cls.state === 'done').map((r) => r.cls.at);
    const lastDone = doneAt.length ? Math.max(...doneAt) : null;
    if (lastDone !== null && lastDone + graceMs > now) {
      kept.push({ ...row, reason: 'in-grace', detail: `last post done ${new Date(lastDone).toISOString()}`, until: new Date(lastDone + graceMs).toISOString() });
      continue;
    }
    if (st.mtimeMs + graceMs > now) {
      kept.push({ ...row, reason: 'recently-changed', detail: `file changed ${new Date(st.mtimeMs).toISOString()}`, until: new Date(st.mtimeMs + graceMs).toISOString() });
      continue;
    }
    deletable.push({ ...row, posts: refs.map((r) => `${fmtPost(r)} (${r.cls.why})`) });
  }
  deletable.sort((a, b) => b.bytes - a.bytes);
  kept.sort((a, b) => a.reason.localeCompare(b.reason) || b.bytes - a.bytes);
  return { ok: true, deletable, kept, bytesDeletable: deletable.reduce((s, d) => s + d.bytes, 0), graceDays, errors };
}

const mb = (n) => `${(n / 1e6).toFixed(1)} MB`;

// Delete what planCleanup proves deletable. Re-checks each file right before the unlink
// (still a regular file, same size) and keeps its sha256 in state.fileHashes.
function deleteFiles(deletable, actor) {
  const deleted = [];
  const failed = [];
  const state = loadState();
  for (const d of deletable) {
    try {
      const st = fs.lstatSync(d.path);
      if (!st.isFile() || st.size !== d.bytes) { failed.push({ file: d.file, error: 'changed since the check' }); continue; }
      fs.unlinkSync(d.path);
      if (state.assets && state.assets[d.path]) delete state.assets[d.path];
      deleted.push({ file: d.file, bytes: d.bytes, sha256: state.fileHashes?.[d.path]?.sha256 || null });
    } catch (err) {
      failed.push({ file: d.file, error: err.message });
    }
  }
  const bytesFreed = deleted.reduce((s, d) => s + d.bytes, 0);
  if (deleted.length) {
    markProbeCacheChanged();
    saveState();
    appendActivity({
      campaign: null, postId: null, platform: null, action: 'media-cleanup', ok: true, errorCode: null,
      errorMessage: `Freed ${mb(bytesFreed)}: ${deleted.map((d) => `${d.file} (${mb(d.bytes)})`).join(', ')}`,
      lateMin: null, actor, bytesFreed, files: deleted.map((d) => ({ file: d.file, bytes: d.bytes })),
    });
    logLine('info', `media-cleanup: deleted ${deleted.length} file(s), freed ${mb(bytesFreed)}`);
  }
  return { deleted, failed, bytesFreed };
}

// ---------- self-heal ----------

// The extensions a restore may write (the media the cloud push uploads).
const RESTORE_EXTS = new Set([...VIDEO_EXTS, '.jpg', '.jpeg', '.png', '.webp', '.gif']);

// May the self-heal write abs? Only a media file strictly inside the brand's data/media, judged
// on the normalized path AND on the realpath of its nearest existing parent, so neither a '..'
// segment nor a symlinked directory can carry a write outside it.
export function restoreTargetOk(abs, mediaDir) {
  const norm = path.resolve(abs);
  if (!RESTORE_EXTS.has(path.extname(norm).toLowerCase())) return false;
  const rel = path.relative(path.resolve(mediaDir), norm);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  const mediaReal = realOrNull(mediaDir);
  if (!mediaReal) return false;
  let parent = path.dirname(norm);
  while (!fs.existsSync(parent) && parent !== path.dirname(parent)) parent = path.dirname(parent);
  const parentReal = realOrNull(parent);
  return Boolean(parentReal) && (parentReal === mediaReal || parentReal.startsWith(mediaReal + path.sep));
}

// Every not-done post of an ACTIVE campaign whose local media file is missing:
// [{ campaign, postId, scheduledAt, path, file }]. Mirrors resolveMediaPath (path wins, else
// folder + file; carousel items each the same way) and only targets paths inside data/.
export function findMissingMedia({ root = activeRoot() } = {}) {
  const plansDir = path.join(root, 'data', 'plans');
  const mediaDir = path.join(root, 'data', 'media');
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(plansDir, 'active-plans.json'), 'utf8')); } catch { return []; }
  const out = [];
  for (const e of manifest.plans || []) {
    if (!e || e.active === false || typeof e.path !== 'string') continue;
    let plan;
    try { plan = JSON.parse(fs.readFileSync(path.resolve(root, e.path), 'utf8')); } catch { continue; }
    const folder = typeof plan.folder === 'string' ? plan.folder : '';
    for (const post of plan.posts || []) {
      if (!post || ['text', 'poll', 'nostr-longform'].includes(post.type)) continue;
      if (classifyPost(post).state !== 'needs') continue;
      const refs = post.type === 'carousel' && Array.isArray(post.mediaItems) ? post.mediaItems : [post];
      for (const ref of refs) {
        if (!ref || (!ref.path && !ref.file)) continue;
        const cands = [];
        // path.resolve normalizes every candidate (a '..' segment can never survive into the
        // containment check below), exactly the anchoring resolveMediaPath uses.
        if (typeof ref.path === 'string' && ref.path) cands.push(path.resolve(root, ref.path));
        if (typeof ref.file === 'string' && ref.file) cands.push(path.resolve(root, folder, ref.file));
        if (cands.some((c) => fs.existsSync(c))) continue;
        const target = cands.find((c) => restoreTargetOk(c, mediaDir));
        if (!target) continue;
        out.push({ campaign: e.id, postId: post.id, scheduledAt: post.scheduledAt || null, path: target, file: path.relative(path.join(root, 'data', 'media'), target) });
      }
    }
  }
  return out;
}

// The sha256 the cloud stores a missing file under: its own fileHashes row, else the one
// sha every row with the same basename agrees on (the key can differ when a checkout moved).
export function knownSha(abs, state = loadState()) {
  const hashes = state.fileHashes || {};
  if (hashes[abs]?.sha256) return { sha256: hashes[abs].sha256, bytes: hashes[abs].bytes || null };
  const base = path.basename(abs);
  const shas = new Map();
  for (const [k, v] of Object.entries(hashes)) if (path.basename(k) === base && v?.sha256) shas.set(v.sha256, v.bytes || null);
  return shas.size === 1 ? { sha256: [...shas.keys()][0], bytes: [...shas.values()][0] } : null;
}

// Download a presigned url to a temp file beside abs, verify the sha256, rename into place
// only when abs is still missing. Throws on any mismatch; never leaves a partial file.
async function downloadVerified(url, abs, sha256, mediaDir) {
  if (!restoreTargetOk(abs, mediaDir)) throw Object.assign(new Error('restore target is outside data/media'), { reason: 'cloud-error' });
  const tmp = `${abs}.restore-${process.pid}-${Date.now()}.tmp`;
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const res = await fetch(url);
  if (!res.ok || !res.body) throw Object.assign(new Error(`download HTTP ${res.status}`), { reason: 'cloud-error' });
  const hash = crypto.createHash('sha256');
  const tap = new Transform({ transform(chunk, _enc, cb) { hash.update(chunk); cb(null, chunk); } });
  try {
    await pipeline(Readable.fromWeb(res.body), tap, fs.createWriteStream(tmp, { flags: 'wx' }));
    const got = hash.digest('hex');
    if (got !== sha256) throw Object.assign(new Error(`sha256 mismatch (${got.slice(0, 12)})`), { reason: 'hash-mismatch' });
    if (fs.existsSync(abs)) { fs.rmSync(tmp, { force: true }); return false; }
    fs.renameSync(tmp, abs);
    return true;
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

// Restore every missing file the cloud still holds. `fetchMedia(sha256)` resolves to
// { present, url, bytes } (lib/cloud-client.mjs fetchCloudMedia) and is injectable for tests.
// Records state.mediaHeal = { checkedAt, missing:[...still missing, with reason] }.
export async function healMissingMedia({ actor = 'scheduler', fetchMedia = null, root = activeRoot(), now = Date.now() } = {}) {
  const missing = findMissingMedia({ root });
  const restored = [];
  const still = [];
  if (missing.length) {
    const fetcher = fetchMedia || (await import('./cloud-client.mjs')).fetchCloudMedia;
    const byPath = new Map();
    for (const m of missing) {
      if (!byPath.has(m.path)) byPath.set(m.path, []);
      byPath.get(m.path).push(m);
    }
    for (const [abs, posts] of byPath) {
      const known = knownSha(abs);
      let reason = null;
      let detail = null;
      if (!known) reason = 'never-uploaded';
      else {
        try {
          const r = await fetcher(known.sha256);
          if (!r || r.present !== true || !r.url) reason = 'purged';
          // false = the file came back on its own while downloading: nothing to record.
          else if (!(await downloadVerified(r.url, abs, known.sha256, path.join(root, 'data', 'media')))) continue;
          else {
            const bytes = fs.statSync(abs).size;
            restored.push({ file: posts[0].file, bytes, sha256: known.sha256, posts: posts.map(fmtPost) });
            appendActivity({
              campaign: posts[0].campaign, postId: posts[0].postId, platform: null, action: 'media-restore', ok: true, errorCode: null,
              errorMessage: `Restored ${posts[0].file} (${mb(bytes)}) from the cloud for ${posts.map(fmtPost).join(', ')}`,
              lateMin: null, actor, bytes, file: posts[0].file,
            });
            logLine('info', `media-heal: restored ${posts[0].file} from the cloud (${mb(bytes)})`);
            continue;
          }
        } catch (err) {
          if (err.reason) reason = err.reason;
          else if (err.code === 'not_configured' || err.code === 'no_api_key') reason = 'no-cloud';
          else if (err.status === 404 || err.status === 405) reason = 'endpoint-missing';
          else reason = 'cloud-error';
          detail = err.code === 'network_error' ? describeFetchFailure(err) : err.message;
        }
      }
      for (const p of posts) still.push({ campaign: p.campaign, postId: p.postId, scheduledAt: p.scheduledAt, file: p.file, path: abs, reason, ...(detail ? { detail: String(detail).slice(0, 200) } : {}) });
    }
  }
  const state = loadState();
  state.mediaHeal = { checkedAt: new Date(now).toISOString(), missing: still };
  saveState();
  return { restored, missing: still };
}

// The still-missing rows pendpost_health raises, re-checked against the disk so a file the
// owner put back clears at once.
export function lostMedia(state = loadState()) {
  const rows = state.mediaHeal && Array.isArray(state.mediaHeal.missing) ? state.mediaHeal.missing : [];
  return rows.filter((r) => r && r.path && !fs.existsSync(r.path));
}

// ---------- the verb + the sweeps ----------

// media_cleanup { dryRun = true, actor }. A dry run reports; a run heals first, then deletes.
// Works whether or not posting.mediaCleanup.enabled is on.
export async function mediaCleanup({ dryRun = true, actor, fetchMedia = null, now = Date.now() } = {}) {
  if (typeof actor !== 'string' || !actor.trim()) return errorBody('invalid_input', 'actor is required');
  if (dryRun !== true && dryRun !== false) return errorBody('invalid_input', 'dryRun must be a boolean');
  const cfg = cleanupConfig();
  const clientId = boundClientId() || activeClientId();
  let heal = null;
  if (!dryRun) heal = await healMissingMedia({ actor: actor.trim(), fetchMedia, now });
  const plan = planCleanup({ now, graceDays: cfg.graceDays });
  const missing = heal ? heal.missing : findMissingMedia().map((m) => ({ ...m, sha256Known: Boolean(knownSha(m.path)) }));
  const base = { clientId, dryRun, enabled: cfg.enabled, graceDays: cfg.graceDays, missing, ...(heal ? { restored: heal.restored } : {}) };
  if (!plan.ok) return errorBody('manifest_error', `nothing deleted: a plan file could not be read, so a reference could be hidden (${plan.errors.map((e) => `${e.file}: ${e.error}`).join('; ')})`, { errors: plan.errors });
  const out = { ...base, ok: true, bytesDeletable: plan.bytesDeletable, deletable: plan.deletable, kept: plan.kept };
  if (dryRun) return out;
  const { deleted, failed, bytesFreed } = deleteFiles(plan.deletable, actor.trim());
  const state = loadState();
  state.mediaCleanup = { lastRunAt: new Date(now).toISOString(), lastFreed: bytesFreed, lastDeleted: deleted.length };
  saveState();
  return { ...out, deleted, failed, bytesFreed };
}

// Scheduler hooks (lib/scheduler.mjs tick, inside the per-client scope). Both are fail-soft.
export async function mediaHealSweep({ now = Date.now() } = {}) {
  try {
    const last = Date.parse(loadState().mediaHeal?.checkedAt || 0) || 0;
    if (now - last < HEAL_EVERY_MS) return null;
    return await healMissingMedia({ now });
  } catch (err) {
    logLine('warn', `media-heal sweep failed: ${err.message}`);
    return null;
  }
}

export async function mediaCleanupSweep({ now = Date.now() } = {}) {
  try {
    if (!cleanupConfig().enabled) return null;
    const last = Date.parse(loadState().mediaCleanup?.lastRunAt || 0) || 0;
    if (now - last < CLEANUP_EVERY_MS) return null;
    return await mediaCleanup({ dryRun: false, actor: 'scheduler', now });
  } catch (err) {
    logLine('warn', `media-cleanup sweep failed: ${err.message}`);
    return null;
  }
}
