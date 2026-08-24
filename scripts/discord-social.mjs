#!/usr/bin/env node
/**
 * discord-social.mjs - direct Discord channel publishing via an Incoming Webhook.
 *
 * Sibling of scripts/x-social.mjs / telegram-social.mjs: the same zero-dep,
 * plan-driven, publish-straight-from-the-local-render pattern, with Discord's
 * webhook posting model.
 *
 * Discord has NO scheduling API and NO browser OAuth for this path - a channel
 * Incoming Webhook is a STATIC URL (id + token) created in the channel settings,
 * so entries publish at their due time by re-running `publish-due` (driven by the
 * scheduler tick), exactly like Instagram / LinkedIn / X.
 *
 * AUTH - a single static webhook URL, no ceremony:
 *   DISCORD_WEBHOOK_URL  https://discord.com/api/webhooks/<id>/<token>
 * Posting with ?wait=true returns the created message (so we capture its id);
 * the webhook also supports GET/DELETE on its own messages (used by verify/delete).
 * `connect`/`auth` is a validation handshake (GET the webhook): nothing to mint.
 *
 * Media uploads stream straight from the local render folder as a multipart upload
 * (payload_json + files[0]); text comes from post.dcCaption (falls back to
 * post.caption), the additive per-platform override pattern x uses for xCaption.
 *
 * Spec 14: an optional post.dcEmbed ({ title?, description?, url?, color? }) rides
 * along as `embeds` on both the text and media payloads - a rich card, no CTA
 * buttons yet (those need an application-owned webhook + interaction listener).
 *
 * Commands:
 *   auth | connect   validate the webhook (GET it); writes nothing
 *   refresh          no-op (the webhook URL is static) - kept for sibling parity
 *   validate         --plan <p> [--only <id>]   side-effect-free preview, never posts
 *   publish-due      --plan <p> [--only <id>] [--dry-run]   publish any due Discord entry
 *   status           --plan <p>                 list Discord plan entries
 *   verify           --plan <p> [--only <id>]   read-only liveness (GET the message)
 *   insights         --plan <p> [--only <id>]   no-op (a webhook exposes no metrics)
 *   probe                                        read-only health probe (GET the webhook)
 *   delete           --id <messageId>            delete a posted message (cleanup)
 *   delete-event     --id <eventId>              delete a guild scheduled event (the
 *                                                deletePost cascade; 404 counts as gone)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveMode, isMockableCommand } from '../lib/mode.mjs';
import { enforceCeremonyClient } from '../lib/cli-client.mjs';
import { recordAttempt } from '../lib/publish-hold.mjs';
import { runMockCommand } from '../lib/drivers/mock-driver.mjs';
import { isPollPost, pollOptions, pollDurationMinutes, pollMultiple, pollBlocker, pollBlockRow, POLL_LANE_LIMITS } from '../lib/poll.mjs';
import { isCarouselPost, carouselItems, carouselBlocker, carouselBlockRow } from '../lib/carousel.mjs';
import { avSyncBlocker, avSyncBlockRow } from '../lib/assets.mjs';
import { envPath } from '../lib/util.mjs';
import { resolveCredential } from '../lib/cli-prompt.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = envPath();

// Discord caps a webhook message's content at 2000 chars.
const CONTENT_LIMIT = 2000;

function readEnvRaw() {
  return fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8') : '';
}
function readEnv(name) {
  const m = readEnvRaw().match(new RegExp(`^${name}=(.+)$`, 'm'));
  return m ? m[1].trim() : null;
}

function writeEnv(vars) {
  let raw = readEnvRaw();
  for (const [k, v] of Object.entries(vars)) {
    if (v == null) continue;
    // function replacer: token values may contain '$' which is special in a string replacement.
    if (new RegExp(`^${k}=`, 'm').test(raw)) {
      raw = raw.replace(new RegExp(`^${k}=.*$`, 'm'), () => `${k}=${v}`);
    } else {
      raw += `${raw.endsWith('\n') || raw === '' ? '' : '\n'}${k}=${v}\n`;
    }
  }
  // Atomic + 0600: a crash mid-write must never truncate the secret-bearing .env.
  const tmp = `${ENV_PATH}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, raw, { mode: 0o600 });
  fs.renameSync(tmp, ENV_PATH);
}

const webhookUrl = () => (readEnv('DISCORD_WEBHOOK_URL') || '').trim();

// ---------- Discord helper ----------

async function discord(method, url, { body, form, botAuth } = {}) {
  const init = form ? { method, body: form } : { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined };
  // The Bot REST API (users/@me, guilds) needs `Authorization: Bot <token>`; the
  // webhook URL is authenticated by the url itself (no header).
  if (botAuth) init.headers = { ...(init.headers || {}), Authorization: `Bot ${botAuth}` };
  const res = await fetch(url, init);
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) {
    throw new Error(`Discord ${method}: HTTP ${res.status} - ${data.message || data.raw || text || 'unknown'}`);
  }
  return data;
}

// The webhook object (GET the base URL) carries channel_id + guild_id for permalinks.
let _hookMeta = null;
async function webhookMeta() {
  if (_hookMeta) return _hookMeta;
  _hookMeta = await discord('GET', webhookUrl());
  return _hookMeta;
}

// ---------- plan helpers (same shape as the sibling engines) ----------

function loadPlan(planPath) {
  const abs = path.resolve(planPath);
  return { abs, plan: JSON.parse(fs.readFileSync(abs, 'utf8')) };
}

// Spec 26: dcEventId is the guild-scheduled-event id the `schedule-event` verb
// mints - engine-owned like dcMessageId, so it survives the field-merge save
// (savePlan below) under a concurrent edit.
const ENGINE_OWNED_FIELDS = ['fbPostId', 'fbReelId', 'igMediaId', 'liPostId', 'ytVideoId', 'xPostId', 'tgMessageId', 'dcMessageId', 'dcEventId', 'status', 'postedAt', 'attempts', 'publishHold', 'publishRetry'];

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
// in-process with no network and read the accumulated result rows.
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

const isDiscord = (post) => (post.platforms || []).includes('discord');
const isTextPost = (post) => post.type === 'text';
const messageText = (post) => (post.dcCaption || post.caption || '').trim();

// Spec 14: rich embed card threaded onto the webhook payload (`embeds`). Returns
// undefined when the post carries no dcEmbed, so a plain post's payload stays
// byte-identical to before this feature. No `components`/buttons field until the
// app-owned-webhook path exists (Pattern P9) - only title/description/url/color.
function dcEmbedsFor(post) {
  const e = post.dcEmbed;
  if (!e) return undefined;
  const embed = {
    ...(e.title ? { title: e.title } : {}),
    ...(e.description ? { description: e.description } : {}),
    ...(e.url ? { url: e.url } : {}),
    ...(Number.isInteger(e.color) ? { color: e.color } : {}),
  };
  // A dcEmbed with no renderable member ({} or all-empty strings) would send
  // as embeds:[{}], which Discord rejects (empty embed) - failing the post at
  // fire time. Drop it entirely so the payload is byte-identical to no-embed.
  if (!Object.keys(embed).length) return undefined;
  return [embed];
}

async function permalinkFor(post) {
  if (!post.dcMessageId) return null;
  try {
    const meta = await webhookMeta();
    if (meta.guild_id && meta.channel_id) return `https://discord.com/channels/${meta.guild_id}/${meta.channel_id}/${post.dcMessageId}`;
  } catch { /* best-effort */ }
  return null;
}

