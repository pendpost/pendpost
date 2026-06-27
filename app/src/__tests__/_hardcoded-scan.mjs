// Zero-dependency JSX scanner for the no-hardcoded-strings tripwire.
//
// A single-pass, stack-based lexer that tracks three contexts - JS code, the
// inside of a JSX tag, and JSX child text - so it can tell a real user-facing
// string literal apart from a comparison operator (`a > b`), a className, a
// comment, a regex literal, a template literal, or anything already wrapped in
// t(...). A plain regex cannot make those distinctions (JSX text vs JS code vs
// already-translated), which is why this is a lexer and not a pattern.
//
// scanSource() returns raw candidates: { offset, kind:'text'|'attr', attr, raw }.
// The OFFENDER decision (allowlist: brands, URLs, endonyms, identifier-shaped
// name=) lives in isOffender() so the rules are testable in isolation.

// Attribute names whose string-literal values are user-facing and must be t()'d.
export const FLAGGED_ATTRS = new Set([
  'aria-label', 'placeholder', 'title', 'label', 'confirmLabel', 'body', 'name',
]);

// Brand / proper nouns + the few non-translatable tokens. A literal made ENTIRELY
// of these (plus punctuation/URLs/digits) is not an offender ("Facebook + Instagram").
const BRANDS = ['pendpost', 'Meta', 'Facebook', 'Instagram', 'LinkedIn', 'YouTube', 'MCP', 'Cmd', 'OK', 'X'];
// The locale selector lists each language in its own name on purpose - never t()'d.
const ENDONYMS = new Set(['English', 'Deutsch (Schweiz)']);

const ID = /[A-Za-z0-9_$]/;
// JS keywords after which an expression (so a `<` is JSX, a `/` is regex) follows.
const EXPR_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'do', 'else', 'yield',
  'await', 'case', 'delete', 'void', 'throw',
]);

