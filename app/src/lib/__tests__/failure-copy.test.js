import { describe, it, expect } from 'vitest';
import { makeT } from '../i18n.js';
import { failureKey, failureStatus, humanizeFailure, humanizeCheck, humanizeConnect, humanizeAction, plainError } from '../failureCopy.js';

// failureCopy turns a raw platform failure ("x: X POST /tweets: HTTP 403 - ...") into one
// plain sentence that says what happened and why. The raw string must never be the text,
// only the tooltip (`raw`). Mapped by errorCode first, then lane + HTTP status / pattern.
const de = makeT('de-CH');
const en = makeT('en');

const X_REPLY = 'x: X POST /tweets: HTTP 403 - You can only reply to or quote posts where you are mentioned or are the author.';
const LI_500 = 'linkedin: POST /rest/posts: HTTP 500 - LinkedIn returned an internal error, try again later.';
const TG_404 = 'telegram: sendMessage: HTTP 400 - Bad Request: chat not found';

describe('failureCopy', () => {
  it('reads the HTTP status in its common shapes', () => {
    expect(failureStatus(LI_500)).toBe(500);
    expect(failureStatus('status: 429 slow down')).toBe(429);
    expect(failureStatus('401 Unauthorized')).toBe(401);
    expect(failureStatus('media not found (clip.mp4)')).toBe(null);
  });

  it('an unconfirmed Facebook publish asks the owner to look at the Page, never "a later try usually works"', () => {
    // scripts/meta-social.mjs: the publishing call failed ambiguously (5xx) and the Page
    // check failed too, so nobody knows whether the post is live (issue #7).
    const f = { lane: 'meta', code: 'publish_unconfirmed', message: 'Facebook did not confirm whether the post went live, and pendpost could not check the Page. (check: Graph GET /111/feed: HTTP 500 OAuthException 2)' };
    expect(failureKey(f)).toBe('failure.unconfirmed');
    expect(humanizeFailure(f, en).text).toMatch(/Look at the Page/);
    expect(humanizeFailure(f, en).text).not.toMatch(/later try usually works/);
    expect(humanizeFailure(f, de).text).toMatch(/Schau auf der Seite nach/);
  });

  it('a publish waiting for the Page check says so, never that the platform refused it', () => {
    const f = { lane: 'facebook', code: 'publish_pending_check', message: 'Facebook has not confirmed this publish yet. (FB feed post (2 photos): Graph POST /111/feed: HTTP 500)' };
    expect(failureKey(f)).toBe('failure.pendingCheck');
    expect(humanizeFailure(f, en).text).toMatch(/checks the Page/);
    expect(humanizeFailure(f, de).text).toMatch(/prüft die Seite/);
  });

  it('a long fail-closed cloud hold never reads as the platform refusing the post', () => {
    // lib/plans.mjs reports a hold past 2 h as code cloud_unanswered; nothing was refused.
    const f = { lane: 'meta', code: 'cloud_unanswered', message: 'the cloud already has this post and has not answered the publish claim for over 2 hours' };
    expect(failureKey(f)).toBe('failure.cloudUnanswered');
    expect(humanizeFailure(f, en).text).toMatch(/already has this post/);
    expect(humanizeFailure(f, en).text).not.toMatch(/did not accept/);
    expect(humanizeFailure(f, de).text).toMatch(/hat diesen Beitrag schon/);
  });

  it('X reply restriction: names the rule, not the status code, and says a retry cannot help', () => {
    const r = humanizeFailure({ message: X_REPLY, lane: 'x' }, de);
    expect(r.text).toBe('X erlaubt Antworten an Fremde nur mit dem teuren Enterprise-Zugang. Ein neuer Versuch ändert daran nichts.');
    expect(r.text).not.toMatch(/HTTP|POST|403/);
    expect(r.raw).toBe(X_REPLY);
    expect(r.known).toBe(true);
  });

  it('X reply restriction beats the needs_scope code the engine records for that 403 (a reconnect never fixes it)', () => {
    expect(failureKey({ code: 'needs_scope', message: X_REPLY })).toBe('failure.xReply');
    expect(failureKey({ message: 'x: POST /2/tweets: HTTP 403 - Reply to this conversation is not allowed because you have not been mentioned' })).toBe('failure.xReply');
  });

  it('a generic 403 names the platform and the likely cause (permission / plan)', () => {
    const r = humanizeFailure({ message: 'x: X POST /tweets: HTTP 403 - Forbidden', lane: 'x' }, de);
    expect(r.text).toMatch(/^X hat den Beitrag abgelehnt: Dem Konto fehlt die Berechtigung/);
  });

  it('5xx = the platform had an internal error; the lane comes from the message prefix when none is given', () => {
    expect(humanizeFailure({ message: LI_500 }, de).text).toBe('LinkedIn hatte einen internen Fehler. An deinem Beitrag liegt es nicht, ein späterer Versuch klappt meist.');
    expect(humanizeFailure({ message: LI_500 }, en).text).toBe('LinkedIn had an internal error. Your post is fine, and a later try usually works.');
  });

  it('401 / expired token = the connection expired, reconnect', () => {
    expect(failureKey({ message: 'HTTP 401 - Unauthorized' })).toBe('failure.expired');
    expect(failureKey({ message: 'OAuthException: Error validating access token: Session has expired' })).toBe('failure.expired');
    expect(humanizeFailure({ message: 'HTTP 401', lane: 'linkedin' }, de).text).toMatch(/^LinkedIn akzeptiert das gespeicherte Login nicht mehr.*Neu verbinden behebt das\.$/);
  });

  it('a local credential the engine never had, or could not refresh, names the fix', () => {
    // The engine records these as engine_failure (the scheduler's zero-row branch carries the
    // requireEnv / mintToken message), so the words come from the text, not the code.
    expect(failureKey({ code: 'engine_failure', message: 'Reddit credentials missing in .env: REDDIT_CLIENT_ID' })).toBe('failure.notConfigured');
    expect(failureKey({ code: 'engine_failure', message: "[err] X_CLIENT_ID missing in .env - run 'node scripts/x-social.mjs auth' first." })).toBe('failure.notConfigured');
    expect(failureKey({ code: 'engine_failure', message: 'X token refresh failed (OAuth refresh_token: HTTP 400 invalid_request). The refresh token likely expired or was rotated out' })).toBe('failure.expired');
  });

  it('"chat not found" beats the plain 400 (the owner can fix the destination)', () => {
    expect(failureKey({ message: TG_404 })).toBe('failure.notFound');
    expect(humanizeFailure({ message: TG_404, lane: 'telegram' }, de).text).toMatch(/^Telegram findet das Ziel nicht/);
  });

  it('Instagram ProcessingFailedError is a temporary processing hiccup, not a rejected post; a plain 400 still is', () => {
    const PFE = 'HTTP 400 {"debug_info":{"retriable":false,"type":"ProcessingFailedError","message":"Request processing failed"}}';
    expect(failureKey({ message: PFE })).toBe('failure.processing');
    expect(humanizeFailure({ message: PFE, lane: 'instagram' }, de).text).toBe('Instagram konnte das Video gerade nicht verarbeiten. Das ist meist vorübergehend, pendpost versucht es erneut.');
    expect(humanizeFailure({ message: PFE, lane: 'instagram' }, en).text).toBe("Instagram couldn't process the video just now. This is usually temporary; pendpost retries.");
    expect(failureKey({ message: 'HTTP 400 - Bad Request' })).toBe('failure.rejected');
  });

  it('the local engine errorCode wins over the text', () => {
    expect(failureKey({ code: 'media_missing', message: 'HTTP 500' })).toBe('failure.media');
    expect(failureKey({ code: 'needs_scope' })).toBe('failure.scope');
    expect(failureKey({ haltCode: 'credits' })).toBe('failure.credits');
  });

  it('a cloud credential refusal code names the platform (planner card / post panel)', () => {
    expect(humanizeFailure({ code: 'account_unresolved', lane: 'linkedin', message: 'Nothing was published: ...' }, de).text)
      .toBe('Die Cloud hat in diesem Projekt kein verbundenes Konto für LinkedIn. Deshalb wurde nichts veröffentlicht.');
  });

  it('unknown text falls back to one generic sentence (known:false), never the raw string', () => {
    const r = humanizeFailure({ message: 'something odd happened', lane: 'mastodon' }, de);
    expect(r.text).toBe('Mastodon hat den Beitrag nicht angenommen.');
    expect(r.known).toBe(false);
    expect(r.raw).toBe('something odd happened');
    expect(humanizeFailure({ message: null, lane: null }, de).text).toBe('Die Plattform hat den Beitrag nicht angenommen.');
  });


  // Setup's live check (health probe) is not a post: its raw message ("Graph GET /me: HTTP 400
  // OAuthException 190 ...", "token expired") must become one plain sentence, and the post
  // sentences ("did not accept the post") must never describe a connection check.
  const META_190 = 'Graph GET /me: HTTP 400 OAuthException 190 - Invalid OAuth access token - Cannot parse access token';
  it('OAuthException 190 / "Invalid OAuth access token" is an expired login, not a rejected post', () => {
    expect(failureKey({ message: META_190 })).toBe('failure.expired');
    expect(failureKey({ message: '(#190) Error validating access token: The user has not authorized application' })).toBe('failure.expired');
  });

  it('humanizeCheck: an expired check says so in one sentence naming the platform, raw kept for the tooltip', () => {
    const r = humanizeCheck({ message: META_190, lane: 'meta' }, de);
    expect(r).toEqual({ text: 'Die Verbindung ist abgelaufen. Verbinde Meta neu.', raw: META_190, known: true });
    expect(humanizeCheck({ message: 'token expired', lane: 'linkedin' }, de).text).toBe('Die Verbindung ist abgelaufen. Verbinde LinkedIn neu.');
    expect(humanizeCheck({ message: 'token expired', lane: 'linkedin' }, en).text).toBe('The connection has expired. Reconnect LinkedIn.');
  });

  it('humanizeCheck: a check never borrows a post sentence; unknown or post-only keys return no text', () => {
    for (const message of ['something odd', 'HTTP 400 - Bad Request', 'HTTP 413 too large', 'HTTP 500 internal error', 'HTTP 403 - Forbidden']) {
      const r = humanizeCheck({ message, lane: 'x' }, de);
      expect(r.known, message).toBe(false);
      expect(r.text, message).toBe(null);
    }
    expect(humanizeCheck({ message: null, lane: 'x' }, de)).toEqual({ text: null, raw: null, known: false });
    expect(humanizeCheck({ message: 'fetch failed', lane: 'mastodon' }, de).text).toBe('Mastodon war nicht erreichbar.');
  });

  // D5: a Nostr key the engine cannot parse is a bad stored key, not a platform refusal, and
  // "no relay reachable" means no relay answered. Both name their own recovery (reconnect).
  it('Nostr key-parse errors read as an invalid stored key, in posts and in the live check', () => {
    for (const message of [
      'NOSTR_PRIVATE_KEY must be nsec1... (bech32) or 64-char hex',
      'NOSTR_PRIVATE_KEY decodes to 31 bytes (expected 32)',
      'NOSTR_PRIVATE_KEY is out of the secp256k1 range',
      'bech32: bad checksum',
      'bech32: expected nsec1..., got npub1...',
    ]) {
      expect(failureKey({ message }), message).toBe('failure.keyInvalid');
      const c = humanizeCheck({ message, lane: 'nostr' }, de);
      expect(c.text, message).toBe('Der gespeicherte Schlüssel für Nostr ist ungültig. Neu verbinden behebt das.');
      expect(c.known).toBe(true);
    }
    expect(humanizeFailure({ message: 'bech32: invalid character', lane: 'nostr' }, en).text).toBe('The stored key for Nostr is not valid. Reconnecting fixes it.');
    // The not-configured probe row still says "not set up", never "invalid key".
    expect(failureKey({ message: 'not configured (NOSTR_PRIVATE_KEY missing)' })).toBe('failure.notConfigured');
  });

  it('"no relay reachable" says no relay answered, never that the platform refused the credential', () => {
    const c = humanizeCheck({ message: 'no relay reachable (0/3)', lane: 'nostr' }, de);
    expect(c.text).toBe('Kein Nostr-Relay hat geantwortet. Vielleicht sind die Relays gerade nicht erreichbar, oder die Liste ist veraltet. Verbinde neu, um die Relays zu ändern.');
    expect(c.known).toBe(true);
    expect(failureKey({ message: 'no relay reachable (0/1)' })).toBe('failure.relaysDown');
  });

  // The Setup Connect panel's error line: the /api/connect 400 ("nostr needs privateKey") and
  // the ceremony's failed detail (the auth run's last stderr line) are English engine text.
  // One plain sentence inline, the raw text for the "?" only.
  it('humanizeConnect: a typed key the engine cannot parse says the key is not valid, raw kept', () => {
    const raw = '[err] NOSTR_PRIVATE_KEY must be nsec1... (bech32) or 64-char hex';
    expect(humanizeConnect({ message: raw, lane: 'nostr' }, de)).toEqual({ text: 'Dieser Schlüssel ist ungültig. Prüf ihn und versuch es erneut.', raw, known: true });
    expect(humanizeConnect({ message: 'bech32: bad checksum', lane: 'nostr' }, en).text).toBe('That key is not valid. Check it and try again.');
  });

  it('humanizeConnect: a missing field names it with the label the owner sees', () => {
    const fields = [{ key: 'privateKey', label: 'Privater Schlüssel' }, { key: 'relays', label: 'Relays' }];
    const r = humanizeConnect({ message: 'nostr needs privateKey', lane: 'nostr', fields }, de);
    expect(r.text).toBe('Fehlt noch: Privater Schlüssel');
    expect(r.text).not.toMatch(/privateKey|nostr needs/);
    const oauth = [{ key: 'oauthClientId', label: 'Client ID' }, { key: 'clientSecret', label: 'Client secret' }];
    expect(humanizeConnect({ message: 'x needs a Client ID and Client Secret to connect', lane: 'x', fields: oauth }, en).text).toBe('Still missing: Client ID, Client secret');
    const meta = [{ key: 'systemUserToken', label: 'System User token' }];
    expect(humanizeConnect({ message: 'meta needs a System User token (systemUserToken)', lane: 'meta', fields: meta }, en).text).toBe('Still missing: System User token');
  });

  it('humanizeConnect: a refused credential says so for the connect, a live-check sentence otherwise, else the generic line', () => {
    expect(humanizeConnect({ message: 'telegram: getMe: HTTP 401 - Unauthorized', lane: 'telegram' }, de).text).toBe('Telegram hat diese Angaben nicht angenommen. Prüf sie und versuch es erneut.');
    expect(humanizeConnect({ message: 'fetch failed', lane: 'mastodon' }, de).text).toBe('Mastodon war nicht erreichbar.');
    const odd = humanizeConnect({ message: 'listen EADDRINUSE :::8088', lane: 'youtube' }, en);
    expect(odd).toEqual({ text: 'Connection failed. Try again, or connect from your terminal below.', raw: 'listen EADDRINUSE :::8088', known: false });
    expect(humanizeConnect({ message: null, lane: 'x' }, de)).toEqual({ text: 'Verbindung fehlgeschlagen. Versuch es erneut oder verbinde über dein Terminal weiter unten.', raw: null, known: false });
  });

  it('humanizeAction: a lane-less local write says the caller\'s own sentence; the raw line only rides `raw`', () => {
    const r = humanizeAction(new Error('/api/config: HTTP 409'), de, { fallbackKey: 'setup.identifier.saveError' });
    expect(r).toEqual({ text: 'Wert konnte nicht gespeichert werden.', raw: '/api/config: HTTP 409', known: false });
    // Without a lane a platform sentence would lie (the local daemon, not a platform, answered).
    expect(humanizeAction(new Error('fetch failed ECONNREFUSED'), en, { fallbackKey: 'setup.disconnect.error' }).text).toBe('Could not disconnect. Please try again.');
    // A message that already IS the sentence is not repeated behind the "?".
    expect(humanizeAction(new Error('Could not disconnect. Please try again.'), en, { fallbackKey: 'setup.disconnect.error' }).raw).toBe(null);
    expect(humanizeAction(null, de, { fallbackKey: 'setup.agent.token.failed' })).toEqual({ text: 'Token konnte nicht gesichert werden.', raw: null, known: false });
  });

  it('humanizeAction: a platform action names the connection problem; timeout and an unreachable pendpost get their own lines', () => {
    const r = humanizeAction(new Error('pinterest: POST /v5/boards: HTTP 401 - Unauthorized'), de, { fallbackKey: 'setup.writeError', lane: 'pinterest' });
    expect(r.text).toBe('Die Verbindung ist abgelaufen. Verbinde Pinterest neu.');
    expect(r.raw).toMatch(/HTTP 401/);
    expect(r.known).toBe(true);
    // A post-only sentence (403 "refused the post") never describes a board or newsletter write.
    expect(humanizeAction(new Error('HTTP 403 - Forbidden'), en, { fallbackKey: 'setup.writeError', lane: 'gbp' }).text).toBe('Could not save. Reload and try again.');
    expect(humanizeAction(Object.assign(new Error('/api/x: timed out after 30s'), { code: 'timeout' }), en, { fallbackKey: 'setup.writeError' }).text).toMatch(/^The server took too long/);
    expect(humanizeAction(new TypeError('Load failed'), de, { fallbackKey: 'setup.writeError' }).text).toBe('Keine Verbindung zum lokalen pendpost. Läuft der Dienst?');
  });

  it('humanizeAction: an approve refused for a skipped, unconnected lane names the one-step fix in both languages', () => {
    const err = Object.assign(new Error('Reddit is not set up in this project. Connect it in Setup or remove Reddit from the post.'), { code: 'not_configured', platform: 'reddit' });
    const d = humanizeAction(err, de, { fallbackKey: 'error.action' });
    expect(d.text).toBe('Reddit ist in diesem Projekt nicht eingerichtet. Verbinde Reddit unter Einrichtung oder entferne Reddit aus dem Beitrag.');
    expect(d.known).toBe(true);
    expect(humanizeAction(err, en, { fallbackKey: 'error.action' }).text).toBe('Reddit is not set up in this project. Connect it in Setup or remove Reddit from the post.');
    // Without a platform the code alone says nothing about a lane: the caller's own sentence.
    expect(humanizeAction(Object.assign(new Error('x'), { code: 'not_configured' }), en, { fallbackKey: 'error.action' }).text).toBe('That did not work. Please try again.');
  });

  it('humanizeAction: a sentence the Studio wrote itself (plainError) IS the alert; its optional detail rides the "?"', () => {
    expect(humanizeAction(plainError('Das Datum liegt in der Vergangenheit.'), de, { fallbackKey: 'error.action' }))
      .toEqual({ text: 'Das Datum liegt in der Vergangenheit.', raw: null, known: true });
    expect(humanizeAction(plainError('1 fehlgeschlagen: p1', 'p1: HTTP 500 internal'), de).raw).toBe('p1: HTTP 500 internal');
    // A plain Error with the same words is still a server line: it rides the "?" only.
    expect(humanizeAction(new Error('HTTP 500 internal'), en, { fallbackKey: 'error.action' }))
      .toEqual({ text: 'That did not work. Please try again.', raw: 'HTTP 500 internal', known: false });
  });

  // #40: approve refused because the caption breaks a brand rule. The sentence names every
  // platform and the fix; each finding (hint + the matched text) rides the "?" only.
  it('humanizeAction: lint_blocked names the platforms, the rules by name and the fix; no engine line', () => {
    const err = Object.assign(new Error('caption fails brand lint on instagram, x'), {
      code: 'lint_blocked',
      findings: [
        { platform: 'instagram', rule: 'em-dash', match: '\u2014', hint: 'Replace the em dash with a comma.' },
        { platform: 'x', rule: 'banned-phrase', match: 'game-changer', hint: 'Say what it does instead.' },
        { platform: 'instagram', rule: 'all-caps', match: 'NEW', hint: 'Write it in sentence case.' },
      ],
    });
    const r = humanizeAction(err, en, { fallbackKey: 'error.action' });
    expect(r.text).toBe('The caption breaks a brand rule on Instagram, X (Long dashes, Banned phrase, All caps). Edit the caption for Instagram, X or remove Instagram, X from the post.');
    expect(r.known).toBe(true);
    expect(r.raw).toBeNull();
    expect(humanizeAction(err, de).text).toBe('Der Text verstösst auf Instagram, X gegen eine Markenregel (Lange Gedankenstriche, Banned phrase, Grossbuchstaben). Passe den Text für Instagram, X an oder entferne Instagram, X aus dem Beitrag.');
    // No findings (an older server): still the plain sentence, never the raw line.
    const bare = humanizeAction(Object.assign(new Error('lint'), { code: 'lint_blocked' }), en);
    expect(bare.text).toBe('The caption breaks a brand rule on a target platform. Edit the caption or remove that platform from the post.');
    expect(bare.known).toBe(true);
  });

  it('German copy carries no em/en dashes, spaced hyphens or ß', () => {
    for (const key of ['connect.keyInvalid', 'connect.refused', 'failure.generic', 'failure.credits', 'failure.blocked', 'failure.apiDisabled', 'failure.scope', 'failure.notConfigured', 'failure.media', 'failure.targetGone', 'failure.xReply', 'failure.expired', 'failure.forbidden', 'failure.notFound', 'failure.tooLarge', 'failure.rateLimit', 'failure.server', 'failure.network', 'failure.rejected', 'failure.processing', 'failure.check.expired', 'failure.keyInvalid', 'failure.relaysDown', 'error.action', 'approve.lintBlocked', 'approve.lintBlockedAny', 'approvals.lint.advisoryLabel']) {
      const s = de(key, { lane: 'X' });
      expect(s, key).not.toBe(key);
      expect(s, key).not.toMatch(/[–—ß]| - /);
    }
  });
});
