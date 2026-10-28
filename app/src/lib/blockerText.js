// One preflight problem in the owner's language. The engine sends each problem twice:
// an English line (problems[i], for agents and the "?") and, where it has one, a machine
// code with params (problemCodes[i] = { code, params }). The Studio's copy for a code
// lives under `blockers.<code>` (e.g. blockers.validate.igImageUrlMissing); a code whose
// copy ships under its own name (validate.<name>) is read as-is. Shared by the blockers
// panel (ui.jsx PlatformBlockers) and the approve refusal sentence (failureCopy not_ready),
// so the two can never word one problem differently.

// The localized sentence for a problem code, or null when the Studio has no copy for it.
// A brand-lint rule's human name: the localized name of a built-in rule (lint.rule.<id>),
// else the id made readable ("my-own-rule" -> "My own rule"). Never the raw slug.
export function lintRuleName(t, id) {
  if (typeof id !== 'string' || !id) return '';
  const key = `lint.rule.${id}`;
  const name = t(key);
  if (name && name !== key) return name;
  const words = id.replace(/[-_]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function problemCodeText(t, code) {
  if (!code || typeof code.code !== 'string') return null;
  const params = { ...(code.params || {}) };
  if (typeof params.rule === 'string') params.rule = lintRuleName(t, params.rule);
  // A YouTube category id reads as its localized name (youtube.category.<id>), not the
  // engine's English label.
  if (params.youtubeCategoryId) {
    const key = `youtube.category.${params.youtubeCategoryId}`;
    const name = t(key);
    if (name && name !== key) params.category = name;
  }
  // A per-platform text problem names the field the owner will actually see: without an
  // override of its own (params.override === false) the shared post text is what to shorten,
  // so a `<key>.shared` variant is preferred when the pack has one.
  const keys = [`blockers.${code.code}`, code.code];
  if (params.override === false) keys.unshift(`blockers.${code.code}.shared`);
  for (const key of keys) {
    const s = t(key, params);
    if (s && s !== key) return s;
  }
  return null;
}

// The row text: the localized sentence when there is one, else the engine's own line.
export function validateRowText(t, problem, code) {
  return problemCodeText(t, code) || problem;
}

// Which ONE action recovers a set of preflight problems, from the engine's per-problem
// `fix` (problemCodes[i].fix): 'edit' -> the editor, 'setup' -> Setup, 'wait' and
// 'publish-media' -> no button (nothing the owner fixes here; the copy explains the step).
// A problem without a fix keeps the long-standing default, the editor. Setup wins over
// Edit (a lane that is not ready cannot publish whatever the content says), and nothing
// actionable returns null, so the surface shows no dead button.
const FIX_RECOVERY = { edit: 'edit', setup: 'setup', wait: null, 'publish-media': null };
export function recoveryFor(problems, problemCodes) {
  const recs = (problems || []).map((_, i) => {
    const fix = problemCodes?.[i]?.fix;
    if (typeof fix !== 'string') return 'edit';
    return Object.prototype.hasOwnProperty.call(FIX_RECOVERY, fix) ? FIX_RECOVERY[fix] : null;
  });
  if (recs.includes('setup')) return 'setup';
  if (recs.includes('edit')) return 'edit';
  return null;
}
