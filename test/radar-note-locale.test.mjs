#!/usr/bin/env node
// test/radar-note-locale.test.mjs - the agent's CLOSING LOG LINE follows the operator's UI
// language. The note renders in pendpost's own UI (job row, empty-state hint, digest), so a
// de-CH dashboard reads it in German - while reply language stays the THREAD's language
// (radarDraftPrompt's deliberate no-locale rule is untouched). Proofs:
//   (a) noteLocale 'de-CH' appends the German-note instruction to all three prompts;
//   (b) default (no noteLocale) appends nothing - today's English note, no behaviour change;
//   (c) the reply-language rules survive: the thread's-language delegation is still briefed;
//   (d) noteLocale never leaks into reply-language instructions (log line only).
import assert from 'node:assert';
const { radarScanPrompt, radarGeoPrompt, radarDraftPrompt } = await import('../lib/radar-prompt.mjs');

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const q = [{ id: 'q1', label: 'Buyers', sources: ['reddit'] }];
const sig = [{ source: 'reddit', externalId: 'r1', url: 'https://reddit.com/1', text: 'what tool?' }];
const GERMAN_NOTE = 'Write that line in German.';

// (a)
ok(radarScanPrompt(q, 20, 'pendpost', null, null, 'de-CH').includes(GERMAN_NOTE), '(a) scan prompt asks the log line in German for de-CH');
ok(radarGeoPrompt(['best scheduler?'], { clientId: 'pendpost', noteLocale: 'de-CH' }).includes(GERMAN_NOTE), '(a) geo prompt too');
ok(radarDraftPrompt(sig, { clientId: 'pendpost', noteLocale: 'de-CH' }).includes(GERMAN_NOTE), '(a) draft prompt too');
ok(radarScanPrompt(q, 20, 'pendpost', null, null, 'de').includes(GERMAN_NOTE), '(a) a bare "de" routes German as well');

// (b)
ok(!radarScanPrompt(q, 20, 'pendpost').includes(GERMAN_NOTE), '(b) no noteLocale => no language instruction (status quo)');
ok(!radarDraftPrompt(sig, { clientId: 'pendpost' }).includes(GERMAN_NOTE), '(b) draft prompt default unchanged');
ok(!radarDraftPrompt(sig, { clientId: 'pendpost', noteLocale: 'en' }).includes(GERMAN_NOTE), '(b) an en locale appends nothing');

// (c) the reply-language delegation survives verbatim: replies match the THREAD, never config.
const draft = radarDraftPrompt(sig, { clientId: 'pendpost', noteLocale: 'de-CH' });
ok(/thread/i.test(draft) && /language|Sprache/i.test(draft), '(c) the thread-language briefing is still present with noteLocale set');

// (d) the German-note instruction rides ONLY the closing log line, after the log sentence.
const idx = draft.indexOf(GERMAN_NOTE);
ok(idx > draft.indexOf('That line is for a log'), '(d) the instruction is appended to the log-line sentence, not the reply rules');

console.log(`\n[radar-note-locale] OK - the closing log line follows the operator's UI language, reply language stays the thread's (${pass} assertions).`);
