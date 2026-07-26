// lint.mjs - brand_lint: a machine-checkable content gate for captions/copy
// BEFORE anything publishes. The rules themselves live in an editable rules.json
// (NOT hardcoded here) so anyone can tune, disable, or extend them without
// touching code. This module loads + compiles that file and runs it.
//
// Load order: the active client's rules.json (activeRoot()/rules.json, next to
// its .env) wins; the shipped default at the install root is the fallback.
// severity 'error' = hard rule, never ship; 'warn' = a slop signal / advisory,
// fix unless deliberate.
//
// rules.json schema (one object per rule):
//   { id: string, severity: "error"|"warn", matcher, hint: string }
// where `matcher` is either { regex: string, flags?: string } (run against the
// caption) or a string naming a built-in in MATCHERS below (platform-aware).
//
// A note on the reddit* built-ins: they are PLATFORM-GATED (silent unless the caller
// passes platform 'reddit'). A caller with no platform in context, e.g. the free-text
// composer panel, therefore never sees them, which is correct - the shape they flag is
// only a problem in a room that removes posts for it.
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, logLine } from './util.mjs';
import { activeRoot } from './context.mjs';

const DEFAULT_RULES_PATH = path.join(REPO_ROOT, 'rules.json');
// The owner's rules.json lives in the ACTIVE client subtree (activeRoot()),
// resolved at call time so withClient()/the active client are honored, with the
// legacy WORKSPACE_ROOT fallback when un-migrated.
function workspaceRulesPath() {
  return path.join(activeRoot(), 'rules.json');
}

// Per-platform caption length caps (chars) and hashtag sanity ceilings. With no
// platform in context the matchers fall back to the conservative `default`.
// mastodon: the default instance cap; gbp: Google's local-post summary cap.
// wordpress/ghost/nostr are deliberately absent: the blog lanes publish post.body
// (not the caption) and nostr has no protocol cap, so the conservative `default`
// advisory is the right guard for their caption fields.
const CAPTION_LIMITS = { instagram: 2200, facebook: 63206, linkedin: 3000, youtube: 5000, x: 280, mastodon: 500, gbp: 1500, default: 2200 };
const HASHTAG_LIMITS = { instagram: 30, default: 10 };

