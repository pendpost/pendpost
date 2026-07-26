#!/usr/bin/env node
// test/humanize.test.mjs - the always-on humanizer gate (lib/humanize.mjs).
//
// Proves the deterministic auto-fixes (em/en dash, curly quotes, de-CH eszett), that the
// judgement tells are surfaced but NEVER auto-rewritten, that the pass is idempotent (the
// approval flow re-reads persisted text), that humanizeFields only touches the fields it is
// handed, and that the curated POST_PROSE_FIELDS list excludes the structural fields whose
// auto-fixing would corrupt a match/route. It also proves the Layer-B agent prompts carry the
// locale-correct /humanizer skill instruction.
//
// Zero-dep node:assert, no spawn. HERMETIC workspace: humanize()'s advisory
// findings come from lintText, which loads the ACTIVE CLIENT's rules.json
// (activeRoot()) - so without a pinned PENDPOST_ROOT this test silently follows
// whatever client the live Studio last activated (found 2026-07-22: the owner
// switching the live daemon to a client whose rules pack has no English
// ai-vocab rule failed this suite mid-CI). Pin an empty temp root so lintText
// deterministically falls back to the repo's own rules.json.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.PENDPOST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-humanize-'));
const { humanize, humanizeFields, POST_PROSE_FIELDS } = await import('../lib/humanize.mjs');
const { radarDraftPrompt, radarComparisonPrompt } = await import('../lib/radar-prompt.mjs');

let pass = 0;
let failures = 0;
const ok = (cond, msg) => { if (cond) { pass += 1; console.log(`  ok - ${msg}`); } else { failures += 1; console.error(`  FAIL - ${msg}`); } };

const DASHES = /[–—]/;
const CURLY = /[‘’“”]/;

// ---- auto-fix: dashes ----
{
  const r = humanize('pendpost is local-first — and it is fast', {});
  ok(!DASHES.test(r.text), 'em dash removed');
  ok(r.text === 'pendpost is local-first, and it is fast', 'em dash becomes a comma, hyphen kept');
  ok(r.changed && r.fixes.includes('em-dash'), 'reports the em-dash fix');
}
ok(humanize('a–b', {}).text === 'a, b', 'en dash becomes ", "');
ok(humanize('word—word', {}).text === 'word, word', 'tight em dash becomes ", "');
ok(humanize('done —', {}).text === 'done', 'trailing dash leaves no stray comma');
ok(humanize('— go', {}).text === 'go', 'leading dash leaves no stray comma');

// ---- auto-fix: curly quotes ----
{
  const r = humanize('“hi” it’s here', {});
  ok(r.text === '"hi" it\'s here', 'curly quotes and apostrophe become straight');
  ok(!CURLY.test(r.text), 'no curly chars remain');
}

// ---- auto-fix: de-CH eszett, locale-gated ----
ok(humanize('Strasse an der Straße', { locale: 'de-CH' }).text === 'Strasse an der Strasse', 'de-CH: eszett becomes ss');
ok(humanize('Straße', { locale: 'en' }).text === 'Straße', 'en: eszett left untouched');
ok(humanize('Straße', {}).text === 'Straße', 'default locale (en): eszett left untouched');

// ---- judgement tells: surfaced, never rewritten ----
{
  const r = humanize('we leverage synergy to elevate results', {});
  ok(r.changed === false && r.text === 'we leverage synergy to elevate results', 'judgement tells are NOT auto-rewritten');
  const rules = r.findings.map((f) => f.rule);
  ok(rules.includes('ai-vocab'), 'ai-vocab surfaced as an advisory finding');
  ok(r.findings.every((f) => f.severity === 'warn'), 'findings are all warn severity');
}

// ---- idempotency (load-bearing for the re-read-on-approval flow) ----
{
  const once = humanize('a — b “x” Straße', { locale: 'de-CH' }).text;
  const twice = humanize(once, { locale: 'de-CH' }).text;
  ok(once === twice, 'humanize is idempotent (second pass is a no-op)');
  ok(!DASHES.test(twice) && !CURLY.test(twice) && !twice.includes('ß'), 'nothing mechanical survives one pass');
}

