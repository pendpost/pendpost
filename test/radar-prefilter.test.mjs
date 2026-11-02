// radar-prefilter.test.mjs - the deterministic engine-lane pre-filters (relevance plan 2026-09-30,
// Phase 1a): the proximity phrase gate, bot and relay accounts, the brand's own posts, mutes, the
// language gate, near-duplicate collapse and plural-tolerant excludes.
//
// The fixtures are the noise classes the 2026-09-30 audit of the live feeds found (the texts are
// faithful reconstructions, trimmed; no live handle or client data is copied here): a Hacker News
// politics comment that says "self", "host", "social" and "posting" paragraphs apart, the
// "#Alternity" retroclone toot a "Later alternative" search picked up, a Bridgy Fed sports relay, a
// fashion headline about Coach bags, the brand's own Mastodon reply, a Spanish post on a German
// search, and one promo posted three times. Two real leads must SURVIVE every gate.
//
// Part 1 calls the pure verdict (lib/radar-prefilter.mjs engineDropReason). Part 2 drives the same
// fixtures through the real scan seam (runRadarScan -> engine spawn -> mock driver fixture) and
// checks the per-reason `dropped` tally the scan reports.
//
// Zero-dep node:assert. Temp PENDPOST_ROOT, PENDPOST_MODE=mock, set BEFORE importing lib.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
let failures = 0;
function ok(cond, msg) {
  if (cond) { pass += 1; console.log(`  ok - ${msg}`); } else { failures += 1; console.error(`  FAIL - ${msg}`); }
}

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-radar-prefilter-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }));
// The brand's own Mastodon account (isOwnAuthor compares the acct's local part).
fs.writeFileSync(path.join(WS, '.env'), 'MASTODON_HANDLE=pendpost@mastodon.social\n');

const nowIso = new Date().toISOString();

// ---- the searches -------------------------------------------------------------------------
const Q_SELF = { id: 'selfhost', label: 'self-hosted posting', keywords: ['self host social posting'], sources: ['hackernews'] };
const Q_LATER = { id: 'later', label: 'Later switchers', keywords: ['Later alternative'], sources: ['mastodon'] };
const Q_SWITCH = { id: 'switch', label: 'tool switchers', keywords: ['social media management tool'], sources: ['reddit'] };
const Q_COACH = { id: 'coachplat', label: 'coaching platform', keywords: ['coaching platform'], hashtags: ['coaching'], excludeKeywords: ['coach bag'], sources: ['mastodon'] };
const Q_DE = { id: 'de', label: 'Mastodon Automatisierung', lang: 'de', keywords: ['Mastodon Automatisierung', 'postiz'], sources: ['mastodon'] };
const Q_BRAND = { id: 'brand', label: 'brand mentions', mention: true, keywords: ['pendpost'], sources: ['mastodon'] };

// ---- the fixtures (normalizeSignal shape) --------------------------------------------------
const item = (source, externalId, text, extra = {}) => ({ source, externalId, url: `https://example.org/${source}/${externalId}`, author: `user_${externalId}`, text, community: null, ts: nowIso, ...extra });

