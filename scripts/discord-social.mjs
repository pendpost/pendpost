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
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveMode, isMockableCommand } from '../lib/mode.mjs';
import { runMockCommand } from '../lib/drivers/mock-driver.mjs';
import { envPath } from '../lib/util.mjs';

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

const webhookUrl = () => (readEnv('DISCORD_WEBHOOK_URL') || '').trim();

// ---------- Discord helper ----------

async function discord(method, url, { body, form } = {}) {
  const init = form ? { method, body: form } : { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined };
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

const isDiscord = (post) => (post.platforms || []).includes('discord');
const isTextPost = (post) => post.type === 'text';
const messageText = (post) => (post.dcCaption || post.caption || '').trim();

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
  if (!webhookUrl()) { console.error('[err] DISCORD_WEBHOOK_URL missing in .env (create an Incoming Webhook in the channel settings).'); process.exit(2); }
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
  const postUrl = `${webhookUrl()}?wait=true`;
  const now = Date.now();
  let published = 0;

  for (const post of plan.posts || []) {
    if (args.only && post.id !== args.only) continue;
    if (!isDiscord(post)) continue;
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
    if (textPost && !text) { console.log(`[warn] ${post.id}: due but no text (dcCaption/caption) - skipping.`); continue; }
    if (text.length > CONTENT_LIMIT) { console.log(`[warn] ${post.id}: text is ${text.length} chars (> ${CONTENT_LIMIT}) - skipping.`); continue; }

    let mediaPath = null;
    if (!textPost) {
      mediaPath = resolveMediaPath(plan, post);
      if (!mediaPath) { console.log(`[warn] ${post.id}: due but local media not found (${post.path || post.file}) - skipping.`); continue; }
    }

    if (args['dry-run']) {
      console.log(textPost ? `[dry] ${post.id}: would post a message (${text.length} chars).` : `[dry] ${post.id}: would upload ${path.basename(mediaPath)} + content.`);
      continue;
    }

    console.log(`[info] ${post.id}: publishing ${textPost ? 'message' : 'media'} to Discord...`);
    try {
      let result;
      if (textPost) {
        result = await discord('POST', postUrl, { body: { content: text } });
      } else {
        const form = new FormData();
        form.append('payload_json', JSON.stringify({ content: text || '' }));
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
  if (resolveMode('discord') === 'mock' && isMockableCommand(commandName)) {
    const envelope = await runMockCommand({
      platform: 'discord', command: commandName,
      planPath: typeof args.plan === 'string' ? path.resolve(String(args.plan)) : null,
      only: typeof args.only === 'string' ? args.only : null,
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
