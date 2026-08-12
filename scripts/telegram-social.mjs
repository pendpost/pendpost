#!/usr/bin/env node
/**
 * telegram-social.mjs - direct Telegram channel publishing via the Bot API.
 *
 * Sibling of scripts/x-social.mjs / linkedin-social.mjs / meta-social.mjs:
 * the same zero-dep, plan-driven, publish-straight-from-the-local-render pattern,
 * with Telegram's own (refreshingly simple) auth + posting model.
 *
 * Telegram has NO scheduling API and NO browser OAuth - a bot is a STATIC token
 * from @BotFather, so entries publish at their due time by re-running `publish-due`
 * (driven by the scheduler tick), exactly like Instagram / LinkedIn / X.
 *
 * AUTH - a single static bot token, no ceremony:
 *   TELEGRAM_BOT_TOKEN   the token @BotFather hands you (e.g. 8751599818:AA...).
 *   TELEGRAM_CHANNEL_ID  the destination: a public channel @username (recommended,
 *                        gives clean permalinks) or a numeric chat id (-100...).
 *   The bot must be an ADMINISTRATOR of the channel with "Post Messages" rights.
 * `connect`/`auth` here is just a validation handshake (getMe + getChat): there is
 * no token to mint, so it only confirms the static creds actually authenticate.
 *
 * Media uploads stream straight from the local render folder (post.path /
 * plan.folder + post.file) as a Bot API multipart upload - no hosting layer.
 * Text comes from post.tgCaption (falls back to post.caption), the additive
 * per-platform override pattern x uses for xCaption.
 *
 * Spec 14: an optional post.tgCta ({ buttons?, linkPreview?, format? }) adds
 * inline CTA buttons (reply_markup), disables the link preview, and/or sets
 * parse_mode=HTML on sendMessage/sendPhoto/sendVideo.
 *
 * Commands:
 *   auth | connect   validate the static creds (getMe + getChat); writes nothing
 *   refresh          no-op (bot tokens are static) - kept for sibling parity
 *   validate         --plan <p> [--only <id>]   side-effect-free preview, never posts
 *   publish-due      --plan <p> [--only <id>] [--dry-run]   publish any due Telegram entry
 *   status           --plan <p>                 list Telegram plan entries
 *   verify           --plan <p> [--only <id>]   read-only liveness (best-effort)
 *   insights         --plan <p> [--only <id>]   account-scoped subscriber count via getChatMemberCount (spec 08)
 *   probe                                        read-only health probe (getMe)
 *   delete           --id <messageId>            delete a channel message (cleanup)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveMode, isMockableCommand } from '../lib/mode.mjs';
import { enforceCeremonyClient } from '../lib/cli-client.mjs';
import { recordAttempt } from '../lib/publish-hold.mjs';
import { runMockCommand } from '../lib/drivers/mock-driver.mjs';
import { isPollPost, pollOptions, pollDurationMinutes, pollMultiple, pollBlocker, pollBlockRow, POLL_LANE_LIMITS } from '../lib/poll.mjs';
import { isCarouselPost, carouselItems, carouselItemKind, carouselBlocker, carouselBlockRow } from '../lib/carousel.mjs';
import { avSyncBlocker, avSyncBlockRow } from '../lib/assets.mjs';
import { envPath } from '../lib/util.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = envPath();

// Telegram caps: a text message at 4096 chars, a media caption at 1024.
const TEXT_LIMIT = 4096;
const CAPTION_LIMIT = 1024;

// ---------- env helpers (same shape as the sibling engines) ----------

function readEnvRaw() {
  return fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8') : '';
}
function readEnv(name) {
  const m = readEnvRaw().match(new RegExp(`^${name}=(.+)$`, 'm'));
  return m ? m[1].trim() : null;
}

const apiBase = () => `https://api.telegram.org/bot${readEnv('TELEGRAM_BOT_TOKEN')}`;
const channelId = () => readEnv('TELEGRAM_CHANNEL_ID');

// ---------- Bot API helper ----------

async function tg(method, { body, form } = {}) {
  const url = `${apiBase()}/${method}`;
  const init = form
    ? { method: 'POST', body: form }
    : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) };
  const res = await fetch(url, init);
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok || data.ok === false) {
    throw new Error(`Telegram ${method}: HTTP ${res.status} - ${data.description || data.raw || text || 'unknown'}`);
  }
  return data.result;
}

// ---------- plan helpers (same shape as the sibling engines) ----------

function loadPlan(planPath) {
  const abs = path.resolve(planPath);
  return { abs, plan: JSON.parse(fs.readFileSync(abs, 'utf8')) };
}

const ENGINE_OWNED_FIELDS = ['fbPostId', 'fbReelId', 'igMediaId', 'liPostId', 'ytVideoId', 'xPostId', 'tgMessageId', 'dcMessageId', 'status', 'postedAt', 'attempts', 'publishHold'];

async function withPlanLock(abs, fn) {
  const lockDir = `${abs}.lock.d`;
  for (let i = 0; ; i++) {
    try { fs.mkdirSync(lockDir); break; } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      let ageMs = 0;
      try { ageMs = Date.now() - fs.statSync(lockDir).mtimeMs; } catch { continue; }
      if (ageMs > 15 * 60 * 1000) { try { fs.rmdirSync(lockDir); } catch { /* racing steal */ } continue; }
      if (i >= 5) throw new Error(`plan lock busy: ${lockDir}`);
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  try { return fn(); } finally { try { fs.rmdirSync(lockDir); } catch { /* released */ } }
}