const HN_POLITICS = item('hackernews', 'hn-politics', 'The real problem is that people self-censor now. Every late night talk show host is terrified of one clip going viral, and the old social contract around disagreement has quietly collapsed. I stopped posting anything political years ago, and most people I know did the same.', { community: 'news.ycombinator.com' });
const ALTERNITY = item('mastodon', 'alternity', 'Scifinity, an #Alternity microlite retroclone, is out now. Character sheets and the quickstart come later this week.');
const FOX_NFL = item('mastodon', 'fox-nfl', 'Coach says the QB will start on Sunday despite the ankle injury #NFL', { author: 'foxsports.com@fed.brid.gy', authorDomain: 'fed.brid.gy', url: 'https://fed.brid.gy/r/https://www.foxsports.com/stories/nfl/qb-start' });
const COACH_BAGS = item('mastodon', 'coach-bags', 'Coach Unveils Playful Fall Statement Bags ahead of fashion week');
const OWN_REPLY = item('mastodon', 'own-reply', 'Thanks for asking! pendpost schedules to Mastodon and Bluesky from your own machine, and every post waits for your approval.', { author: 'pendpost' });
const SPANISH = item('mastodon', 'spanish', 'Busco una herramienta para programar publicaciones en Mastodon, ¿alguien conoce algo como postiz que no sea muy caro para una agencia pequeña?');
const MIXPOST = (n) => item('reddit', `mixpost-${n}`, `Mixpost is the self-hosted social media management tool you actually own. Schedule posts to ten networks, no monthly fees. Try it today! https://mixpost.example/?ref=${n}`, { author: `promo_${n}` });
const BOT = item('mastodon', 'bot', 'Neuer Artikel: Mastodon Automatisierung mit postiz und n8n, so geht es Schritt für Schritt.', { author: 'feedbot@bots.example', bot: true });
const MUTED = item('mastodon', 'muted', 'Ich suche eine Alternative zu postiz für meine Mastodon Automatisierung, kennt jemand etwas?', { author: 'spammer@noisy.example' });
const BLOCKED_DOMAIN = item('mastodon', 'blocked', 'Kann jemand ein Tool für die Mastodon Automatisierung empfehlen? Postiz ist mir zu teuer.', { author: 'wire@news.example', authorDomain: 'news.example' });
// The positives. A switch-query price complaint, and a German Mastodon user who found a competitor.
const SWITCH_POSITIVE = item('reddit', 'switch-positive', "I'd love a social media management tool, all of the ones I found were insanely expensive for a two person shop.");
const DE_POSITIVE = item('mastodon', 'de-positive', 'Ich bin gerade dabei, Automatisierungen für Mastodon zu testen und bin dabei über postiz gestolpert. Hat jemand Erfahrung damit?');
// A hashtag-timeline post: on topic by its community, without repeating the keywords.
const HASHTAG = item('mastodon', 'hashtag', 'Neue Woche, neue Klientinnen. Wer von euch nutzt eigentlich ein Buchungstool für die Termine?', { community: '#coaching' });
// A stranger mentioning the brand in an unusual way (mention queries skip the phrase gate).
const MENTION = item('mastodon', 'mention', 'Has anyone here tried pendpost yet?');

