// lib/telegram-owner.mjs - the OWNER push channel over Telegram (spec 50 §7.7, S7, row 9).
//
// Two Telegram destinations exist in this product and they must never be confused:
//   * the CHANNEL (TELEGRAM_CHANNEL_ID) - the brand's audience, where posts are published;
//   * the OWNER CHAT (posting.notify.telegramChatId) - the operator's own private chat with
//     the same bot, where "Respond for me" says "this one needs you".
// Sending an internal ask into the audience channel would be a data leak with a permalink,
// so this module reads the owner chat id and NOTHING else: there is no fallback to the
// channel, and an unset chat id is a clean refusal rather than a best guess.
//
// The bot TOKEN is the Telegram lane's own credential - the same `TELEGRAM_BOT_TOKEN` that
// lib/comments.mjs replies with. Reused deliberately: the owner already granted it, already
// trusts it, and a second bot would mean a second BotFather ceremony for zero gain. A missing
// token means the lane was never connected, which is a DIFFERENT fact from "the owner never ran
// the owner-chat ceremony" - hence two distinct codes, so the digest and the health card can
// each say the true sentence instead of one blurred "Telegram is not working".
//
// NEVER THROWS. A push is a courtesy on top of the Studio strip and the daily digest, and the
// caller is a scheduler tick: a Telegram outage must cost the tick nothing. Every failure comes
// back as { ok:false, code } and the caller decides whether it is worth recording.
import { readEnv } from './util.mjs';
import { getPosting } from './config.mjs';

// The Bot API's own hard cap on a text message. Longer text is REFUSED by Telegram outright,
// so trim here rather than discover it as an HTTP 400 the owner never sees.
const TELEGRAM_TEXT_LIMIT = 4096;

// How long a push may hold the scheduler tick. The tick has a whole sweep list after us.
const SEND_TIMEOUT_MS = 10000;

/**
 * The owner's own chat id with the brand's Telegram bot, or '' when the ceremony
 * (`node scripts/telegram-social.mjs owner-chat --client <id>`) has not been run.
 * Guarded: a config read that throws must not take a notification path down with it.
 *
 * @returns {string}
 */
export function ownerChatId() {
  try {
    return String(((getPosting() || {}).notify || {}).telegramChatId || '').trim();
  } catch {
    return '';
  }
}

/**
 * The Telegram lane's bot token, or '' when the lane was never connected.
 * @returns {string}
 */
export function ownerBotToken() {
  try {
    return String(readEnv('TELEGRAM_BOT_TOKEN') || '').trim();
  } catch {
    return '';
  }
}

/**
 * Send one plain-text message to the OWNER's chat (never the audience channel).
 *
 * @param {string} text - plain text, already humanized by the caller. Trimmed at 4096.
 * @param {object} [opts]
 * @param {string|null} [opts.clientId] - which brand this push is about; carried for the
 *   caller's own log line. The chat id and token are read from whatever client scope the
 *   caller is bound to (the scheduler binds one per tick), so this never re-roots behind
 *   the caller's back.
 * @param {Function|null} [opts.fetchImpl] - injected for tests; defaults to global fetch.
 * @returns {Promise<{ok:true, messageId:(number|null), chatId:string}
 *   |{ok:false, code:'no_chat_id'|'no_token'|'empty_text'|'send_failed', message:string}>}
 */
export async function sendOwnerMessage(text, { clientId = null, fetchImpl = null } = {}) {
  const body = String(text == null ? '' : text).trim().slice(0, TELEGRAM_TEXT_LIMIT);
  if (!body) return { ok: false, code: 'empty_text', message: 'nothing to send' };

  const chatId = ownerChatId();
  // Order matters for the owner-facing sentence: "no chat id" is a ceremony they can run in
  // ten seconds, "no token" is a whole lane they have not connected. Report the nearer one.
  if (!chatId) {
    return {
      ok: false,
      code: 'no_chat_id',
      message: 'no owner chat id stored - run: node scripts/telegram-social.mjs owner-chat --client <id>',
    };
  }
  const token = ownerBotToken();
  if (!token) {
    return {
      ok: false,
      code: 'no_token',
      message: 'the Telegram lane is not connected (TELEGRAM_BOT_TOKEN missing)',
    };
  }

  const doFetch = typeof fetchImpl === 'function' ? fetchImpl : (typeof fetch === 'function' ? fetch : null);
  if (!doFetch) return { ok: false, code: 'send_failed', message: 'no fetch available in this runtime' };

  // AbortController, not a bare await: a hung socket would otherwise hold the 60-second tick
  // open past its own next run - the same durability trap lib/comments.mjs already paid for.
  const ac = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ac ? setTimeout(() => ac.abort(), SEND_TIMEOUT_MS) : null;
  if (timer && typeof timer.unref === 'function') timer.unref();
  try {
    const res = await doFetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // disable_web_page_preview: the Studio link at the end of every push would otherwise
      // render a fat loopback preview card that says nothing and buries the sentence.
      body: JSON.stringify({ chat_id: chatId, text: body, disable_web_page_preview: true }),
      ...(ac ? { signal: ac.signal } : {}),
    });
    const raw = res && typeof res.text === 'function' ? await res.text() : '';
    let data = {};
    try { data = raw ? JSON.parse(raw) : {}; } catch { data = {}; }
    if (!res || res.ok === false || data.ok === false) {
      const detail = String(data.description || `HTTP ${res && res.status}`).slice(0, 200);
      return { ok: false, code: 'send_failed', message: detail };
    }
    void clientId;
    return { ok: true, messageId: (data.result && data.result.message_id) || null, chatId };
  } catch (err) {
    return { ok: false, code: 'send_failed', message: String((err && err.message) || err).slice(0, 200) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