// ---- things it must NOT touch ----
ok(humanize('well-known real-time end-to-end', {}).text === 'well-known real-time end-to-end', 'hyphenated pairs (hyphen-minus) untouched');
ok(humanize('see https://ex.com/a-b-c for more', {}).text === 'see https://ex.com/a-b-c for more', 'a url with hyphens is untouched');
ok(humanize('', {}).changed === false && humanize('', {}).text === '', 'empty string is a no-op');
ok(humanize(null, {}).text === '' && humanize(undefined, {}).changed === false, 'non-string is a safe no-op');

// ---- humanizeFields: only the named fields, in place ----
{
  const obj = { caption: 'a — b', redditFlairText: 'Show — Tell', notListed: 'keep — me' };
  const res = humanizeFields(obj, ['caption'], 'en');
  ok(obj.caption === 'a, b', 'humanizeFields cleans the listed prose field');
  ok(obj.redditFlairText === 'Show — Tell', 'a field not in the list is left exactly as-is (flair must match)');
  ok(obj.notListed === 'keep — me', 'unlisted field untouched');
  ok(res.changed === true && res.findings.every((f) => typeof f.field === 'string'), 'findings carry the originating field');
  ok(humanizeFields(null, ['caption'], 'en').changed === false, 'humanizeFields on a non-object is a safe no-op');
}

// ---- POST_PROSE_FIELDS: prose in, structural out ----
for (const f of ['caption', 'firstComment', 'title', 'xCaption', 'metaDescription', 'spoilerText']) {
  ok(POST_PROSE_FIELDS.includes(f), `POST_PROSE_FIELDS includes prose field ${f}`);
}
for (const f of ['redditFlairText', 'redditFlairId', 'redditSubreddit', 'blogSlug', 'pinBoardSection', 'emailSegment', 'newsletter', 'captionLang', 'tags', 'wpCategories', 'link', 'image', 'imageUrl', 'redditUrl', 'canonicalUrl', 'dcThreadId']) {
  ok(!POST_PROSE_FIELDS.includes(f), `POST_PROSE_FIELDS excludes structural field ${f}`);
}

// ---- Layer B: radar REPLIES match the THREAD's language (child picks the skill) ----
// A reply's language is the thread's, not any config locale - so the draft prompt must NOT
// hardcode a skill off posting.locale (the bug: a de-CH UI forcing /humanizer-de onto English).
// It offers BOTH skills and tells the child to pick by what it wrote. There is deliberately no
// `locale` param anymore, so passing config here changes nothing.
{
  const d = radarDraftPrompt([], { campaign: 'c' });
  ok(d.includes('HUMANIZE BEFORE YOU SUBMIT'), 'draft prompt carries the humanizer section');
  ok(/same language as the thread/i.test(d), 'draft prompt tells the child to reply in the thread language');
  ok(d.includes('/humanizer-de') && d.includes('/humanizer-en'), 'draft prompt offers BOTH skills so the child picks by what it wrote');
  ok(d.includes('eszett'), 'draft prompt still carries the de-CH orthography rule for German replies');
  ok(d.includes('Zero em dashes'), 'draft prompt states the zero-dash hard rule');
  // The old signature took a locale; it is gone. Passing one must not resurrect a fixed skill.
  const withLoc = radarDraftPrompt([], { campaign: 'c', locale: 'de-CH' });
  ok(withLoc === d, 'a stray locale arg is ignored - reply language is never config-driven');
}

// ---- Layer B: the COMPARISON page is the brand's OWN copy, so it uses a FIXED content locale ----
// Unlike a reply, this page is written in the brand's content language (getContentLocale at the
// call site), so the skill IS chosen deterministically, and only that one skill is named.
{
  const de = radarComparisonPrompt({ title: 'x vs y', key: 'k', buyerPhrases: [] }, { campaign: 'c', platform: 'ghost', locale: 'de-CH' });
  ok(de.includes('/humanizer-de') && !de.includes('/humanizer-en'), 'de-CH comparison page names /humanizer-de only');
  ok(de.includes('eszett'), 'de-CH comparison page carries the eszett rule');
  const en = radarComparisonPrompt({ title: 'x vs y', key: 'k', buyerPhrases: [] }, { campaign: 'c', platform: 'ghost', locale: 'en' });
  ok(en.includes('/humanizer-en') && !en.includes('/humanizer-de'), 'en comparison page names /humanizer-en only');
  ok(!en.includes('eszett'), 'en comparison page omits the de-CH eszett rule');
}

console.log(`\nhumanize.test.mjs: ${pass} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
