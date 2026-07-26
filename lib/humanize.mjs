// humanize.mjs - the always-on deterministic humanizer gate. Zero-dep, pure, no I/O.
//
// The owner's standing rule: every outward-facing string is humanized first, zero em
// dashes anywhere, and de-CH copy uses real umlauts and never the eszett. That rule used
// to live only in docs plus an ADVISORY brand_lint an agent had to remember to run. This
// module makes the MECHANICAL half of it structural: it runs at authoring time on every
// outbound field, so what gets persisted (and therefore what the transmit-only engines
// send) is already clean.
//
// Two halves, matching the honest split the engine can support:
//   - AUTO-FIX (here): the unambiguous, deterministic tells - em/en dashes, curly quotes,
//     and (de-CH only) the eszett. These have one correct fix, so we apply it silently.
//   - ADVISORY (via lintText): the judgement tells - ai-vocab, puffery, rule-of-three,
//     negative parallelism, all-caps. Those need a writer's eye (or the full /humanizer
//     skill an agent runs at draft time), so we surface them as findings and change nothing.
//
// Everything here is idempotent: run it twice and the second pass is a no-op (there are no
// dashes or curly quotes left to fix). The approval flow re-reads persisted text, so that
// property is load-bearing.
import { lintText } from './lint.mjs';

// Curly quotes/apostrophes -> straight. Grouped so a single apostrophe variant and a single
// double-quote variant each collapse to the ASCII form.
const CURLY_APOS = /[‘’‚‛]/g;
const CURLY_QUOT = /[“”„‟]/g;
const DASH = /[–—]/; // en dash U+2013, em dash U+2014 (NOT the hyphen-minus)

/**
 * Deterministically humanize one string.
 * @param {string} text
 * @param {{locale?: string}} opts - locale routes the de-CH eszett fix ('de-CH' | 'en' | ...).
 * @returns {{ text: string, changed: boolean, fixes: string[], findings: object[] }}
 *   findings are the WARN-severity lint hits on the cleaned text (advisory, not applied).
 */
export function humanize(text, { locale = 'en' } = {}) {
  if (typeof text !== 'string' || text === '') {
    return { text: typeof text === 'string' ? text : '', changed: false, fixes: [], findings: [] };
  }
  let out = text;
  const fixes = [];

  // 1. Em/en dash -> comma. The humanizer guidance is "a comma, a period, or restructure";
  //    a comma is the safe deterministic default. Collapse the flanking spaces, then tidy the
  //    artifacts a replacement can create (", ." -> ".", a leading/trailing stray comma). The
  //    tidy only runs when a dash was actually present, so a legitimately-authored trailing
  //    comma in dash-free text is never touched.
  if (DASH.test(out)) {
    out = out
      .replace(/\s*[–—]\s*/g, ', ')
      .replace(/,\s*([.!?;:])/g, '$1')
      .replace(/^\s*,\s+/, '')
      .replace(/\s*,\s*$/, '');
    fixes.push('em-dash');
  }

  // 2. Curly quotes/apostrophes -> straight ASCII.
  if (CURLY_APOS.test(out)) { out = out.replace(CURLY_APOS, "'"); fixes.push('curly-quote'); }
  if (CURLY_QUOT.test(out)) { out = out.replace(CURLY_QUOT, '"'); fixes.push('curly-quote'); }

  // 3. de-CH only: the eszett is never used in Swiss German - it is always written 'ss'
  //    (Strasse, not Straße). English (and every other locale) keeps its text untouched.
  if (locale === 'de-CH' && out.includes('ß')) {
    out = out.replace(/ß/g, 'ss');
    fixes.push('eszett');
  }

  const findings = lintText(out).findings.filter((f) => f.severity === 'warn');
  return { text: out, changed: out !== text, fixes: [...new Set(fixes)], findings };
}

/**
 * Humanize a curated set of string fields on an object IN PLACE. Used at the authoring
 * seams (post create/update, replies, profile updates) so only genuine prose is touched -
 * never ids, slugs, urls, flair labels, or lang codes, which callers keep out of fieldNames.
 * @returns {{ changed: boolean, findings: object[] }} findings carry the originating `field`.
 */
export function humanizeFields(obj, fieldNames, locale = 'en') {
  if (!obj || typeof obj !== 'object') return { changed: false, findings: [] };
  let changed = false;
  const findings = [];
  for (const k of fieldNames) {
    const v = obj[k];
    if (typeof v !== 'string' || v === '') continue;
    const r = humanize(v, { locale });
    if (r.changed) { obj[k] = r.text; changed = true; }
    for (const f of r.findings) findings.push({ field: k, ...f });
  }
  return { changed, findings };
}

// The post prose fields that carry human copy (plan_create_post / plan_update_post). This is
// a CURATED subset of the writes.mjs field allowlist: the structural fields on that list
// (redditFlairText - must match a real flair label; redditSubreddit/blogSlug/pinBoardSection/
// emailSegment/newsletter - ids and slugs; captionLang - a lang code; tags/wpCategories -
// taxonomy; the url fields) are DELIBERATELY excluded, because auto-fixing them would corrupt
// a match, a route, or a taxonomy.
export const POST_PROSE_FIELDS = [
  'caption', 'firstComment', 'title', 'description', 'liDescription', 'xCaption', 'body',
  'excerpt', 'mastodonCaption', 'nostrCaption', 'tgCaption', 'dcCaption', 'ttCaption',
  'redditText', 'pinTitle', 'pinDescription', 'altText', 'metaTitle', 'metaDescription',
  'featureImageAlt', 'spoilerText', 'dcThreadName',
];