try {
  const { engineDropReason, detectLang, textFingerprint, signalDomains, isMuted, isOwnHandle, RADAR_RELAY_DOMAINS, emptyDropTally } = await import('../lib/radar-prefilter.mjs');
  const { keywordAnchors, isExcluded, signalKey, RADAR_UNJUDGED_CAP } = await import('../lib/radar.mjs');
  const { isOwnAuthor } = await import('../lib/comments.mjs');

  const ctx = (extra = {}) => ({
    blockedDomains: ['news.example'],
    muted: { authors: [{ value: 'spammer@noisy.example', at: nowIso, by: 'test' }], domains: [] },
    isOwn: (s) => isOwnAuthor(s.source, { author: s.author }),
    fingerprints: new Map(),
    competitorsDefault: ['Buffer', 'Later'],
    ...extra,
  });

  // ---- Part 1: the pure verdict ---------------------------------------------------------
  // The phrase gate.
  ok(engineDropReason(HN_POLITICS, Q_SELF, ctx()) === 'noAnchor', 'an HN politics comment with "self", "host", "social", "posting" far apart is dropped (noAnchor)');
  ok(keywordAnchors('Is there a way to self host social posting for my club?', ['self host social posting']) === true, 'the same keyword still anchors when the words sit together');
  ok(keywordAnchors('a scheduler I can self-host for social', ['self-hosted social scheduler']) === true, 'tokens anchor across stems within the window ("self-host" for "self-hosted")');
  ok(engineDropReason(ALTERNITY, Q_LATER, ctx()) === 'noAnchor', '"#Alternity ... later this week" does NOT match the "Later alternative" search (noAnchor)');
  // Source hygiene.
  ok(engineDropReason(FOX_NFL, Q_COACH, ctx()) === 'relay', 'a fed.brid.gy sports relay is dropped (relay)');
  ok(RADAR_RELAY_DOMAINS.includes('fed.brid.gy') && RADAR_RELAY_DOMAINS.includes('flipboard.com') && RADAR_RELAY_DOMAINS.includes('flipboard.social'), 'the built-in relay list carries the bridges the audit found');
  ok(signalDomains({ source: 'bluesky', author: 'foxsports.com.ap.brid.gy', url: 'https://bsky.app/profile/x/post/1' }).includes('foxsports.com.ap.brid.gy'), 'a Bluesky handle counts as the author domain');
  ok(engineDropReason({ ...ALTERNITY, externalId: 'flip', author: 'news@flipboard.social', text: 'Later alternative roundup: five tools compared' }, Q_LATER, ctx()) === 'relay', 'a flipboard.social account is a relay even on topic');
  ok(engineDropReason(BLOCKED_DOMAIN, Q_DE, ctx()) === 'relay', 'posting.radar.blockedDomains extends the relay list per client');
  ok(engineDropReason(BOT, Q_DE, ctx()) === 'bot', 'a Mastodon account.bot is dropped (bot)');
  ok(engineDropReason(OWN_REPLY, Q_BRAND, ctx()) === 'own', "the brand's own Mastodon reply is dropped, even on a mention search (own)");
  // Own accounts on lanes with no stored identity: posting.radar.ownHandles (+ the Bluesky env handle).
  const ownCtx = ctx({ isOwn: (s) => isOwnHandle(s, ['pendpost', 'pendpost.bsky.social']) });
  ok(engineDropReason({ ...SWITCH_POSITIVE, source: 'hackernews', externalId: 'hn-own', author: 'pendpost' }, Q_SWITCH, ownCtx) === 'own', 'an HN comment by an ownHandles author is dropped (own)');
  ok(engineDropReason({ ...SWITCH_POSITIVE, source: 'bluesky', externalId: 'bs-own', author: 'pendpost.bsky.social' }, Q_SWITCH, ownCtx) === 'own', 'a Bluesky post by the own handle is dropped (own)');
  ok(isOwnHandle({ source: 'mastodon', author: 'pendpost@fosstodon.org' }, ['pendpost']) === true && isOwnHandle({ source: 'hackernews', author: 'pendpost_fan' }, ['pendpost']) === false, 'own-handle matching is exact (a Mastodon acct matches its local part, nothing fuzzier)');
  ok(engineDropReason(MUTED, Q_DE, ctx()) === 'muted', 'a muted author is dropped (muted)');
  ok(isMuted({ author: 'someone@noisy.example' }, { domains: [{ value: 'noisy.example' }] }) === true, 'a muted domain matches the author\'s host');
  ok(isMuted({ author: 'someone@quiet.example' }, { authors: [], domains: [{ value: 'noisy.example' }] }) === false, 'an unmuted author passes');
  // Language.
  ok(detectLang(SPANISH.text).lang === 'es' && detectLang(SPANISH.text).confident, 'the Spanish post is detected as Spanish, confidently');
  ok(engineDropReason(SPANISH, Q_DE, ctx()) === 'lang', 'a Spanish post on a lang:de search is dropped (lang)');
  ok(detectLang(DE_POSITIVE.text).lang === 'de', 'the German positive reads as German');
  ok(detectLang('postiz?').confident === false, 'a two-word text is never a confident language call (kept when uncertain)');
  ok(engineDropReason({ ...DE_POSITIVE, externalId: 'short', text: 'postiz?' }, Q_DE, ctx()) === null, 'an uncertain language is kept, not dropped');
  // Excludes, token-aware and plural-tolerant.
  ok(isExcluded(COACH_BAGS.text, Q_COACH) === true, '"coach bag" excludes "Coach Unveils Playful Fall Statement Bags"');
  ok(isExcluded('Our coaching platform bag of tricks, part two', { excludeKeywords: ['coach bag'] }) === true, 'the exclude is stem-aware ("coaching ... bag")');
  ok(isExcluded('I need a coaching platform for my practice', Q_COACH) === false, 'a real lead is not excluded');
  ok(isExcluded('Just shipped a feature', { excludeKeywords: ['shipped'] }) === true, 'a single-word exclude still matches as a substring');
  // Folding: ß -> ss and umlaut spellings meet, on both sides.
  ok(isExcluded('Die Strasse nach Zürich ist gesperrt', { excludeKeywords: ['Straße'] }) === true, 'an exclude "Straße" matches the Swiss spelling "Strasse"');
  ok(isExcluded('Neue Gebuehren ab Januar', { excludeKeywords: ['Gebühren'] }) === true, 'an exclude "Gebühren" matches "Gebuehren"');
  ok(keywordAnchors('Suche eine Coaching Software in Zuerich, kennt jemand was?', ['Coaching Software Zürich']) === true, 'a keyword with an umlaut anchors the ae/oe/ue spelling');
  ok(keywordAnchors('Welche Plattform nutzt ihr für die Abrechnung?', ['Plattform fuer Abrechnung']) === true, 'and the other way round (keyword "fuer", text "für")');
  // A bare "Trainer" never excludes: in DACH that is often the coach the search is for.
  ok(isExcluded('Ich bin selbständige Trainerin und suche ein Buchungstool', { excludeKeywords: ['Trainer'] }) === false, 'a bare "Trainer" exclude never drops a self-employed trainer asking for a tool');
  ok(isExcluded('Der Fussball Trainer wurde entlassen', { excludeKeywords: ['Trainer', 'Fussball Trainer'] }) === true, 'a phrase with "Trainer" in it still excludes');
  // Near-duplicates.
  const dupCtx = ctx();
  const promos = [MIXPOST(1), MIXPOST(2), MIXPOST(3)].map((s) => engineDropReason(s, Q_SWITCH, dupCtx));
  ok(promos[0] === null && promos[1] === 'dup' && promos[2] === 'dup', `three identical promos collapse to one (${JSON.stringify(promos)})`);
  ok(engineDropReason(MIXPOST(1), Q_SELF, dupCtx) !== 'dup', 'the SAME thread found by a second search is not a duplicate of itself');
  ok(textFingerprint('same here') === null, 'a short reply gets no fingerprint (never collapsed)');
  const stored = ctx({ fingerprints: new Map([[textFingerprint(MIXPOST(9).text), signalKey(MIXPOST(9))]]) });
  ok(engineDropReason(MIXPOST(4), Q_SWITCH, stored) === 'dup', 'a promo already stored in the feed collapses against it');
  // Exemptions and positives.
  ok(engineDropReason(HASHTAG, Q_COACH, ctx()) === null, 'a hashtag-timeline post the search watches skips the phrase gate');
  ok(engineDropReason(MENTION, Q_BRAND, ctx()) === null, 'a brand mention skips the phrase gate');
  ok(engineDropReason(SWITCH_POSITIVE, Q_SWITCH, ctx()) === null, 'POSITIVE: "I\'d love a social media management tool ... insanely expensive" survives');
  ok(engineDropReason(DE_POSITIVE, Q_DE, ctx()) === null, 'POSITIVE: the German postiz find survives the lang:de search');
  ok(Object.keys(emptyDropTally()).join(',') === 'noAnchor,bot,relay,own,muted,lang,dup,foreign_launch_thread', 'the drop tally names every reason (foreign_launch_thread added in Radar 2.0 step 1)');

  // ---- Part 2: the same fixtures through the real scan seam -------------------------------
  const fixture = {
    selfhost: [{ ...HN_POLITICS, platform: 'hackernews' }],
    later: [{ ...ALTERNITY, platform: 'mastodon' }],
    switch: [SWITCH_POSITIVE, MIXPOST(1), MIXPOST(2), MIXPOST(3)].map((s) => ({ ...s, platform: 'reddit' })),
    coachplat: [FOX_NFL, COACH_BAGS, HASHTAG].map((s) => ({ ...s, platform: 'mastodon' })),
    de: [SPANISH, BOT, MUTED, BLOCKED_DOMAIN, DE_POSITIVE].map((s) => ({ ...s, platform: 'mastodon' })),
    brand: [OWN_REPLY, MENTION].map((s) => ({ ...s, platform: 'mastodon' })),
  };
  const fixturePath = path.join(WS, 'radar-fixture.json');
  fs.writeFileSync(fixturePath, JSON.stringify(fixture));
  process.env.PENDPOST_MOCK_RADAR_FIXTURE = fixturePath;
  fs.writeFileSync(path.join(WS, 'config.json'), JSON.stringify({
    radar: { enabled: true, competitorsDefault: ['Buffer', 'Later'], blockedDomains: ['news.example'], queries: [Q_SELF, Q_LATER, Q_SWITCH, Q_COACH, Q_DE, Q_BRAND] },
  }));
  fs.writeFileSync(path.join(WS, 'state.json'), JSON.stringify({ radar: { muted: { authors: [{ value: 'spammer@noisy.example', at: nowIso, by: 'test' }], domains: [] } } }));

  const { runRadarScan } = await import('../lib/writes.mjs');
  const { loadState } = await import('../lib/state.mjs');
  const scan = await runRadarScan({});
  ok(scan.ok === true && scan.enabled === true, 'the scan runs');
  const d = scan.dropped || {};
  ok(d.noAnchor === 2 && d.relay === 2 && d.bot === 1 && d.own === 1 && d.muted === 1 && d.lang === 1 && d.dup === 2 && d.excluded === 1,
    `the scan reports every drop by reason (${JSON.stringify(d)})`);
  const keys = new Set(loadState().radar.signals.map((s) => s.externalId));
  ok(['switch-positive', 'de-positive', 'hashtag', 'mention', 'mixpost-1'].every((k) => keys.has(k)), `the survivors reach the feed (${[...keys].join(', ')})`);
  ok(['hn-politics', 'alternity', 'fox-nfl', 'coach-bags', 'own-reply', 'spanish', 'bot', 'muted', 'blocked', 'mixpost-2', 'mixpost-3'].every((k) => !keys.has(k)), 'no dropped fixture reaches the feed');
  // No agent provider here: the judge fails closed.
  ok(scan.judge && scan.judge.status === 'not_judged' && scan.judge.error === 'no_provider', `no agent provider -> judge status not_judged/no_provider (${scan.judge && scan.judge.status}/${scan.judge && scan.judge.error})`);
  ok(loadState().radar.judge && loadState().radar.judge.status === 'not_judged', 'the "not judged" status row is persisted (state.radar.judge)');
  const feed = loadState().radar.signals;
  const unjudged = feed.filter((s) => s.unjudged === true);
  ok(unjudged.length === 4 && unjudged.every((s) => s.intentScore <= RADAR_UNJUDGED_CAP), `unjudged engine candidates are capped at ${RADAR_UNJUDGED_CAP} (${unjudged.map((s) => `${s.externalId}:${s.intentScore}`).join(', ')})`);
  const mention = feed.find((s) => s.externalId === 'mention');
  ok(mention && mention.unjudged !== true, 'a mention-search hit is exempt from the judge (never flagged unjudged)');
  // A re-scan finds nothing new to drop twice, and the stored copies do not duplicate.
  const scan2 = await runRadarScan({});
  ok(new Set(loadState().radar.signals.map(signalKey)).size === loadState().radar.signals.length && loadState().radar.signals.length === feed.length, 'a repeat scan keeps the same feed (no duplicates)');
  ok(scan2.dropped.dup === 2, `the promos still collapse on a re-scan (${scan2.dropped.dup})`);

  // Config: blockedDomains is validated, agent-writable.
  const { setConfig, getConfig } = await import('../lib/config.mjs');
  const bad = setConfig({ ifRev: getConfig().rev, actor: 'agent:test', set: { posting: { radar: { blockedDomains: ['not a domain'] } } } });
  ok(bad.code === 'invalid_input', 'posting.radar.blockedDomains refuses a non-domain');
  const good = setConfig({ ifRev: getConfig().rev, actor: 'agent:test', set: { posting: { radar: { blockedDomains: ['news.example', 'relay.example.org'] } } } });
  ok(!good.code, `posting.radar.blockedDomains accepts hostnames from a non-owner actor (${good.code || 'ok'})`);
} catch (err) {
  failures += 1;
  console.error('  FAIL - threw:', err && err.stack ? err.stack : err);
}

try { fs.rmSync(WS, { recursive: true, force: true }); } catch { /* best effort */ }
if (failures) {
  console.error(`[radar-prefilter] FAIL - ${failures} assertion(s) failed, ${pass} passed`);
  assert.fail(`${failures} assertion(s) failed`);
}
console.log(`[radar-prefilter] OK - engine-lane pre-filters drop the audited noise and keep the leads (${pass} assertions).`);
