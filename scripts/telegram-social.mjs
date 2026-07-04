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
 * Commands:
 *   auth | connect   validate the static creds (getMe + getChat); writes nothing
 *   refresh          no-op (bot tokens are static) - kept for sibling parity
 *   validate         --plan <p> [--only <id>]   side-effect-free preview, never posts
 *   publish-due      --plan <p> [--only <id>] [--dry-run]   publish any due Telegram entry
 *   status           --plan <p>                 list Telegram plan entries
 *   verify           --plan <p> [--only <id>]   read-only liveness (best-effort)
 *   insights         --plan <p> [--only <id>]   no-op (Bot API exposes no per-post metrics)
 *   probe                                        read-only health probe (getMe)
 *   delete           --id <messageId>            delete a channel message (cleanup)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveMode, isMockableCommand } from '../lib/mode.mjs';
import { runMockCommand } from '../lib/drivers/mock-driver.mjs';
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

const ENGINE_OWNED_FIELDS = ['fbPostId', 'fbReelId', 'igMediaId', 'liPostId', 'ytVideoId', 'xPostId', 'tgMessageId', 'dcMessageId', 'status', 'postedAt', 'attempts'];

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
  post.attempts = Array.isArray(post.attempts) ? post.attempts : [];
  post.attempts.push(entry);
}

const RUN = { results: [] };
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
    if ((post.approval || 'draft') !== 'approved') {
      console.log(`[skip] ${post.id}: approval is "${post.approval || 'draft'}" - only approved posts publish.`);
      continue;
    }
    const dueMs = Date.parse(post.scheduledAt);
    if (Number.isNaN(dueMs) || dueMs > now) continue;

    const text = messageText(post);
    const textPost = isTextPost(post);
    if (textPost && !text) { console.log(`[warn] ${post.id}: due but no text (tgCaption/caption) - skipping.`); continue; }
    const limit = textPost ? TEXT_LIMIT : CAPTION_LIMIT;
    if (text.length > limit) { console.log(`[warn] ${post.id}: text is ${text.length} chars (> ${limit}) - skipping.`); continue; }

    let mediaPath = null;
    if (!textPost) {
      mediaPath = resolveMediaPath(plan, post);
      if (!mediaPath) { console.log(`[warn] ${post.id}: due but local media not found (${post.path || post.file}) - skipping.`); continue; }
    }

    if (args['dry-run']) {
      console.log(textPost ? `[dry] ${post.id}: would send a text message (${text.length} chars).` : `[dry] ${post.id}: would upload ${path.basename(mediaPath)} + caption.`);
      continue;
    }

    console.log(`[info] ${post.id}: publishing ${textPost ? 'text message' : 'media'} to Telegram...`);
    try {
      let result;
      if (textPost) {
        result = await tg('sendMessage', { body: { chat_id: ch, text } });
      } else {
        const { field, method } = mediaField(mediaPath);
        const form = new FormData();
        form.append('chat_id', String(ch));
        if (text) form.append('caption', text);
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

// Telegram's Bot API exposes no per-post metrics to a bot - honest no-op.
async function cmdInsights(args) {
  const { plan } = loadPlan(args.plan);
  void plan;
  console.log('[info] Telegram Bot API exposes no per-post metrics - insights is a no-op.');
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

const COMMANDS = {
  auth: cmdAuth,
  connect: cmdAuth,
  refresh: cmdRefresh,
  validate: cmdValidate,
  'publish-due': cmdPublishDue,
  status: cmdStatus,
  verify: cmdVerify,
  insights: cmdInsights,
  delete: cmdDelete,
  probe: cmdProbe,
};

async function main() {
  const args = parseArgs(process.argv);
  JSON_MODE = Boolean(args.json);
  ACTOR = typeof args.actor === 'string' ? args.actor : 'cli';
  if (JSON_MODE) console.log = (...a) => console.error(...a);
  const commandName = args._[0];
  if (resolveMode('telegram') === 'mock' && isMockableCommand(commandName)) {
    const envelope = await runMockCommand({
      platform: 'telegram', command: commandName,
      planPath: typeof args.plan === 'string' ? path.resolve(String(args.plan)) : null,
      only: typeof args.only === 'string' ? args.only : null,
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
  if (['validate', 'publish-due', 'status', 'verify', 'insights'].includes(commandName) && !args.plan) {
    console.error(`[err] ${commandName} requires --plan <post-plan.json>`);
    process.exit(2);
  }
  await cmd(args);
  if (JSON_MODE) process.stdout.write(`${JSON.stringify({ ok: true, ...RUN })}\n`);
}

main().catch(async (err) => {
  console.error('[err]', err.message || err);
  if (JSON_MODE) process.stdout.write(`${JSON.stringify({ ok: false, error: String(err.message || err).slice(0, 300), ...RUN })}\n`);
  process.exit(1);
});