// Built-in non-regex matchers. Each takes (text, ctx) where ctx may carry
// { platform }, and returns an array of { match, index } findings. These are the
// platform-aware / counting checks a single regex cannot express cleanly.
const MATCHERS = {
  captionLength(text, ctx = {}) {
    const cap = (ctx.platform && CAPTION_LIMITS[ctx.platform]) || CAPTION_LIMITS.default;
    if (text.length <= cap) return [];
    const where = ctx.platform ? ` for ${ctx.platform}` : '';
    return [{ match: `${text.length} chars (cap ${cap}${where})`, index: cap }];
  },
  hashtagCount(text, ctx = {}) {
    const limit = (ctx.platform && HASHTAG_LIMITS[ctx.platform]) || HASHTAG_LIMITS.default;
    const tags = [...text.matchAll(/(?:^|\s)(#[\p{L}0-9_]+)/gu)];
    if (tags.length <= limit) return [];
    const tip = tags[limit];
    return [{ match: `${tags.length} hashtags (sane max ${limit})`, index: tip ? tip.index : 0 }];
  },
  allCaps(text) {
    // 3+ consecutive ALL-CAPS words (>= 2 chars each) reads as shouting; a lone
    // acronym (HTTP, API) does not trip it.
    const re = /\b[A-Z][A-Z0-9]+(?:\s+[A-Z][A-Z0-9]+){2,}\b/g;
    const out = [];
    for (let m; (m = re.exec(text)); ) out.push({ match: m[0].slice(0, 40), index: m.index });
    return out;
  },
  // ---- Reddit-only shape checks -------------------------------------------------------
  // These three are platform-GATED: they return [] unless ctx.platform is 'reddit', so the
  // same rules.json entry is silent everywhere else. Reddit is the one lane where the
  // launch-announcement shape is not merely weak copy, it is what gets a post removed, and
  // the caption that reads fine on LinkedIn is exactly the caption that fails there.
  redditLaunchShape(text, ctx = {}) {
    if (ctx.platform !== 'reddit') return [];
    // The "I made a thing" opener and the compliance-boilerplate disclosure. Both announce
    // that what follows is an advertisement, before the reader has any reason to care.
    const re = /\b(?:so\s+)?i\s+(?:built|made|created|wrote)\b|\bsharing\s+(?:a|an|my)\b|\bdisclosure:\s*i\b|\bcheck\s+it\s+out\b|\bwould\s+love\s+(?:your\s+)?(?:feedback|input)\b/gi;
    const out = [];
    for (let m; (m = re.exec(text)); ) out.push({ match: m[0].slice(0, 40), index: m.index });
    return out;
  },
  redditSpecDump(text, ctx = {}) {
    if (ctx.platform !== 'reddit') return [];
    // Three or more capability/stack tokens inside ONE sentence. The count is what matters,
    // not any single word: "it is MIT" is a fact, "zero-dep, MIT, local-first, JSON-RPC" is a
    // spec sheet, and the spec sheet is the strongest press-release tell Reddit reacts to.
    const TOKEN = /\b(zero[- ]?dep(?:endency|s)?|open[- ]?source|self[- ]?hosted?|local[- ]?first|MIT|Apache|GPL|JSON-?RPC|REST|API|SDK|CLI|Docker|compose|npx|npm|stdio|OAuth|webhooks?|cross[- ]?platform|no[- ]?tracking|privacy[- ]?first|end[- ]?to[- ]?end|mock mode|one[- ]?click)\b/gi;
    const out = [];
    // Split on sentence enders AND newlines: a spec dump is just as often a bullet run.
    let offset = 0;
    for (const sentence of text.split(/(?<=[.!?])\s+|\n+/)) {
      const hits = [...sentence.matchAll(TOKEN)];
      if (hits.length >= 3) {
        out.push({ match: hits.slice(0, 4).map((h) => h[0]).join(', '), index: offset + (hits[0].index || 0) });
      }
      offset += sentence.length + 1;
    }
    return out;
  },
  redditBaitPhrase(text, ctx = {}) {
    if (ctx.platform !== 'reddit') return [];
    // "link in comments" and its relatives. Readers read it as bait because it is, and on a
    // cold account the sitewide spam filter weights it the same way.
    const re = /\b(?:link|repo|links?|details|url)\b[^.!?\n]{0,20}\bin\s+(?:the\s+)?comments?\b|\bin\s+comments?\b|\bDM\s+me\b|\bhappy\s+to\s+answer\s+any\s+questions\b|\bupvote\b/gi;
    const out = [];
    for (let m; (m = re.exec(text)); ) out.push({ match: m[0].slice(0, 40), index: m.index });
    return out;
  },
  brokenLink(text) {
    const out = [];
    const empty = /\[[^\]]*\]\(\s*\)/g; // empty markdown link [label]()
    for (let m; (m = empty.exec(text)); ) out.push({ match: m[0], index: m.index });
    const bare = /https?:\/\/(?=\s|$|[).,])/gi; // a scheme with no host
    for (let m; (m = bare.exec(text)); ) out.push({ match: m[0], index: m.index });
    return out;
  },
};

// Compiled-rule cache is per-root (Map keyed by the resolved rules path), so
// each client keeps its OWN compiled rules: switching clients (withClient) never
// serves another client's rules, and the legacy fallback (no clients.json) keys
// on the single workspace path exactly as the old single cache did.
const caches = new Map(); // resolved rules path -> compiled-rule array

function compile(rules, src) {
  const compiled = [];
  for (const r of rules || []) {
    if (!r || typeof r.id !== 'string') continue;
    const severity = r.severity === 'error' ? 'error' : 'warn';
    const hint = typeof r.hint === 'string' ? r.hint : '';
    if (typeof r.matcher === 'string') {
      const fn = MATCHERS[r.matcher];
      if (!fn) { logLine('err', `lint rule ${r.id}: unknown built-in matcher "${r.matcher}" (skipped)`); continue; }
      compiled.push({ rule: r.id, severity, hint, fn });
    } else if (r.matcher && typeof r.matcher.regex === 'string') {
      let re;
      try { re = new RegExp(r.matcher.regex, r.matcher.flags || 'g'); }
      catch (e) { logLine('err', `lint rule ${r.id}: bad regex (${e.message}) (skipped)`); continue; }
      compiled.push({ rule: r.id, severity, hint, re });
    } else {
      logLine('err', `lint rule ${r.id}: matcher must be {regex,flags} or a built-in name (skipped)`);
    }
  }
  if (!compiled.length) logLine('err', `lint: ${src} compiled to zero usable rules`);
  return compiled;
}

function loadRules() {
  // Key the cache on the active client's rules path so each client compiles its
  // own rules; the default-fallback path is also a valid, stable key.
  const wsPath = workspaceRulesPath();
  const cached = caches.get(wsPath);
  if (cached) return cached;
  for (const p of [wsPath, DEFAULT_RULES_PATH]) {
    let raw;
    try {
      raw = fs.readFileSync(p, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') logLine('err', `lint: rules.json at ${p} unreadable (${err.message}) - trying fallback`);
      continue;
    }
    try {
      const parsed = JSON.parse(raw);
      const compiled = compile(parsed.rules, p);
      caches.set(wsPath, compiled);
      return compiled;
    } catch (err) {
      logLine('err', `lint: rules.json at ${p} is not valid JSON (${err.message}) - trying fallback`);
    }
  }
  // No usable rules file anywhere: lint becomes a no-op rather than throwing, so
  // a missing/broken rules.json never blocks the composer or the publish path.
  caches.set(wsPath, []);
  return caches.get(wsPath);
}

// Drop the compiled-rule cache (every client's); next lint reloads rules.json
// from disk. Exposed so an edited rules.json takes effect without a server
// restart.
export function reloadRules() {
  caches.clear();
  return loadRules().length;
}

// ctx carries optional { platform } for the platform-aware matchers; callers
// that only have free text (the composer panel) pass nothing and get the
// conservative defaults. Finding shape is stable: { rule, severity, match,
// index, hint } - the dashboard + MCP face depend on it.
export function lintText(text, ctx = {}) {
  const findings = [];
  const value = String(text || '');
  for (const r of loadRules()) {
    let hits;
    if (r.fn) {
      try { hits = r.fn(value, ctx) || []; } catch { hits = []; }
    } else {
      hits = [];
      r.re.lastIndex = 0;
      for (let m; (m = r.re.exec(value)); ) {
        hits.push({ match: m[0], index: m.index });
        if (!r.re.global) break;
        if (m.index === r.re.lastIndex) r.re.lastIndex += 1; // guard zero-width matches
      }
    }
    for (const h of hits) {
      findings.push({ rule: r.rule, severity: r.severity, match: h.match, index: h.index, hint: r.hint });
      if (findings.length >= 200) return { findings, truncated: true };
    }
  }
  return { findings, truncated: false };
}

// Lint one post's caption + firstComment + title, or a free-text snippet. An
// optional platform tunes the platform-aware checks (caption cap, hashtag cap).
export function brandLint({ text, platform } = {}) {
  if (typeof text !== 'string') {
    return { code: 'invalid_input', message: 'text (string) is required' };
  }
  const { findings, truncated } = lintText(text, { platform });
  return {
    ok: true,
    clean: findings.filter((f) => f.severity === 'error').length === 0,
    errors: findings.filter((f) => f.severity === 'error').length,
    warnings: findings.filter((f) => f.severity === 'warn').length,
    findings,
    truncated,
  };
}