// ---------- commands ----------

async function cmdAuth() {
  // .env still wins; otherwise, on an interactive terminal, prompt the operator to paste
  // the webhook URL (hidden, never echoed, never in shell history) and persist it so the
  // liveness probe below (and every later run) can read it. A non-interactive run
  // (daemon/CI/mock) skips the prompt and fails closed at the guard.
  const url = await resolveCredential({
    value: webhookUrl(),
    secret: true,
    hint: 'Paste your Discord Incoming Webhook URL (channel settings > Integrations > Webhooks): ',
  });
  if (!url) { console.error('[err] DISCORD_WEBHOOK_URL missing in .env (create an Incoming Webhook in the channel settings).'); process.exit(2); }
  writeEnv({ DISCORD_WEBHOOK_URL: url });
  const meta = await webhookMeta();
  console.log(`[ok] Webhook valid - "${meta.name}" in channel ${meta.channel_id}${meta.guild_id ? ` (guild ${meta.guild_id})` : ''}.`);
  RUN.results.push({ platform: 'discord', action: 'auth', ok: true, detail: `${meta.name} -> channel ${meta.channel_id}` });
}

async function cmdRefresh() {
  console.log('[info] Discord webhook URLs are static (no refresh).');
}

async function cmdValidate(args) {
  const { plan } = loadPlan(args.plan);
  console.log('================ VALIDATION ONLY - NOTHING WILL BE PUBLISHED ================');
  try {
    const meta = await webhookMeta();
    console.log(`[ok] Webhook valid - "${meta.name}".`);
  } catch (err) {
    console.log(`[warn] webhook check failed (${err.message}). Continuing to caption preview.`);
  }
  const targets = (plan.posts || []).filter((p) => isDiscord(p) && (!args.only || p.id === args.only));
  if (!targets.length) { console.log('[warn] No Discord entries match.'); return; }
  for (const post of targets) {
    const text = messageText(post);
    console.log(`\n----- ${post.id} -----`);
    console.log(`[preview] type:    ${post.type}`);
    console.log(`[preview] text (${text.length}/${CONTENT_LIMIT}${text.length > CONTENT_LIMIT ? ' - OVER LIMIT' : ''}):`);
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
  if (!webhookUrl()) throw new Error('DISCORD_WEBHOOK_URL is not set - cannot publish.');
  const now = Date.now();
  let published = 0;

  for (const post of plan.posts || []) {
    if (args.only && post.id !== args.only) continue;
    if (!isDiscord(post)) continue;
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
    // Spec 10: a native poll message - the question is the caption; carries no media.
    const pollPost = isPollPost(post);
    if ((textPost || pollPost) && !text) { console.log(`[warn] ${post.id}: due but no ${pollPost ? 'poll question' : 'text'} (dcCaption/caption) - skipping.`); continue; }
    // Fail-closed BEFORE the webhook call: <=10 answers, a <=300-char question + a
    // positive duration inside Discord's <=32d window. A blocked poll emits a structured
    // invalid_poll row (never a silent skip, and never a silent question truncation).
    if (pollPost) {
      const blocker = pollBlocker(post, text, POLL_LANE_LIMITS.discord);
      if (blocker) {
        console.log(`[warn] ${post.id}: ${blocker} - skipping.`);
        RUN.results.push(pollBlockRow(post, 'discord', blocker));
        continue;
      }
    }
    // Spec 05: a native album - up to 10 attachments on ONE webhook message. Fail-closed
    // BEFORE the webhook call (count/cap + slides-on-disk), never a half-posted message.
    const carouselPost = isCarouselPost(post);
    let carouselPaths = [];
    if (carouselPost) {
      carouselPaths = carouselItems(post).map((it) => resolveMediaPath(plan, { file: it.file, path: it.path }));
      const blocker = carouselBlocker(post, 'discord', carouselPaths.map((p) => ({ exists: Boolean(p) })));
      if (blocker) {
        console.log(`[warn] ${post.id}: ${blocker} - skipping.`);
        RUN.results.push(carouselBlockRow(post, 'discord', blocker));
        continue;
      }
    }
    if (!pollPost && !carouselPost && text.length > CONTENT_LIMIT) { console.log(`[warn] ${post.id}: text is ${text.length} chars (> ${CONTENT_LIMIT}) - skipping.`); continue; }

    let mediaPath = null;
    if (!textPost && !pollPost && !carouselPost) {
      mediaPath = resolveMediaPath(plan, post);
      if (!mediaPath) { console.log(`[warn] ${post.id}: due but local media not found (${post.path || post.file}) - skipping.`); continue; }
      // Fresh-bytes A/V-sync backstop: probe the actual video bytes about to upload (not
      // the manifest's stale author-time avSyncOk) - a measured desync is a malformed mux.
      // Self-gates on image attachments (a jpg never probes).
      const avBlock = await avSyncBlocker(mediaPath);
      if (avBlock) {
        console.log(`[warn] ${post.id}: ${avBlock} - skipping.`);
        RUN.results.push(avSyncBlockRow(post, 'discord', avBlock));
        continue;
      }
    }

    if (args['dry-run']) {
      if (pollPost) console.log(`[dry] ${post.id}: would post a poll (${pollOptions(post).length} answers).`);
      else if (carouselPost) console.log(`[dry] ${post.id}: would post ${carouselPaths.length} attachments + content.`);
      else console.log(textPost ? `[dry] ${post.id}: would post a message (${text.length} chars).` : `[dry] ${post.id}: would upload ${path.basename(mediaPath)} + content.`);
      continue;
    }

    console.log(`[info] ${post.id}: publishing ${pollPost ? 'poll' : (carouselPost ? 'album' : (textPost ? 'message' : 'media'))} to Discord...`);
    try {
      let result;
      const embeds = dcEmbedsFor(post);
      // Spec 26: forum/thread targeting - thread_id (an EXISTING thread) rides
      // the webhook URL as a query param; thread_name (a NEW forum thread) rides
      // the JSON body / payload_json. Mutually exclusive at the wire level -
      // thread_id wins when both are set (platformValidate already warned).
      // Re-check the 100-char forum thread-name cap here too (advisory only,
      // like Reddit's title cap - truncate rather than skip the whole post).
      const threadId = (post.dcThreadId || '').trim();
      const threadName = !threadId ? (post.dcThreadName || '').trim().slice(0, 100) : '';
      const postUrl = threadId ? `${webhookUrl()}?wait=true&thread_id=${encodeURIComponent(threadId)}` : `${webhookUrl()}?wait=true`;
      if (pollPost) {
        // Discord poll object: duration is in HOURS (1..768 = 32 days), so round the
        // minutes up to the next whole hour and clamp to the ceiling.
        const durationHours = Math.min(768, Math.max(1, Math.ceil(pollDurationMinutes(post) / 60)));
        result = await discord('POST', postUrl, {
          body: {
            content: text,
            poll: {
              // The question is already <=300 chars (pollBlocker blocked it otherwise) -
              // no silent truncation here; an over-length question surfaced an
              // invalid_poll row above.
              question: { text },
              answers: pollOptions(post).map((o) => ({ poll_media: { text: o } })),
              duration: durationHours,
              allow_multiselect: pollMultiple(post),
            },
            ...(threadName ? { thread_name: threadName } : {}),
          },
        });
      } else if (carouselPost) {
        // A native album: files[0..n] + an attachments manifest so all N media render on
        // ONE message (Discord shows a gallery). The caption is the message content.
        const form = new FormData();
        const attachments = carouselPaths.map((p, i) => ({ id: i, filename: path.basename(p) }));
        form.append('payload_json', JSON.stringify({ content: text || '', attachments, ...(embeds ? { embeds } : {}), ...(threadName ? { thread_name: threadName } : {}) }));
        carouselPaths.forEach((p, i) => form.append(`files[${i}]`, new Blob([fs.readFileSync(p)]), path.basename(p)));
        result = await discord('POST', postUrl, { form });
      } else if (textPost) {
        result = await discord('POST', postUrl, { body: { content: text, ...(embeds ? { embeds } : {}), ...(threadName ? { thread_name: threadName } : {}) } });
      } else {
        const form = new FormData();
        form.append('payload_json', JSON.stringify({ content: text || '', ...(embeds ? { embeds } : {}), ...(threadName ? { thread_name: threadName } : {}) }));
        form.append('files[0]', new Blob([fs.readFileSync(mediaPath)]), path.basename(mediaPath));
        result = await discord('POST', postUrl, { form });
      }
      const messageId = result?.id;
      if (!messageId) throw new Error(`post returned no message id: ${JSON.stringify(result).slice(0, 200)}`);

      post.dcMessageId = String(messageId);
      post.status = 'posted';
      post.postedAt = new Date(now).toISOString();
      appendAttempt(post, { ts: new Date().toISOString(), platform: 'discord', action: 'publish', ok: true, errorCode: null, errorMessage: null, actor: ACTOR });
      await savePlan(abs, plan, [post.id]);
      RUN.results.push({ postId: post.id, platform: 'discord', action: 'publish', ok: true, id: String(messageId) });
      console.log(`[ok] ${post.id}: published on Discord (message ${messageId}).`);
      published += 1;
    } catch (err) {
      appendAttempt(post, { ts: new Date().toISOString(), platform: 'discord', action: 'publish', ok: false, errorCode: 'engine_failure', errorMessage: err.message.slice(0, 300), actor: ACTOR });
      await savePlan(abs, plan, [post.id]);
      RUN.results.push({ postId: post.id, platform: 'discord', action: 'publish', ok: false, errorCode: 'engine_failure', errorMessage: err.message.slice(0, 300) });
      console.error(`[err] ${post.id}: Discord publish failed - ${err.message}`);
      continue;
    }
  }
  console.log(`[done] publish-due complete - ${published} message(s) published.`);
}

async function cmdStatus(args) {
  const { plan } = loadPlan(args.plan);
  console.log('[info] Discord plan entries:');
  for (const post of (plan.posts || []).filter(isDiscord)) {
    console.log(`  ${post.id.padEnd(18)} ${String(post.status).padEnd(10)} ${post.scheduledAt}  mode=${post.executionMode}${post.dcMessageId ? ` dc=${post.dcMessageId}` : ''}`);
  }
}

async function cmdVerify(args) {
  const { plan } = loadPlan(args.plan);
  for (const post of (plan.posts || []).filter(isDiscord)) {
    if (args.only && post.id !== args.only) continue;
    if (!post.dcMessageId) continue;
    try {
      await discord('GET', `${webhookUrl()}/messages/${encodeURIComponent(post.dcMessageId)}`);
      RUN.results.push({ postId: post.id, platform: 'discord', action: 'verify', ok: true, live: true, state: 'posted', permalink: await permalinkFor(post), id: post.dcMessageId });
    } catch (err) {
      const missing = /404|not found|unknown message/i.test(err.message || '');
      RUN.results.push({ postId: post.id, platform: 'discord', action: 'verify', ok: true, live: false, state: missing ? 'missing' : 'unknown', permalink: null, id: post.dcMessageId, errorMessage: String(err.message).slice(0, 200) });
    }
  }
}

// Edit-after-publish (spec 12, Pattern P3+P9): push a content edit to an
// already-posted webhook message, WITHOUT re-sending the media bytes (a webhook
// PATCH cannot swap attachments cheaply - documented limitation). Content only
// (the 2000-char cap is re-checked before the call); embeds are left untouched. A
// post with no dcMessageId no-ops with a clear result, so a bare CLI run is safe
// - it never mints/clears an id, never touches status/approval.
export async function cmdEdit(args) {
  const { abs, plan } = loadPlan(args.plan);
  const targets = (plan.posts || []).filter((p) => (!args.only || p.id === args.only) && isDiscord(p));
  if (!targets.length) { console.log('[done] edit complete - no matching posts.'); return; }
  let edited = 0;
  for (const post of targets) {
    if (!post.dcMessageId) {
      RUN.results.push({ postId: post.id, platform: 'discord', action: 'edit', ok: true, skipped: 'no_minted_id' });
      console.log(`[skip] ${post.id}: no dcMessageId - nothing published to edit yet.`);
      continue;
    }
    // Spec 12 review (finding #5): a Discord poll's question/answers are
    // immutable once posted (no edit-poll API - only ending it early).
    // Structured-skip, mirroring the no-minted-id skip above, so PostDetail's
    // editableLanes exclusion (type==='poll') and this engine never disagree.
    if (isPollPost(post)) {
      RUN.results.push({ postId: post.id, platform: 'discord', action: 'edit', ok: true, skipped: 'not_editable' });
      console.log(`[skip] ${post.id}: a poll's question/answers cannot be edited.`);
      continue;
    }
    const text = messageText(post);
    if (text.length > CONTENT_LIMIT) {
      RUN.results.push({ postId: post.id, platform: 'discord', action: 'edit', ok: false, errorCode: 'invalid_input', errorMessage: `text is ${text.length} chars (> ${CONTENT_LIMIT})` });
      console.log(`[warn] ${post.id}: text is ${text.length} chars (> ${CONTENT_LIMIT}) - not editing.`);
      continue;
    }
    try {
      await discord('PATCH', `${webhookUrl()}/messages/${encodeURIComponent(post.dcMessageId)}`, { body: { content: text } });
      appendAttempt(post, { ts: new Date().toISOString(), platform: 'discord', action: 'edit', ok: true, errorCode: null, errorMessage: null, actor: ACTOR });
      await savePlan(abs, plan, [post.id]);
      RUN.results.push({ postId: post.id, platform: 'discord', action: 'edit', ok: true, id: post.dcMessageId });
      console.log(`[ok] ${post.id}: message ${post.dcMessageId} content updated.`);
      edited += 1;
    } catch (err) {
      appendAttempt(post, { ts: new Date().toISOString(), platform: 'discord', action: 'edit', ok: false, errorCode: 'engine_failure', errorMessage: err.message.slice(0, 300), actor: ACTOR });
      await savePlan(abs, plan, [post.id]);
      RUN.results.push({ postId: post.id, platform: 'discord', action: 'edit', ok: false, errorCode: 'engine_failure', errorMessage: err.message.slice(0, 300) });
      console.error(`[err] ${post.id}: edit failed - ${err.message}`);
    }
  }
  console.log(`[done] edit complete - ${edited} message(s) updated.`);
}

// Guild scheduled events (spec 26, Pattern P3+P9): an ON-DEMAND verb, dispatched
// directly by lib/writes.mjs discordScheduleEvent - never by the scheduler tick
// (a webhook carries no bot token/MANAGE_EVENTS, so events cannot ride
// publish-due). Requires DISCORD_BOT_TOKEN in env; absent it degrades to a
// structured needs_scope result row (never throws). IDEMPOTENT: a post that
// already carries dcEventId GETs the existing event (best-effort) and no-ops
// rather than minting a second one.
export async function cmdScheduleEvent(args) {
  const { abs, plan } = loadPlan(args.plan);
  const targets = (plan.posts || []).filter((p) => (!args.only || p.id === args.only) && isDiscord(p) && p.dcEvent);
  if (!targets.length) { console.log('[done] schedule-event complete - no matching posts with a dcEvent intent.'); return; }
  const botToken = readEnv('DISCORD_BOT_TOKEN');
  for (const post of targets) {
    if (!botToken) {
      RUN.results.push({ postId: post.id, platform: 'discord', action: 'schedule-event', ok: false, error: 'needs_scope', scope: 'discord_bot_token+MANAGE_EVENTS' });
      console.log(`[warn] ${post.id}: DISCORD_BOT_TOKEN not set - cannot create a guild scheduled event.`);
      continue;
    }
    if (post.dcEventId) {
      // Idempotent: GET the existing event (best-effort) and no-op rather than
      // minting a second one for a repeat call.
      try {
        const meta = await webhookMeta();
        if (meta.guild_id) await discord('GET', `https://discord.com/api/v10/guilds/${meta.guild_id}/scheduled-events/${encodeURIComponent(post.dcEventId)}`, { botAuth: botToken });
      } catch { /* best-effort re-check - the id is already persisted either way */ }
      RUN.results.push({ postId: post.id, platform: 'discord', action: 'schedule-event', ok: true, id: post.dcEventId, unchanged: true });
      console.log(`[skip] ${post.id}: a guild event (${post.dcEventId}) already exists - no-op.`);
      continue;
    }
    const e = post.dcEvent || {};
    // Belt-and-suspenders (spec 26 review, MAJOR-1/MAJOR-2): lib/writes.mjs
    // rejects an incomplete/unparseable dcEvent at SAVE time, but a plan can
    // also be hand-edited or migrated in from before that gate existed - so
    // re-validate + re-normalize here too, BEFORE any Discord call, and fail
    // with a structured invalid_input row rather than a raw HTTP 400 /
    // engine_failure. scheduled_start_time/scheduled_end_time are normalized to
    // full ISO-8601 via Date - idempotent for an already-full-ISO value,
    // correct for a Composer-authored zone-less datetime-local value (which
    // sent VERBATIM would create the live event 1-2h off, or a 400).
    const toIso = (v) => { if (!v) return null; const ms = Date.parse(v); return Number.isNaN(ms) ? null : new Date(ms).toISOString(); };
    if (!e.name || !String(e.name).trim()) {
      RUN.results.push({ postId: post.id, platform: 'discord', action: 'schedule-event', ok: false, errorCode: 'invalid_input', errorMessage: 'dcEvent.name is required' });
      console.log(`[warn] ${post.id}: dcEvent.name is required - not scheduling.`);
      continue;
    }
    const startIso = toIso(e.startTime);
    if (!startIso) {
      RUN.results.push({ postId: post.id, platform: 'discord', action: 'schedule-event', ok: false, errorCode: 'invalid_input', errorMessage: 'dcEvent.startTime does not parse to a valid datetime' });
      console.log(`[warn] ${post.id}: dcEvent.startTime does not parse - not scheduling.`);
      continue;
    }
    // entity_type: 3=EXTERNAL (needs entity_metadata.location + scheduled_end_time),
    // 2=VOICE / 1=STAGE_INSTANCE (need channel_id). Default EXTERNAL - the Composer's
    // event group only authors name/start/end/location (no channel picker), so an
    // unspecified entityType always means an off-platform/external event.
    const entityType = e.entityType === 'voice' ? 2 : e.entityType === 'stage' ? 1 : 3;
    const body = {
      name: e.name,
      privacy_level: 2, // GUILD_ONLY - the only privacy level Discord's API accepts today.
      scheduled_start_time: startIso,
      entity_type: entityType,
    };
    if (entityType === 3) {
      const endIso = toIso(e.endTime);
      const location = String(e.location || '').trim();
      if (!endIso) {
        RUN.results.push({ postId: post.id, platform: 'discord', action: 'schedule-event', ok: false, errorCode: 'invalid_input', errorMessage: 'an external event requires a valid endTime' });
        console.log(`[warn] ${post.id}: an external event requires a valid endTime - not scheduling.`);
        continue;
      }
      if (!location || location.length > 100) {
        RUN.results.push({ postId: post.id, platform: 'discord', action: 'schedule-event', ok: false, errorCode: 'invalid_input', errorMessage: 'an external event requires a non-empty location (1-100 chars)' });
        console.log(`[warn] ${post.id}: an external event requires a non-empty location (1-100 chars) - not scheduling.`);
        continue;
      }
      body.scheduled_end_time = endIso;
      body.entity_metadata = { location };
    } else {
      const channelId = String(e.channelId || '').trim();
      if (!channelId) {
        RUN.results.push({ postId: post.id, platform: 'discord', action: 'schedule-event', ok: false, errorCode: 'invalid_input', errorMessage: 'a voice/stage event requires channelId' });
        console.log(`[warn] ${post.id}: a voice/stage event requires channelId - not scheduling.`);
        continue;
      }
      body.channel_id = channelId;
    }
    if (e.description) body.description = e.description;
    let created;
    try {
      const meta = await webhookMeta();
      if (!meta.guild_id) throw new Error('the webhook has no guild_id (a DM/group webhook cannot host a guild event)');
      created = await discord('POST', `https://discord.com/api/v10/guilds/${meta.guild_id}/scheduled-events`, { body, botAuth: botToken });
      if (!created?.id) throw new Error(`event create returned no id: ${JSON.stringify(created).slice(0, 200)}`);
    } catch (err) {
      RUN.results.push({ postId: post.id, platform: 'discord', action: 'schedule-event', ok: false, errorCode: 'engine_failure', errorMessage: String(err.message || err).slice(0, 300) });
      console.error(`[err] ${post.id}: schedule-event failed - ${err.message}`);
      continue;
    }
    // MINOR-7 (spec 26 review): the event is now REAL and LIVE on Discord - a
    // savePlan failure past this point must NEVER surface as ok:false (a caller
    // that sees ok:false would retry, minting a SECOND real guild event). Retry
    // the save once; if it still fails, return ok:true with a warning so the
    // operator/agent knows to reconcile manually instead of blindly retrying.
    // The eventId rides the result row either way, so it is never lost.
    const eventId = String(created.id);
    post.dcEventId = eventId;
    try {
      await savePlan(abs, plan, [post.id]);
    } catch (saveErr) {
      try {
        await savePlan(abs, plan, [post.id]);
      } catch (saveErr2) {
        RUN.results.push({ postId: post.id, platform: 'discord', action: 'schedule-event', ok: true, id: eventId, warning: 'event_created_id_not_persisted' });
        console.error(`[warn] ${post.id}: guild event ${eventId} created but the plan save failed twice (${saveErr2.message}) - id NOT persisted, do not retry (would duplicate).`);
        continue;
      }
    }
    RUN.results.push({ postId: post.id, platform: 'discord', action: 'schedule-event', ok: true, id: eventId });
    console.log(`[ok] ${post.id}: guild scheduled event created (${eventId}).`);
  }
  console.log('[done] schedule-event complete.');
}

// A Discord webhook exposes no engagement metrics - honest no-op.
async function cmdInsights(args) {
  const { plan } = loadPlan(args.plan);
  void plan;
  console.log('[info] Discord webhooks expose no per-post metrics - insights is a no-op.');
}

async function cmdDelete(args) {
  if (!args.id) { console.error('[err] delete requires --id <messageId>'); process.exit(2); }
  await discord('DELETE', `${webhookUrl()}/messages/${encodeURIComponent(args.id)}`);
  RUN.results.push({ platform: 'discord', action: 'delete', ok: true, id: String(args.id) });
  console.log(`[ok] deleted Discord message ${args.id}.`);
}

// Guild scheduled event takedown (the "delete always works" cascade): dispatched
// by lib/writes.mjs deletePost when the plan row being removed carries a
// dcEventId - the row is the only cancel path pendpost holds for the event, so
// it is cancelled BEFORE the row goes. Needs the same DISCORD_BOT_TOKEN +
// MANAGE_EVENTS the schedule-event create verb needs. A 404 counts as success:
// Discord auto-removes completed events, and an already-gone event is exactly
// the state this verb wants to reach.
async function cmdDeleteEvent(args) {
  if (!args.id) { console.error('[err] delete-event requires --id <eventId>'); process.exit(2); }
  const botToken = readEnv('DISCORD_BOT_TOKEN');
  if (!botToken) throw new Error('DISCORD_BOT_TOKEN not set - cannot delete the guild scheduled event');
  const meta = await webhookMeta();
  if (!meta.guild_id) throw new Error('the webhook has no guild_id (a DM/group webhook cannot host a guild event)');
  try {
    await discord('DELETE', `https://discord.com/api/v10/guilds/${meta.guild_id}/scheduled-events/${encodeURIComponent(args.id)}`, { botAuth: botToken });
    console.log(`[ok] deleted guild scheduled event ${args.id}.`);
  } catch (err) {
    if (!/HTTP 404/.test(String(err.message || ''))) throw err;
    console.log(`[skip] guild event ${args.id} is already gone (404) - counting it cancelled.`);
  }
  RUN.results.push({ platform: 'discord', action: 'delete-event', ok: true, id: String(args.id) });
}

async function cmdProbe() {
  if (!webhookUrl()) {
    RUN.results.push({ platform: 'discord', action: 'probe', ok: false, detail: 'not configured (DISCORD_WEBHOOK_URL missing)' });
    return;
  }
  try {
    const meta = await webhookMeta();
    RUN.results.push({ platform: 'discord', action: 'probe', ok: true, detail: `connected to "${meta.name}"`, tokenExpiresAt: null });
  } catch (err) {
    RUN.results.push({ platform: 'discord', action: 'probe', ok: false, detail: String(err.message || err).slice(0, 200) });
  }
}

// Connected-account discovery (spec 22, Pattern P3): who is connected + which
// channels can it manage? The connect flow seals a WEBHOOK url (its object carries
// the bot name + target channel/guild), so the webhook is the honest identity + a
// single manageable channel. If a bot token IS also sealed, enumerate the guilds +
// text channels it can reach (the spec's richer /users/@me/guilds path). Reads env
// via readEnv so a missing credential degrades to an ok:false row, never a crash.
async function cmdDiscover() {
  const { discoverOk, discoverNeedsScope, discoverAuthError } = await import('../lib/discovery.mjs');
  const botToken = readEnv('DISCORD_BOT_TOKEN');
  if (botToken) {
    try {
      const me = await discord('GET', 'https://discord.com/api/v10/users/@me', { botAuth: botToken });
      const guilds = await discord('GET', 'https://discord.com/api/v10/users/@me/guilds', { botAuth: botToken });
      const assets = (Array.isArray(guilds) ? guilds : []).map((g) => ({
        kind: 'guild', id: String(g.id), name: g.name || String(g.id), current: false,
      }));
      RUN.results.push(discoverOk('discord', {
        identity: { id: String(me.id || ''), handle: me.username || null, name: me.username ? `${me.username}${me.discriminator && me.discriminator !== '0' ? `#${me.discriminator}` : ''}` : 'Discord bot', avatarUrl: me.avatar ? `https://cdn.discordapp.com/avatars/${me.id}/${me.avatar}.png` : undefined },
        assets,
        selected: {},
      }));
      return;
    } catch (err) {
      RUN.results.push(discoverAuthError('discord', err.message || err));
      return;
    }
  }
  if (!webhookUrl()) {
    RUN.results.push(discoverNeedsScope('discord'));
    return;
  }
  try {
    const meta = await webhookMeta();
    const channelId = String(meta.channel_id || '');
    RUN.results.push(discoverOk('discord', {
      identity: { id: String(meta.id || channelId), handle: meta.name || null, name: meta.name || 'Discord webhook' },
      assets: channelId ? [{ kind: 'channel', id: channelId, name: meta.name ? `#${meta.name}` : channelId, current: true, meta: meta.guild_id ? { guildId: String(meta.guild_id) } : undefined }] : [],
      selected: {},
    }));
  } catch (err) {
    RUN.results.push(discoverAuthError('discord', err.message || err));
  }
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
  Object.assign(RUN, await runLaneComments('discord', args));
}
async function cmdReply(args) {
  const { runLaneReply } = await import('../lib/comments.mjs');
  Object.assign(RUN, await runLaneReply('discord', args));
}
async function cmdModerate(args) {
  const { runLaneModerate } = await import('../lib/comments.mjs');
  Object.assign(RUN, await runLaneModerate('discord', args));
}
async function cmdReact(args) {
  const { runLaneReact } = await import('../lib/comments.mjs');
  Object.assign(RUN, await runLaneReact('discord', args));
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
  'schedule-event': cmdScheduleEvent,
  insights: cmdInsights,
  delete: cmdDelete,
  'delete-event': cmdDeleteEvent,
  probe: cmdProbe,
  discover: cmdDiscover,
};

async function main() {
  const args = parseArgs(process.argv);
  await enforceCeremonyClient({ argv: args, command: args._[0], lane: 'discord', scriptUrl: import.meta.url });
  JSON_MODE = Boolean(args.json);
  ACTOR = typeof args.actor === 'string' ? args.actor : 'cli';
  if (JSON_MODE) console.log = (...a) => console.error(...a);
  const commandName = args._[0];
  if (resolveMode('discord') === 'mock' && isMockableCommand(commandName)) {
    const envelope = await runMockCommand({
      platform: 'discord', command: commandName,
      planPath: typeof args.plan === 'string' ? path.resolve(String(args.plan)) : null,
      only: typeof args.only === 'string' ? args.only : null,
      // spec 06: the moderate verb carries its action so the mock can branch per-lane.
      action: typeof args.action === 'string' ? args.action : null,
      // spec 24: the react verb carries its reaction/emoji/remove so the mock can branch per-lane.
      reaction: typeof args.reaction === 'string' ? args.reaction : null,
      emoji: typeof args.emoji === 'string' ? args.emoji : null,
      remove: args.remove === true,
      // spec 26: the schedule-event verb degrades to needs_scope with no bot
      // token configured, mirroring the live DISCORD_BOT_TOKEN gate.
      botTokenConfigured: Boolean(readEnv('DISCORD_BOT_TOKEN')),
    });
    if (JSON_MODE) process.stdout.write(`${JSON.stringify(envelope)}\n`);
    else console.error(`[mock] discord ${commandName}: ${envelope.results.length} result(s)`);
    return;
  }
  const cmd = COMMANDS[commandName];
  if (!cmd) {
    console.error(`Usage: node scripts/discord-social.mjs <${Object.keys(COMMANDS).join('|')}> [options]`);
    process.exit(2);
  }
  if (['validate', 'publish-due', 'status', 'verify', 'edit', 'schedule-event', 'insights'].includes(commandName) && !args.plan) {
    console.error(`[err] ${commandName} requires --plan <post-plan.json>`);
    process.exit(2);
  }
  await cmd(args);
  if (JSON_MODE) process.stdout.write(`${JSON.stringify({ ok: true, ...RUN })}\n`);
}

// Run only when executed directly (node scripts/discord-social.mjs ...), not when
// imported for a unit test of an exported command (cmdEdit) - mirrors the guard
// telegram-social.mjs/nostr-social.mjs use. The daemon invokes this as a
// subprocess, so argv[1] is this script and main() still runs in production.
// Spec 12 review: this was UNCONDITIONAL before - importing the module for a
// direct cmdEdit test ran main() against the TEST RUNNER's own argv, printed the
// usage line and called process.exit(2), killing the test process itself.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(async (err) => {
    console.error('[err]', err.message || err);
    if (JSON_MODE) process.stdout.write(`${JSON.stringify({ ok: false, error: String(err.message || err).slice(0, 300), ...RUN })}\n`);
    process.exit(1);
  });
}
