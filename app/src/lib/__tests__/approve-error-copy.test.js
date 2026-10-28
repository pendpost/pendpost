import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { makeT } from '../i18n.js';
import { humanizeAction } from '../failureCopy.js';

// Tier-1 guard: every error code an approve can come back with has its OWN sentence, so the
// generic "That did not work" can never stand in for a refusal the engine named. The code list
// is DERIVED from the engine source (lib/writes.mjs setApproval and the helpers it returns
// through, lib/api.mjs's approve route plumbing), so an engine change that adds a refusal
// without dashboard copy fails here, before an owner ever reads "please try again" for it.
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const writes = read('../../../../lib/writes.mjs');
const api = read('../../../../lib/api.mjs');
const util = read('../../../../lib/util.mjs');

// A top-level function's body: from its declaration to the first closing brace at column 0.
function bodyOf(src, name) {
  const at = src.search(new RegExp(`^(?:export )?(?:async )?function ${name}\\(`, 'm'));
  if (at === -1) throw new Error(`function ${name} not found in the engine source`);
  return src.slice(at, src.indexOf('\n}\n', at));
}
function codesIn(text) {
  const out = new Set();
  for (const re of [/errorBody\('([a-z_]+)'/g, /code: '([a-z_]+)'/g, /err\.code \|\| '([a-z_]+)'/g]) {
    for (const m of text.matchAll(re)) out.add(m[1]);
  }
  return out;
}

// setApproval's own refusals + the helpers it returns through (id/actor checks, the campaign
// lookup), the route's body parse (jsonRoute) and the router's unknown-route answer.
const engineCodes = new Set([
  ...['setApproval', 'requireIds', 'requireActor', 'findPlanEntry'].flatMap((fn) => [...codesIn(bodyOf(writes, fn))]),
  ...codesIn(bodyOf(api, 'jsonRoute')),
  ...(/errorBody\('unknown_route'/.test(api) ? ['unknown_route'] : []),
]);
// #40 (engine lane, merging in parallel): approve refuses brand-lint errors with lint_blocked.
// Listed here so the copy is guarded before the engine branch lands; once it does, the parse
// above finds it too.
const APPROVE_CODES = [...new Set([...engineCodes, 'lint_blocked'])].sort();
const ERROR_CODES = new Set([...util.slice(util.indexOf('export const ERROR_CODES'), util.indexOf(']);', util.indexOf('export const ERROR_CODES'))).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]));

// The extras each refusal carries in practice (lib/writes.mjs), so the sentence is exercised
// on the shape the server really sends.
const EXTRAS = {
  not_configured: { platform: 'reddit' },
  not_ready: { blocked: [{ platform: 'mastodon', problems: ['note text is 502 chars - Mastodon caps at 500 (set a shorter mastodonCaption)'], problemCodes: [{ code: 'validate.mastodonTooLong', params: { count: 502, max: 500 }, fix: 'edit' }] }] },
  media_url_dead: { url: 'https://example.com/media/a.jpg', platform: 'instagram' },
  lint_blocked: { findings: [{ platform: 'x', rule: 'banned-phrase', match: 'game-changer', hint: 'Say what it does instead.' }] },
};

const en = makeT('en');
const de = makeT('de-CH');

describe('every approve refusal has its own sentence (Tier-1 guard)', () => {
  it('finds the engine refusals (the parse is not silently empty)', () => {
    for (const code of ['not_configured', 'not_ready', 'media_url_dead', 'unknown_post', 'invalid_input', 'engine_failure']) {
      expect(APPROVE_CODES).toContain(code);
    }
  });

  it('every parsed code is a real engine ERROR_CODE', () => {
    for (const code of engineCodes) expect(ERROR_CODES.has(code), code).toBe(true);
  });

  it('media_url_dead names the host and the fix, offers Edit, and never shows the engine line', () => {
    const err = Object.assign(new Error('https://example.com/media/a.jpg returned 404 (fix: node ops/mirror-media.mjs, then approve again)'), {
      code: 'media_url_dead', action: 'approve', url: 'https://example.com/media/a.jpg', platform: 'instagram',
    });
    expect(humanizeAction(err, en)).toEqual({
      text: "The image link for Instagram doesn't load (example.com), so Instagram can't fetch the image. Replace the image in the editor, then approve again.",
      raw: null,
      known: true, recovery: 'edit', lane: null, blocking: true,
    });
    expect(humanizeAction(err, de).text).toBe('Der Bildlink für Instagram lädt nicht (example.com), deshalb kann Instagram das Bild nicht abrufen. Ersetze das Bild im Editor und gib den Beitrag danach frei.');
  });

  // The not_ready refusal exactly as the engine sends it (lib/writes.mjs setApproval):
  // blocked:[{ platform, problems (English), problemCodes:[{ code, params, fix }] }].
  const notReady = (blocked) => Object.assign(new Error('post p1 is not ready: instagram - Instagram needs a public image URL'), { code: 'not_ready', action: 'approve', blocked });
  const IG_URL = { platform: 'instagram', problems: ['Instagram needs a public image URL (set imageUrl; the engine hosts no media)'], problemCodes: [{ code: 'validate.igImageUrlMissing', params: {}, fix: 'edit' }] };

  it('not_ready renders the detailed sentence from the real blocked[] shape, with Edit for fix:edit', () => {
    const r = humanizeAction(notReady([IG_URL]), en);
    expect(r.text).toBe('On Instagram this post would be refused as it is: Instagram needs a public image URL (set Image URL, or set a public media host in Settings). Fix it in the editor, then approve again.');
    expect(r.raw).toBeNull();
    expect(r.recovery).toBe('edit');
  });

  it('not_ready takes its recovery from fix: setup wins, wait offers none', () => {
    const setup = { platform: 'mastodon', problems: ['Mastodon not connected'], problemCodes: [{ code: 'validate.notConnected', params: {}, fix: 'setup' }] };
    const r = humanizeAction(notReady([IG_URL, setup]), en);
    expect(r).toMatchObject({ recovery: 'setup', lane: 'mastodon' });
    expect(r.text).toMatch(/Fix it in Setup, then approve again\.$/);
    const wait = { platform: 'youtube', problems: ['video still processing'], problemCodes: [{ code: 'validate.stillProcessing', params: {}, fix: 'wait' }] };
    const w = humanizeAction(notReady([wait]), de);
    expect(w.recovery).toBeNull();
    expect(w.text).toBe('Auf YouTube kann dieser Beitrag noch nicht erscheinen. Gib ihn nochmals frei, sobald die Plattform bereit ist.');
  });

  it('not_ready without any fix keeps the editor as the recovery', () => {
    const uncoded = humanizeAction(notReady([{ platform: 'mastodon', problems: ['note text is 502 chars'], problemCodes: [null] }]), de);
    expect(uncoded.text).toBe('Auf Mastodon würde dieser Beitrag so abgelehnt. Korrigiere ihn im Editor und gib ihn danach frei.');
    expect(uncoded.recovery).toBe('edit');
  });

  it('media_url_dead with fix:publish-media names the publish step and offers no Edit', () => {
    const err = Object.assign(new Error('render not mirrored'), { code: 'media_url_dead', action: 'approve', url: 'https://pendpost.com/media/a.jpg', platform: 'instagram', fix: 'publish-media' });
    const r = humanizeAction(err, en);
    expect(r.text).toBe("The image file isn't published to your site yet. Publish the media first, then approve the post.");
    expect(humanizeAction(err, de).text).toBe('Die Bilddatei ist noch nicht auf deiner Website veröffentlicht. Veröffentliche zuerst die Medien und gib den Beitrag danach frei.');
    expect(r.recovery).toBeNull();
    expect(humanizeAction({ ...err, fix: 'edit', message: 'x' }, en).recovery).toBe('edit');
  });

  it('not_configured offers Setup on the named platform; self-approval says who may approve', () => {
    const nc = humanizeAction(Object.assign(new Error('x'), { code: 'not_configured', platform: 'reddit', action: 'approve' }), en);
    expect(nc).toMatchObject({ recovery: 'setup', lane: 'reddit' });
    const self = humanizeAction(Object.assign(new Error('agent:claude created this post and cannot approve it (no self-approval)'), { code: 'invalid_input', action: 'approve' }), en);
    expect(self.text).toBe("Whoever created a post can't approve it as well, so this approval was refused. Ask the owner to approve it.");
  });

  it('an approve-only code from ANOTHER action keeps the caller\'s own fallback', () => {
    const r = humanizeAction(Object.assign(new Error('boom'), { code: 'engine_failure' }), en, { fallbackKey: 'error.action' });
    expect(r.text).toBe(en('error.action'));
    expect(r.known).toBe(false);
  });

  it.each(APPROVE_CODES)('%s: a dedicated plain sentence in en and de-CH, never the generic fallback', (code) => {
    const err = Object.assign(new Error(`engine line for ${code}`), { code, action: 'approve' }, EXTRAS[code] || {});
    for (const [t, label] of [[en, 'en'], [de, 'de-CH']]) {
      const r = humanizeAction(err, t, { fallbackKey: 'error.action' });
      expect(r.known, `${code} ${label}`).toBe(true);
      expect(r.text, `${code} ${label}`).not.toBe(t('error.action'));
      // The engine's English line is never the sentence; it rides the "?".
      expect(r.text).not.toMatch(/engine line|mastodonCaption|imageUrl/);
      expect(r.text).not.toMatch(/[–—ß]| - /);
    }
  });
});