// The residual = letters left after removing entities, URLs, leftover {expr},
// and whole-token brands. >= 3 residual letters means "real prose".
function residual(s) {
  let x = s.replace(/&[a-zA-Z#0-9]+;/g, ' '); // HTML entities (&middot; etc.)
  x = x.replace(/https?:\/\/\S+/g, ' '); // URLs
  x = x.replace(/\{[^}]*\}/g, ' '); // any leftover {expr} (safety)
  for (const b of BRANDS) x = x.replace(new RegExp(`\\b${b}\\b`, 'g'), ' ');
  return x.replace(/[^\p{L}]+/gu, '');
}

export function isOffender(c) {
  const s = c.raw.trim();
  if (!s) return false;
  if (ENDONYMS.has(s)) return false;
  // name= often holds a programmatic identifier (name="email"), not prose.
  if (c.kind === 'attr' && c.attr === 'name' && /^[a-z][a-zA-Z0-9_-]*$/.test(s)) return false;
  return residual(s).length >= 3;
}

// Extract bare string-literal contents from a JS expression (the inside of a
// flagged attribute's {...}), skipping anything inside a t(...) call, template
// literals, and comments. Used to catch aria-label={cond ? 'A' : 'B'} - an
// attribute "not wrapped in t()" whose value is an expression of literals.
export function exprStringLiterals(expr) {
  const out = [];
  const n = expr.length;
  let i = 0;
  while (i < n) {
    const c = expr[i];
    if (c === '/' && expr[i + 1] === '/') { while (i < n && expr[i] !== '\n') i += 1; continue; }
    if (c === '/' && expr[i + 1] === '*') { i += 2; while (i < n && !(expr[i] === '*' && expr[i + 1] === '/')) i += 1; i += 2; continue; }
    if (c === '`') { // skip template literal wholesale (dynamic by construction)
      i += 1;
      while (i < n && expr[i] !== '`') { if (expr[i] === '\\') i += 1; i += 1; }
      i += 1; continue;
    }
    if (c === 't' && !ID.test(expr[i - 1] || '') && expr[i - 1] !== '.') {
      let j = i + 1;
      while (j < n && /\s/.test(expr[j])) j += 1;
      if (expr[j] === '(') { // skip the whole t( ... ) span
        i = j + 1; let d = 1;
        while (i < n && d > 0) {
          const d2 = expr[i];
          if (d2 === '\\') { i += 2; continue; }
          if (d2 === '"' || d2 === "'" || d2 === '`') { const q = d2; i += 1; while (i < n && expr[i] !== q) { if (expr[i] === '\\') i += 1; i += 1; } i += 1; continue; }
          if (d2 === '(') d += 1; else if (d2 === ')') d -= 1;
          i += 1;
        }
        continue;
      }
    }
    if (c === '"' || c === "'") {
      const q = c; const qi = i; i += 1; let s = '';
      while (i < n && expr[i] !== q) { if (expr[i] === '\\') { s += expr[i + 1] ?? ''; i += 2; continue; } s += expr[i]; i += 1; }
      i += 1;
      // Skip a literal that is a comparison/assignment operand (=== 'x', != 'x',
      // = 'x'): a logic discriminant, not display text. Ternary branches (? 'x' :
      // 'y') and || / ?? fallbacks are kept (preceded by ? : | & ( , not '=').
      let p = qi - 1;
      while (p >= 0 && /\s/.test(expr[p])) p -= 1;
      if (expr[p] !== '=') out.push(s);
      continue;
    }
    i += 1;
  }
  return out;
}

export function scanSource(src) {
  const n = src.length;
  const candidates = [];
  // Stack of frames: { t:'js', brace } for code, { t:'el' } for an open element
  // whose children (text) we are reading. Top frame = current mode.
  const stack = [{ t: 'js', brace: 0 }];
  const top = () => stack[stack.length - 1];
  let i = 0;
  // Whether a `<` / `/` here begins JSX / a regex (expression position) vs a
  // comparison / division (after a value). Reset as JS tokens are consumed.
  let exprExpected = true;
  // Defensive cap: a lexer bug must fail loudly, never hang a test run.
  let steps = 0;
  const MAX_STEPS = n * 6 + 1000;

  const isSpace = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v';

  // Skip a quoted string starting at i (src[i] is the quote). Returns the inner
  // text. Advances i past the closing quote.
  function readString() {
    const q = src[i];
    i += 1;
    let out = '';
    while (i < n) {
      const c = src[i];
      if (c === '\\') { out += src[i + 1] ?? ''; i += 2; continue; }
      if (c === q) { i += 1; break; }
      out += c;
      i += 1;
    }
    return out;
  }

  // Skip a template literal `...` (with ${...} expressions). No extraction.
  function skipTemplate() {
    i += 1; // opening `
    while (i < n) {
      const c = src[i];
      if (c === '\\') { i += 2; continue; }
      if (c === '`') { i += 1; return; }
      if (c === '$' && src[i + 1] === '{') {
        i += 2;
        let depth = 1;
        while (i < n && depth > 0) {
          const d = src[i];
          if (d === '\\') { i += 2; continue; }
          if (d === '"' || d === "'") { readString(); continue; }
          if (d === '`') { skipTemplate(); continue; }
          if (d === '{') depth += 1;
          else if (d === '}') depth -= 1;
          i += 1;
        }
        continue;
      }
      i += 1;
    }
  }

  // Skip a regex literal /.../flags starting at i (src[i] === '/').
  function skipRegex() {
    i += 1;
    let inClass = false;
    while (i < n) {
      const c = src[i];
      if (c === '\\') { i += 2; continue; }
      if (c === '[') inClass = true;
      else if (c === ']') inClass = false;
      else if (c === '/' && !inClass) { i += 1; break; }
      else if (c === '\n') break; // unterminated; bail
      i += 1;
    }
    while (i < n && /[a-z]/.test(src[i])) i += 1; // flags
  }

  // Skip the balanced (...) span of a t( call (i is just after the '('). No
  // extraction: everything inside a t() is already translated.
  function skipBalancedParen() {
    let depth = 1;
    while (i < n && depth > 0) {
      const c = src[i];
      if (c === '\\') { i += 2; continue; }
      if (c === '"' || c === "'") { readString(); continue; }
      if (c === '`') { skipTemplate(); continue; }
      if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i += 1; continue; }
      if (c === '/' && src[i + 1] === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i += 1; i += 2; continue; }
      if (c === '(') depth += 1;
      else if (c === ')') depth -= 1;
      i += 1;
    }
  }

  // Skip a balanced {...} expression (used for attribute values like prop={...}).
  function skipBalancedBrace() {
    let depth = 1;
    i += 1; // opening {
    while (i < n && depth > 0) {
      const c = src[i];
      if (c === '\\') { i += 2; continue; }
      if (c === '"' || c === "'") { readString(); continue; }
      if (c === '`') { skipTemplate(); continue; }
      if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i += 1; continue; }
      if (c === '/' && src[i + 1] === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i += 1; i += 2; continue; }
      if (c === '{') depth += 1;
      else if (c === '}') depth -= 1;
      i += 1;
    }
  }

  // Parse from a '<' that starts JSX. Returns 'open' | 'selfclose' | 'close'.
  // Records flagged attribute string literals as candidates.
  function parseTag() {
    i += 1; // consume '<'
    if (src[i] === '/') { // closing tag </name>
      while (i < n && src[i] !== '>') i += 1;
      i += 1;
      return 'close';
    }
    if (src[i] === '>') { i += 1; return 'open'; } // fragment <>
    // element name
    while (i < n && (ID.test(src[i]) || src[i] === '.' || src[i] === '-')) i += 1;
    // attributes
    for (;;) {
      while (i < n && isSpace(src[i])) i += 1;
      if (i >= n) return 'open';
      if (src[i] === '/' && src[i + 1] === '>') { i += 2; return 'selfclose'; }
      if (src[i] === '>') { i += 1; return 'open'; }
      const before = i;
      if (src[i] === '{') {
        skipBalancedBrace(); // spread {...props}
      } else {
        const nameStart = i;
        while (i < n && (ID.test(src[i]) || src[i] === '-' || src[i] === ':')) i += 1;
        const attr = src.slice(nameStart, i);
        while (i < n && isSpace(src[i])) i += 1;
        if (src[i] === '=') {
          i += 1;
          while (i < n && isSpace(src[i])) i += 1;
          const c = src[i];
          if (c === '"' || c === "'") {
            const start = i;
            const val = readString();
            if (FLAGGED_ATTRS.has(attr)) candidates.push({ offset: start, kind: 'attr', attr, raw: val });
          } else if (c === '{') {
            const exprStart = i; // at '{'
            skipBalancedBrace();
            // A flagged attribute whose value is an EXPRESSION can still hide
            // un-t()'d prose, e.g. aria-label={open ? 'Close' : 'Open'}.
            if (FLAGGED_ATTRS.has(attr)) {
              const inner = src.slice(exprStart + 1, i - 1);
              for (const lit of exprStringLiterals(inner)) {
                candidates.push({ offset: exprStart, kind: 'attr', attr, raw: lit });
              }
            }
          } else {
            while (i < n && !isSpace(src[i]) && src[i] !== '>' && src[i] !== '/') i += 1;
          }
        }
        // boolean attribute (no '='): name already consumed
      }
      if (i === before) i += 1; // guarantee progress on any unexpected char
    }
  }

  while (i < n) {
    steps += 1;
    if (steps > MAX_STEPS) throw new Error(`scanSource exceeded ${MAX_STEPS} steps near offset ${i} (likely a lexer bug)`);
    if (top().t === 'el') {
      // JSX child text: collect until '<' or '{'
      const start = i;
      let buf = '';
      while (i < n && src[i] !== '<' && src[i] !== '{') { buf += src[i]; i += 1; }
      if (buf.trim()) candidates.push({ offset: start, kind: 'text', attr: null, raw: buf });
      if (i >= n) break;
      if (src[i] === '{') { stack.push({ t: 'js', brace: 0 }); i += 1; exprExpected = true; continue; }
      // src[i] === '<'
      const kind = parseTag();
      if (kind === 'open') stack.push({ t: 'el' });
      else if (kind === 'close') stack.pop();
      // selfclose: no stack change
      continue;
    }

    // JS mode
    const c = src[i];
    if (isSpace(c)) { i += 1; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i += 1; continue; }
    if (c === '/' && src[i + 1] === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i += 1; i += 2; continue; }
    if (c === '"' || c === "'") { readString(); exprExpected = false; continue; }
    if (c === '`') { skipTemplate(); exprExpected = false; continue; }
    if (c === '/' && exprExpected) { skipRegex(); exprExpected = false; continue; }

    // t( call
    if (c === 't' && !ID.test(src[i - 1] || '') && src[i - 1] !== '.') {
      let j = i + 1;
      while (j < n && isSpace(src[j])) j += 1;
      if (src[j] === '(') { i = j + 1; skipBalancedParen(); exprExpected = false; continue; }
    }

    // identifier / keyword
    if (ID.test(c) && !/[0-9]/.test(c)) {
      const s = i;
      while (i < n && ID.test(src[i])) i += 1;
      const word = src.slice(s, i);
      exprExpected = EXPR_KEYWORDS.has(word);
      continue;
    }
    if (/[0-9]/.test(c)) { while (i < n && /[0-9a-fA-FxXeE._]/.test(src[i])) i += 1; exprExpected = false; continue; }

    if (c === '<') {
      const nx = src[i + 1];
      if (exprExpected && nx && /[A-Za-z>]/.test(nx)) {
        const kind = parseTag();
        if (kind === 'open') { stack.push({ t: 'el' }); }
        // selfclose / close: stay in js
        exprExpected = false;
        continue;
      }
      i += 1; exprExpected = true; continue; // comparison operator
    }

    if (c === '{') { top().brace += 1; i += 1; exprExpected = true; continue; }
    if (c === '}') {
      if (top().brace > 0) { top().brace -= 1; i += 1; exprExpected = false; }
      else { stack.pop(); i += 1; exprExpected = false; } // closes a {expr} container
      continue;
    }
    if (c === '=' && src[i + 1] === '>') { i += 2; exprExpected = true; continue; } // arrow

    // punctuation: set exprExpected by class
    if ('([,;:?=&|!+-*%^~'.includes(c)) { i += 1; exprExpected = true; continue; }
    if (')]'.includes(c)) { i += 1; exprExpected = false; continue; }
    if (c === '.') { i += 1; exprExpected = false; continue; }
    i += 1; // anything else
  }

  return candidates;
}

// Compute 1-based line numbers for offender reporting.
export function lineOf(src, offset) {
  let line = 1;
  for (let k = 0; k < offset && k < src.length; k += 1) if (src[k] === '\n') line += 1;
  return line;
}

export function findOffenders(src) {
  return scanSource(src)
    .filter(isOffender)
    .map((c) => ({ line: lineOf(src, c.offset), kind: c.kind, attr: c.attr, text: c.raw.trim() }));
}