async function savePlan(abs, plan, touchedIds = null) {
  await withPlanLock(abs, () => {
    let out = plan;
    if (Array.isArray(touchedIds)) {
      try {
        const disk = JSON.parse(fs.readFileSync(abs, 'utf8'));
        for (const id of touchedIds) {
          const mem = (plan.posts || []).find((p) => p.id === id);
          const target = (disk.posts || []).find((p) => p.id === id);
          if (!mem || !target) continue;
          for (const f of ENGINE_OWNED_FIELDS) if (mem[f] !== undefined) target[f] = mem[f];
        }
        out = disk;
      } catch { /* unreadable disk copy - fall back to in-memory plan */ }
    }
    const tmp = `${abs}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, `${JSON.stringify(out, null, 2)}\n`);
    fs.renameSync(tmp, abs);
  });
}

function appendAttempt(post, entry) {
  // Shared recorder (lib/publish-hold.mjs): trims the attempts tail and maintains
  // the publishHold failure cap - the local mirror of the cloud re-fire cap.
  recordAttempt(post, entry);
}

// Exported (mirrors scripts/reddit-social.mjs's RUN) so a test can drive cmdEdit
// in-process with a stubbed global.fetch and read the accumulated result rows
// with no network and no spawned child process.
export const RUN = { results: [] };
let JSON_MODE = false;
let ACTOR = 'cli';

function resolveMediaPath(plan, post) {
  const root = process.env.PENDPOST_ROOT ? path.resolve(process.env.PENDPOST_ROOT) : path.resolve(__dirname, '..');
  if (post.path) {
    const abs = path.isAbsolute(post.path) ? post.path : path.resolve(root, post.path);
    if (fs.existsSync(abs)) return abs;
  }
  if (post.file) {
    const rel = path.join(plan.folder || '', post.file);
    const abs = path.isAbsolute(rel) ? rel : path.resolve(root, rel);
    if (fs.existsSync(abs)) return abs;
  }
  return null;
}

const isTelegram = (post) => (post.platforms || []).includes('telegram');
const isTextPost = (post) => post.type === 'text';
const messageText = (post) => (post.tgCaption || post.caption || '').trim();

// The sendPoll body for a poll post (spec 10): a regular (non-quiz) poll, 2-10 options.
// open_period auto-closes the poll after `durationMinutes`; Bot API 9.6 (2026-04) raised
// the auto-close max to 2,628,000 s (~30 days), so a 1-day poll DOES close after 1 day
// (open_period=86400). A duration outside 5s..2,628,000s is created open-ended (no
// open_period) rather than silently dropped - platformValidate warns on the too-long
// case. Pure + exported so a test asserts open_period without a Telegram round-trip.
const TG_OPEN_PERIOD_MAX_SEC = 2628000;
export function buildPollBody(post, question, chatId) {
  const openSec = pollDurationMinutes(post) * 60;
  return {
    chat_id: chatId,
    question,
    options: pollOptions(post).map((o) => ({ text: o })),
    is_anonymous: true,
    type: 'regular',
    allows_multiple_answers: pollMultiple(post),
    ...(openSec >= 5 && openSec <= TG_OPEN_PERIOD_MAX_SEC ? { open_period: openSec } : {}),
  };
}

// Public permalink: only derivable for a public @username channel.
function permalinkFor(post) {
  if (!post.tgMessageId) return null;
  const ch = (channelId() || '').trim();
  if (ch.startsWith('@')) return `https://t.me/${ch.slice(1)}/${post.tgMessageId}`;
  return null;
}

function mediaField(localPath) {
  return /\.(mp4|mov|m4v)$/i.test(localPath) ? { field: 'video', method: 'sendVideo' } : { field: 'photo', method: 'sendPhoto' };
}

// Spec 14: rich link/CTA - inline buttons + link-preview/format control, threaded
// onto sendMessage/sendPhoto/sendVideo. Empty object when the post carries no
// tgCta, so a plain post's send stays byte-identical to before this feature.
function tgCtaExtra(post) {
  const cta = post.tgCta;
  if (!cta) return {};
  const extra = {};
  if (cta.format === 'html') extra.parse_mode = 'HTML';
  extra.link_preview_options = { is_disabled: cta.linkPreview === false };
  if (Array.isArray(cta.buttons) && cta.buttons.length) {
    extra.reply_markup = { inline_keyboard: cta.buttons.map((b) => [{ text: b.label, url: b.url }]) };
  }
  return extra;
}

// ---------- commands ----------

async function cmdAuth() {
  if (!readEnv('TELEGRAM_BOT_TOKEN')) { console.error('[err] TELEGRAM_BOT_TOKEN missing in .env (get it from @BotFather).'); process.exit(2); }
  const me = await tg('getMe');
  console.log(`[ok] Bot token valid - authenticated as @${me.username} (id ${me.id}).`);
  const ch = channelId();
  if (!ch) { console.error('[err] TELEGRAM_CHANNEL_ID missing in .env (the @username or numeric id of the destination channel).'); process.exit(2); }
  const chat = await tg('getChat', { body: { chat_id: ch } });
  console.log(`[ok] Channel reachable - ${chat.type} "${chat.title || ch}". Ensure the bot is an admin with Post Messages.`);
  RUN.results.push({ platform: 'telegram', action: 'auth', ok: true, detail: `@${me.username} -> ${chat.title || ch}` });
}

async function cmdRefresh() {
  console.log('[info] Telegram bot tokens are static (no refresh).');
}

async function cmdValidate(args) {
  const { plan } = loadPlan(args.plan);
  console.log('================ VALIDATION ONLY - NOTHING WILL BE PUBLISHED ================');
  try {
    const me = await tg('getMe');
    console.log(`[ok] Token valid - authenticated as @${me.username}.`);
  } catch (err) {
    console.log(`[warn] getMe failed (${err.message}). Continuing to caption preview.`);
  }
  const targets = (plan.posts || []).filter((p) => isTelegram(p) && (!args.only || p.id === args.only));
  if (!targets.length) { console.log('[warn] No Telegram entries match.'); return; }
  for (const post of targets) {
    const text = messageText(post);
    const limit = isTextPost(post) ? TEXT_LIMIT : CAPTION_LIMIT;
    console.log(`\n----- ${post.id} -----`);
    console.log(`[preview] type:    ${post.type}`);
    console.log(`[preview] text (${text.length}/${limit}${text.length > limit ? ' - OVER LIMIT' : ''}):`);
    console.log(text);
    if (!isTextPost(post)) {
      const mediaPath = resolveMediaPath(plan, post);
      if (!mediaPath) console.log(`[warn] media not found (${post.path || post.file}).`);
      else console.log(`[preview] media:   ${path.basename(mediaPath)} (${(fs.statSync(mediaPath).size / 1e6).toFixed(1)} MB)`);
    }
  }
  console.log('\n================ VALIDATION COMPLETE ================');
}

async function cmdPublishDue(args) {
  const { abs, plan } = loadPlan(args.plan);
  const ch = channelId();
  if (!ch) throw new Error('TELEGRAM_CHANNEL_ID is not set - cannot publish.');
  const now = Date.now();
  let published = 0;

  for (const post of plan.posts || []) {
    if (args.only && post.id !== args.only) continue;
    if (!isTelegram(post)) continue;
    if (post.executionMode !== 'fully-scheduled') continue;
    if (post.status !== 'planned') continue;
    // Publish hold (lib/publish-hold.mjs): the failure cap is spent - never re-fire on
    // its own. Backstop for direct CLI runs; the scheduler's lanesOwed already drops a
    // held post from the fire loop. Reschedule or edit clears the hold.
    if (post.publishHold) {
      console.log(`[skip] ${post.id}: publish hold after repeated failures (${post.publishHold.code ?? post.publishHold.message ?? 'unknown'}) - reschedule or edit the post to retry.`);
      continue;
    }
    if ((post.approval || 'draft') !== 'approved') {
      console.log(`[skip] ${post.id}: approval is "${post.approval || 'draft'}" - only approved posts publish.`);
      continue;
    }
    const dueMs = Date.parse(post.scheduledAt);
    if (Number.isNaN(dueMs) || dueMs > now) continue;

    const text = messageText(post);
    const textPost = isTextPost(post);
    // Spec 10: a native poll (sendPoll) - the question is the caption; carries no media.
    const pollPost = isPollPost(post);
    if ((textPost || pollPost) && !text) { console.log(`[warn] ${post.id}: due but no ${pollPost ? 'poll question' : 'text'} (tgCaption/caption) - skipping.`); continue; }
    // Fail-closed BEFORE any Telegram call: 2-10 non-empty options, a <=300-char question
    // + a positive duration. A blocked poll emits a structured invalid_poll row (never a
    // silent skip that re-dispatches every sweep).
    if (pollPost) {
      const blocker = pollBlocker(post, text, POLL_LANE_LIMITS.telegram);
      if (blocker) {
        console.log(`[warn] ${post.id}: ${blocker} - skipping.`);
        RUN.results.push(pollBlockRow(post, 'telegram', blocker));
        continue;
      }
    }
    // Spec 05: a native album (sendMediaGroup) - 2..10 photos/videos, the caption on the
    // first item only. Fail-closed BEFORE any call (count/cap + slides-on-disk).
    const carouselPost = isCarouselPost(post);
    let carouselPaths = [];
    if (carouselPost) {
      carouselPaths = carouselItems(post).map((it) => resolveMediaPath(plan, { file: it.file, path: it.path }));
      const blocker = carouselBlocker(post, 'telegram', carouselPaths.map((p) => ({ exists: Boolean(p) })));
      if (blocker) {
        console.log(`[warn] ${post.id}: ${blocker} - skipping.`);
        RUN.results.push(carouselBlockRow(post, 'telegram', blocker));
        continue;
      }
    }
    const limit = textPost ? TEXT_LIMIT : CAPTION_LIMIT;
    if (!pollPost && !carouselPost && text.length > limit) { console.log(`[warn] ${post.id}: text is ${text.length} chars (> ${limit}) - skipping.`); continue; }

    let mediaPath = null;
    if (!textPost && !pollPost && !carouselPost) {
      mediaPath = resolveMediaPath(plan, post);
      if (!mediaPath) { console.log(`[warn] ${post.id}: due but local media not found (${post.path || post.file}) - skipping.`); continue; }
      // Fresh-bytes A/V-sync backstop: probe the actual video bytes about to upload (not
      // the manifest's stale author-time avSyncOk) - a measured desync is a malformed mux.
      // Self-gates on image/photo posts (a jpg never probes).
      const avBlock = await avSyncBlocker(mediaPath);
      if (avBlock) {
        console.log(`[warn] ${post.id}: ${avBlock} - skipping.`);
        RUN.results.push(avSyncBlockRow(post, 'telegram', avBlock));
        continue;
      }
    }

    if (args['dry-run']) {
      if (pollPost) console.log(`[dry] ${post.id}: would send a poll (${pollOptions(post).length} options).`);
      else if (carouselPost) console.log(`[dry] ${post.id}: would send an album of ${carouselPaths.length} media.`);
      else console.log(textPost ? `[dry] ${post.id}: would send a text message (${text.length} chars).` : `[dry] ${post.id}: would upload ${path.basename(mediaPath)} + caption.`);
      continue;
    }

    console.log(`[info] ${post.id}: publishing ${pollPost ? 'poll' : (carouselPost ? 'album' : (textPost ? 'text message' : 'media'))} to Telegram...`);
    try {
      let result;
      const ctaExtra = tgCtaExtra(post);
      if (pollPost) {
        result = await tg('sendPoll', { body: buildPollBody(post, text, ch) });
      } else if (carouselPost) {
        // sendMediaGroup: 2..10 photos/videos in one album; the caption rides the FIRST
        // item only (Telegram shows it under the whole group). Each file is a multipart
        // part referenced by attach://fN. The response is an ARRAY of messages - the
        // first message id is the album's canonical id.
        const form = new FormData();
        form.append('chat_id', String(ch));
        const media = carouselPaths.map((p, i) => ({
          type: carouselItemKind({ path: p }) === 'video' ? 'video' : 'photo',
          media: `attach://f${i}`,
          ...(i === 0 && text ? { caption: text } : {}),
        }));
        form.append('media', JSON.stringify(media));
        carouselPaths.forEach((p, i) => form.append(`f${i}`, new Blob([fs.readFileSync(p)]), path.basename(p)));
        const group = await tg('sendMediaGroup', { form });
        result = Array.isArray(group) ? group[0] : group;
      } else if (textPost) {
        result = await tg('sendMessage', { body: { chat_id: ch, text, ...ctaExtra } });
      } else {
        const { field, method } = mediaField(mediaPath);
        const form = new FormData();
        form.append('chat_id', String(ch));
        if (text) form.append('caption', text);
        // link_preview_options is a sendMessage-only param - ignored (and
        // omitted) for a media upload; reply_markup/parse_mode still apply.
        if (ctaExtra.reply_markup) form.append('reply_markup', JSON.stringify(ctaExtra.reply_markup));
        if (ctaExtra.parse_mode) form.append('parse_mode', ctaExtra.parse_mode);
        form.append(field, new Blob([fs.readFileSync(mediaPath)]), path.basename(mediaPath));
        result = await tg(method, { form });
      }
      const messageId = result?.message_id;
      if (!messageId) throw new Error(`send returned no message_id: ${JSON.stringify(result).slice(0, 200)}`);

      post.tgMessageId = String(messageId);
      post.status = 'posted';
      post.postedAt = new Date(now).toISOString();
      appendAttempt(post, { ts: new Date().toISOString(), platform: 'telegram', action: 'publish', ok: true, errorCode: null, errorMessage: null, actor: ACTOR });
      await savePlan(abs, plan, [post.id]);
      RUN.results.push({ postId: post.id, platform: 'telegram', action: 'publish', ok: true, id: String(messageId) });
      console.log(`[ok] ${post.id}: published on Telegram (message ${messageId}).`);
      published += 1;
    } catch (err) {
      appendAttempt(post, { ts: new Date().toISOString(), platform: 'telegram', action: 'publish', ok: false, errorCode: 'engine_failure', errorMessage: err.message.slice(0, 300), actor: ACTOR });
      await savePlan(abs, plan, [post.id]);
      RUN.results.push({ postId: post.id, platform: 'telegram', action: 'publish', ok: false, errorCode: 'engine_failure', errorMessage: err.message.slice(0, 300) });
      console.error(`[err] ${post.id}: Telegram publish failed - ${err.message}`);
      continue;
    }
  }
  console.log(`[done] publish-due complete - ${published} message(s) published.`);
}

async function cmdStatus(args) {
  const { plan } = loadPlan(args.plan);
  console.log('[info] Telegram plan entries:');
  for (const post of (plan.posts || []).filter(isTelegram)) {
    console.log(`  ${post.id.padEnd(18)} ${String(post.status).padEnd(10)} ${post.scheduledAt}  mode=${post.executionMode}${post.tgMessageId ? ` tg=${post.tgMessageId}` : ''}`);
  }
}

// Best-effort liveness: the Bot API cannot read an arbitrary channel message back,
// so a stored message id (the post succeeded) + a reachable channel is our signal.
async function cmdVerify(args) {
  const { plan } = loadPlan(args.plan);
  const ch = channelId();
  let reachable = false;
  try { await tg('getChat', { body: { chat_id: ch } }); reachable = true; } catch { /* surfaced per row */ }
  for (const post of (plan.posts || []).filter(isTelegram)) {
    if (args.only && post.id !== args.only) continue;
    if (!post.tgMessageId) continue;
    RUN.results.push({ postId: post.id, platform: 'telegram', action: 'verify', ok: true, live: reachable, state: reachable ? 'sent' : 'unknown', permalink: reachable ? permalinkFor(post) : null, id: post.tgMessageId });
  }
}

// Edit-after-publish (spec 12, Pattern P3+P9): push a text/caption edit to an
// already-sent message, WITHOUT re-sending the media bytes (they cannot be
// swapped cheaply - documented limitation, matches the brief "edit-in-place").
// Branches on isTextPost: a text message edits via editMessageText (the message
// id itself), a media message edits via editMessageCaption (the caption only). A
// post with no tgMessageId no-ops with a clear result, so a bare CLI run is safe
// - it never mints/clears an id, never touches status/approval.
export async function cmdEdit(args) {
  const { abs, plan } = loadPlan(args.plan);
  const targets = (plan.posts || []).filter((p) => (!args.only || p.id === args.only) && isTelegram(p));
  if (!targets.length) { console.log('[done] edit complete - no matching posts.'); return; }
  let edited = 0;
  for (const post of targets) {
    if (!post.tgMessageId) {
      RUN.results.push({ postId: post.id, platform: 'telegram', action: 'edit', ok: true, skipped: 'no_minted_id' });
      console.log(`[skip] ${post.id}: no tgMessageId - nothing published to edit yet.`);
      continue;
    }
    // Spec 12 review (finding #5): a poll's question/options are Telegram's own,
    // immutable once sent - there is no editMessagePoll-for-the-question API (only
    // stopPoll, which CLOSES it early). Structured-skip, mirroring the no-minted-id
    // skip above, so PostDetail's editableLanes exclusion (type==='poll') and this
    // engine never disagree - the UI never offers it AND the engine never errors on it.
    if (isPollPost(post)) {
      RUN.results.push({ postId: post.id, platform: 'telegram', action: 'edit', ok: true, skipped: 'not_editable' });
      console.log(`[skip] ${post.id}: a poll's question/options cannot be edited via the Bot API.`);
      continue;
    }
    const text = messageText(post);
    const textPost = isTextPost(post);
    const limit = textPost ? TEXT_LIMIT : CAPTION_LIMIT;
    if (text.length > limit) {
      RUN.results.push({ postId: post.id, platform: 'telegram', action: 'edit', ok: false, errorCode: 'invalid_input', errorMessage: `text is ${text.length} chars (> ${limit})` });
      console.log(`[warn] ${post.id}: text is ${text.length} chars (> ${limit}) - not editing.`);
      continue;
    }
    try {
      // Spec 12 review (finding F1): re-thread the SAME tgCta extras the publish path
      // sends - editMessageText/editMessageCaption both support parse_mode +
      // reply_markup (link_preview_options is editMessageText/sendMessage-only, exactly
      // like the media-upload branch of cmdPublishDue above). OMITTING reply_markup on
      // an edit call DROPS the inline keyboard (the Bot API treats "absent" as "clear",
      // not "leave unchanged") - so a CTA post's buttons/formatting/preview setting must
      // ride every edit, not just the original publish.
      const ctaExtra = tgCtaExtra(post);
      if (textPost) {
        await tg('editMessageText', { body: { chat_id: channelId(), message_id: Number(post.tgMessageId), text, ...ctaExtra } });
      } else {
        const { link_preview_options: _linkPreviewOptions, ...captionExtra } = ctaExtra;
        await tg('editMessageCaption', { body: { chat_id: channelId(), message_id: Number(post.tgMessageId), caption: text, ...captionExtra } });
      }
      appendAttempt(post, { ts: new Date().toISOString(), platform: 'telegram', action: 'edit', ok: true, errorCode: null, errorMessage: null, actor: ACTOR });
      await savePlan(abs, plan, [post.id]);
      RUN.results.push({ postId: post.id, platform: 'telegram', action: 'edit', ok: true, id: post.tgMessageId });
      console.log(`[ok] ${post.id}: message ${post.tgMessageId} ${textPost ? 'text' : 'caption'} updated.`);
      edited += 1;
    } catch (err) {
      // Spec 12 review (finding F2): the Bot API 400s "message is not modified" when
      // the edit's content is byte-identical to what is already live - the end state
      // is exactly what was asked, so this is an IDEMPOTENT SUCCESS, not a failure.
      // Matched on the Bot API's own wording (stable across editMessageText/Caption)
      // rather than a status code, since both throw the same shaped error.
      if (/message is not modified/i.test(err.message || '')) {
        appendAttempt(post, { ts: new Date().toISOString(), platform: 'telegram', action: 'edit', ok: true, errorCode: null, errorMessage: null, actor: ACTOR });
        await savePlan(abs, plan, [post.id]);
        RUN.results.push({ postId: post.id, platform: 'telegram', action: 'edit', ok: true, id: post.tgMessageId, unchanged: true });
        console.log(`[ok] ${post.id}: message ${post.tgMessageId} already matches - no change needed.`);
        edited += 1;
        continue;
      }
      appendAttempt(post, { ts: new Date().toISOString(), platform: 'telegram', action: 'edit', ok: false, errorCode: 'engine_failure', errorMessage: err.message.slice(0, 300), actor: ACTOR });
      await savePlan(abs, plan, [post.id]);
      RUN.results.push({ postId: post.id, platform: 'telegram', action: 'edit', ok: false, errorCode: 'engine_failure', errorMessage: err.message.slice(0, 300) });
      console.error(`[err] ${post.id}: edit failed - ${err.message}`);
    }
  }
  console.log(`[done] edit complete - ${edited} message(s) updated.`);
}

// Spec 08 (richer analytics, Pattern P5): the Bot API exposes no per-post
// metrics, but IS honest about ONE account-wide number - getChatMemberCount,
// the channel's live subscriber count. Emitted as a single account-scoped row
// (postId:null, scope:'account') the generic sweep (lib/insights.mjs) merges
// into state.insights.account.telegram, exactly like GBP's `performance` /
// spec 07's `demographics` - just riding the SAME `insights` verb rather than
// a second command, since there is nothing per-post to also report.
async function cmdInsights(args) {
  const { plan } = loadPlan(args.plan);
  void plan;
  const ch = channelId();
  if (!ch) {
    RUN.results.push({ postId: null, platform: 'telegram', action: 'insights', ok: false, scope: 'account', errorCode: 'not_configured', errorMessage: 'TELEGRAM_CHANNEL_ID not set' });
    console.log('[warn] insights: TELEGRAM_CHANNEL_ID not set - subscribers unavailable.');
    return;
  }
  try {
    const count = await tg('getChatMemberCount', { body: { chat_id: ch } });
    RUN.results.push({ postId: null, platform: 'telegram', action: 'insights', ok: true, scope: 'account', metrics: { subscribers: Number(count) || 0 } });
    console.log(`[ok] Telegram subscribers: ${count}`);
  } catch (err) {
    RUN.results.push({ postId: null, platform: 'telegram', action: 'insights', ok: false, scope: 'account', errorCode: 'engine_failure', errorMessage: String(err.message || err).slice(0, 300) });
    console.error(`[err] getChatMemberCount failed - ${err.message}`);
  }
}

async function cmdDelete(args) {
  if (!args.id) { console.error('[err] delete requires --id <messageId>'); process.exit(2); }
  await tg('deleteMessage', { body: { chat_id: channelId(), message_id: Number(args.id) } });
  RUN.results.push({ platform: 'telegram', action: 'delete', ok: true, id: String(args.id) });
  console.log(`[ok] deleted Telegram message ${args.id}.`);
}

async function cmdProbe() {
  if (!readEnv('TELEGRAM_BOT_TOKEN')) {
    RUN.results.push({ platform: 'telegram', action: 'probe', ok: false, detail: 'not configured (TELEGRAM_BOT_TOKEN missing)' });
    return;
  }
  try {
    const me = await tg('getMe');
    RUN.results.push({ platform: 'telegram', action: 'probe', ok: true, detail: `connected as @${me.username}`, tokenExpiresAt: null });
  } catch (err) {
    RUN.results.push({ platform: 'telegram', action: 'probe', ok: false, detail: String(err.message || err).slice(0, 200) });
  }
}

// ---------- profile editing (spec 28 - the shipped X `profile` pattern, cloned) ----------
//
// Telegram edits the MANAGED CHANNEL's title/description/photo (setChatTitle /
// setChatDescription / setChatPhoto), NOT the bot's own BotFather profile. There is
// no OAuth "authenticated as" concept to mismatch (the bot token IS the identity) -
// the wrong-account risk here is the bot NOT actually administering the configured
// TELEGRAM_CHANNEL_ID (a stale/misconfigured chat id, or a sibling client's channel).
// The guard: getMe (this bot's user id) + getChatMember(channel, botId) must report
// administrator/creator BEFORE any write - never blindly post into a channel this
// bot cannot actually manage.

const TG_ADMIN_STATUSES = new Set(['administrator', 'creator']);

// Confirms the bot is an admin of the configured channel; returns the chat + bot
// identity on success. Throws a clear refusal (never edits) when the bot is not an
// admin, or when TELEGRAM_CHANNEL_ID names a chat the bot cannot resolve at all.
async function assertChannelAdmin() {
  const ch = channelId();
  if (!ch) throw new Error('TELEGRAM_CHANNEL_ID is not set in .env - refusing to edit a channel I cannot identify.');
  const me = await tg('getMe');
  const chat = await tg('getChat', { body: { chat_id: ch } });
  const member = await tg('getChatMember', { body: { chat_id: ch, user_id: me.id } });
  if (!TG_ADMIN_STATUSES.has(member.status)) {
    throw new Error(`refusing to edit profile: bot @${me.username} is "${member.status}" (not an admin) on ${chat.title || ch} - grant "Change info" admin rights first, or point TELEGRAM_CHANNEL_ID at the right channel.`);
  }
  return { me, chat };
}

function tgNeedsScope(err) {
  return /not enough rights/i.test(String(err.message || err));
}

// Exported (mirrors cmdEdit above) so a profile-edit test can drive the real
// probe/admin-guard/apply logic in-process against a stubbed global.fetch, with no
// network/credentials/subprocess.
export async function cmdProfile(args) {
  if (!readEnv('TELEGRAM_BOT_TOKEN')) {
    throw new Error('Telegram profile editing needs TELEGRAM_BOT_TOKEN + TELEGRAM_CHANNEL_ID in .env (the bot must be a channel admin with "Change info" rights).');
  }

  // --probe: the STEP 0 access-tier gate. Non-mutating: getMe + getChat +
  // getChatMember (all reads) - reports the admin tier, changes nothing.
  if (args.probe) {
    try {
      const { me, chat } = await assertChannelAdmin();
      RUN.results.push({ platform: 'telegram', action: 'profile-probe', ok: true, tier: 'permitted', detail: `@${me.username} is admin on ${chat.title || channelId()}` });
    } catch (err) {
      const tier = tgNeedsScope(err) ? 'blocked' : 'error';
      RUN.results.push({ platform: 'telegram', action: 'profile-probe', ok: false, tier, detail: String(err.message || err).slice(0, 300) });
    }
    return;
  }

  const title = typeof args.title === 'string' ? args.title : null;
  const description = typeof args.description === 'string' ? args.description : null;
  const image = typeof args.image === 'string' ? args.image : null;
  if (title == null && description == null && !image) {
    throw new Error('nothing to update - pass at least one of --title --description --image (or --probe).');
  }
  if (title != null && (!title.trim() || title.length > 128)) throw new Error(`--title must be 1..128 chars (got ${title.length}).`);
  if (description != null && description.length > 255) throw new Error(`--description is ${description.length} chars - Telegram caps a chat description at 255.`);
  if (image) {
    if (!fs.existsSync(image)) throw new Error(`--image file not found: ${image}`);
  }

  // Wrong-account guard (bot must administer the configured channel): never edit a
  // channel this bot does not actually manage.
  const { chat } = await assertChannelAdmin();
  const ch = channelId();

  if (args['dry-run']) {
    const changes = [];
    if (title != null) changes.push(`title="${title}"`);
    if (description != null) changes.push(`description(${description.length})`);
    if (image) changes.push(`photo=${path.basename(image)}`);
    console.error(`[dry] ${chat.title || ch}: would update ${changes.join(', ')}.`);
    RUN.results.push({ platform: 'telegram', action: 'profile-dry-run', ok: true, chatId: String(ch), changes });
    return;
  }

  // Apply in order: title -> description -> photo. Independent, non-atomic Bot API
  // calls; record each and continue on a sub-failure (X's per-field pattern).
  const run = async (action, fn, okMsg) => {
    try {
      await fn();
      RUN.results.push({ platform: 'telegram', action, ok: true, chatId: String(ch) });
      console.error(`[ok] ${chat.title || ch}: ${okMsg}.`);
    } catch (err) {
      if (tgNeedsScope(err)) {
        RUN.results.push({ platform: 'telegram', action, ok: false, error: 'needs_scope', scope: 'telegram_bot_admin_change_info', errorMessage: String(err.message || err).slice(0, 300) });
        console.error(`[err] ${action} needs the "Change info" admin right - ${err.message}`);
        return;
      }
      RUN.results.push({ platform: 'telegram', action, ok: false, errorCode: 'engine_failure', errorMessage: String(err.message || err).slice(0, 300) });
      console.error(`[err] ${action} failed - ${err.message}`);
    }
  };
  if (title != null) await run('profile-title', () => tg('setChatTitle', { body: { chat_id: ch, title } }), 'channel title updated');
  if (description != null) await run('profile-description', () => tg('setChatDescription', { body: { chat_id: ch, description } }), 'channel description updated');
  if (image) {
    const form = new FormData();
    form.append('chat_id', String(ch));
    form.append('photo', new Blob([fs.readFileSync(image)]), path.basename(image));
    await run('profile-image', () => tg('setChatPhoto', { form }), 'channel photo updated');
  }
  const rows = RUN.results.filter((r) => typeof r.action === 'string' && r.action.startsWith('profile-'));
  console.error(`[done] profile update - ${rows.filter((r) => r.ok).length} ok, ${rows.filter((r) => r.ok === false).length} failed.`);
}

// ---------- main ----------

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) args[key] = true;
      else args[key] = argv[++i];
    } else args._.push(a);
  }
  return args;
}

// The inbound-engagement seam (spec 02, Pattern P6): read + reply to inbound
// comments on this lane's own posts. Thin wrappers over the shared, source-agnostic
// REST in lib/comments.mjs (dynamic import so the publish hot path's module graph is
// untouched). The result is merged onto RUN so main() emits the normalized
// { items } / { id } envelope; a needs_scope degrade sets ok:false (P9).
async function cmdComments(args) {
  const { runLaneComments } = await import('../lib/comments.mjs');
  Object.assign(RUN, await runLaneComments('telegram', args));
}
async function cmdReply(args) {
  const { runLaneReply } = await import('../lib/comments.mjs');
  Object.assign(RUN, await runLaneReply('telegram', args));
}
async function cmdModerate(args) {
  const { runLaneModerate } = await import('../lib/comments.mjs');
  Object.assign(RUN, await runLaneModerate('telegram', args));
}
async function cmdReact(args) {
  const { runLaneReact } = await import('../lib/comments.mjs');
  Object.assign(RUN, await runLaneReact('telegram', args));
}

const COMMANDS = {
  auth: cmdAuth,
  connect: cmdAuth,
  comments: cmdComments,
  reply: cmdReply,
  moderate: cmdModerate,
  react: cmdReact,
  refresh: cmdRefresh,
  validate: cmdValidate,
  'publish-due': cmdPublishDue,
  status: cmdStatus,
  verify: cmdVerify,
  edit: cmdEdit,
  insights: cmdInsights,
  delete: cmdDelete,
  probe: cmdProbe,
  profile: cmdProfile,
};

async function main() {
  const args = parseArgs(process.argv);
  await enforceCeremonyClient({ argv: args, command: args._[0], lane: 'telegram', scriptUrl: import.meta.url });
  JSON_MODE = Boolean(args.json);
  ACTOR = typeof args.actor === 'string' ? args.actor : 'cli';
  if (JSON_MODE) console.log = (...a) => console.error(...a);
  const commandName = args._[0];
  if (resolveMode('telegram') === 'mock' && isMockableCommand(commandName)) {
    const envelope = await runMockCommand({
      platform: 'telegram', command: commandName,
      planPath: typeof args.plan === 'string' ? path.resolve(String(args.plan)) : null,
      only: typeof args.only === 'string' ? args.only : null,
      // spec 06: the moderate verb carries its action so the mock can branch per-lane.
      action: typeof args.action === 'string' ? args.action : null,
      // spec 24: the react verb carries its reaction/emoji/remove so the mock can branch per-lane.
      reaction: typeof args.reaction === 'string' ? args.reaction : null,
      emoji: typeof args.emoji === 'string' ? args.emoji : null,
      remove: args.remove === true,
      // spec 28 review: the profile verb's --probe flag, so mock mode can
      // distinguish a probe (read-only tier check) from an apply.
      probe: args.probe === true,
    });
    if (JSON_MODE) process.stdout.write(`${JSON.stringify(envelope)}\n`);
    else console.error(`[mock] telegram ${commandName}: ${envelope.results.length} result(s)`);
    return;
  }
  const cmd = COMMANDS[commandName];
  if (!cmd) {
    console.error(`Usage: node scripts/telegram-social.mjs <${Object.keys(COMMANDS).join('|')}> [options]`);
    process.exit(2);
  }
  if (['validate', 'publish-due', 'status', 'verify', 'edit', 'insights'].includes(commandName) && !args.plan) {
    console.error(`[err] ${commandName} requires --plan <post-plan.json>`);
    process.exit(2);
  }
  await cmd(args);
  if (JSON_MODE) process.stdout.write(`${JSON.stringify({ ok: true, ...RUN })}\n`);
}

// Run only when executed directly (node scripts/telegram-social.mjs ...), not when
// imported for a unit test of an exported helper (buildPollBody) - mirrors the guard
// nostr-social.mjs uses. The daemon invokes this as a subprocess, so argv[1] is this
// script and main() still runs in production.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(async (err) => {
    console.error('[err]', err.message || err);
    if (JSON_MODE) process.stdout.write(`${JSON.stringify({ ok: false, error: String(err.message || err).slice(0, 300), ...RUN })}\n`);
    process.exit(1);
  });
}
