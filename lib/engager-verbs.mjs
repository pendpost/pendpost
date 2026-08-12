// engager-verbs.mjs - the ONE engine layer for relationship-memory (spec 49 R12) reads and
// owner-driven writes, wrapping the PURE lib/engagers.mjs store with loadState/saveState so
// BOTH faces (the MCP tools in lib/mcp.mjs and the REST twins in lib/api.mjs) call exactly
// this. That is the spec's "one source of truth - the two faces cannot drift": neither face
// re-implements the load/mutate/save dance or the confirm posture; they both call the verbs
// below and return the identical envelope.
//
// Every verb runs UNDER the caller's withClient() binding (MCP callTool + REST handleApi both
// scope the active brand before dispatch), so loadState()/saveState() land in the active
// brand's state.json. The person-graph is per-brand and never leaves the disk (the feature).
//
// Read is NEVER gated here: the operator's GUI popover and REST reads always answer. The
// agent-read opt-in (posting.relationshipMemory.agentRead) gates only the MCP list_engagers
// tool, and that gate lives at the MCP dispatch (lib/mcp.mjs) so a REST read is never touched.
//
// The confirm posture for the destructive-ish verbs (forget, unlink) lives HERE, inside the
// verb, exactly like moderateComment's destructive gate - so the MCP tool AND the REST twin
// AND the GUI's inline confirm can never drift. There is NO merge verb, ever: link/unlink
// operate on state.engagerLink[] only and never touch the two underlying records.
import { loadState, saveState } from './state.mjs';
import { errorBody } from './util.mjs';
import {
  engagerKey, readEngager, linkSuggestions,
  forgetEngager, unforgetEngager, linkEngagers, unlinkEngagers, dismissLinkGuess,
} from './engagers.mjs';

function isPlainObj(o) {
  return Boolean(o) && typeof o === 'object' && !Array.isArray(o);
}

// The confirmed same-person links (state.engagerLink[]) that touch `key` - the joined-history
// association (S4c/S4j). Returns [] on any corruption or a null key.
function linksFor(state, key) {
  if (!key || !Array.isArray(state.engagerLink)) return [];
  return state.engagerLink.filter((l) => l && (l.a === key || l.b === key));
}

// READ (S8; the popover's + agent's data). One source of truth for both faces:
//   - lane+handle given  -> the single person: { ok, key, engager: record|tombstone|null,
//     suggestions: LinkSuggestion[], links: EngagerLink[] } (the shape the GUI popover renders).
//   - lane/handle omitted -> the full brand list: { ok, engagers: [{ key, ...record }], links }.
//     Unbounded storage (Q2); `limit` bounds only the DISPLAYED window, never what is stored.
// Never throws: a corrupt store degrades to an empty answer (the chip is simply absent).
export function readEngagers({ lane, handle, limit } = {}) {
  const state = loadState();
  const map = isPlainObj(state.engagers) ? state.engagers : {};
  const allLinks = Array.isArray(state.engagerLink) ? state.engagerLink : [];
  const haveLane = lane != null && String(lane).trim() !== '';
  const haveHandle = handle != null && String(handle).trim() !== '';
  if (haveLane && haveHandle) {
    const key = engagerKey(lane, handle);
    const engager = key ? readEngager(state, lane, handle) : null;
    const suggestions = key ? linkSuggestions(state, key) : [];
    const links = key ? linksFor(state, key) : [];
    return { ok: true, key, engager, suggestions, links };
  }
  let engagers = Object.entries(map).map(([key, rec]) => ({ key, ...(isPlainObj(rec) ? rec : { value: rec }) }));
  if (Number.isInteger(limit) && limit > 0) engagers = engagers.slice(0, limit);
  return { ok: true, engagers, links: allLinks };
}

// FORGET (S6) - CONFIRM-gated (the privacy erase is deliberate, never one-click). Replaces the
// record with a minimal keyed tombstone; future accretion for the key is suppressed. Requires
// confirm:true for EVERY actor (the GUI posts it after its inline ForgetConfirm), mirroring the
// destructive-moderate posture. Returns the shared error envelope on a bad key / missing confirm.
export function forgetEngagerVerb({ lane, handle, confirm } = {}) {
  const key = engagerKey(lane, handle);
  if (!key) return errorBody('invalid_input', 'lane and handle are required to forget a person');
  if (confirm !== true) {
    return errorBody('needs_confirm', 'forget erases this person\'s local history and cannot be undone - pass confirm: true (the GUI confirms inline first)');
  }
  const state = loadState();
  forgetEngager(state, key);
  saveState();
  return { ok: true, key, forgotten: true };
}

// UN-FORGET (S6u) - restorative, NO confirm (it only clears the tombstone so accretion resumes
// from zero; it never resurrects the erased history). A no-op on a key that is not a tombstone.
export function unforgetEngagerVerb({ lane, handle } = {}) {
  const key = engagerKey(lane, handle);
  if (!key) return errorBody('invalid_input', 'lane and handle are required to un-forget a person');
  const state = loadState();
  unforgetEngager(state, key);
  saveState();
  return { ok: true, key };
}

// Resolve an { lane, handle } endpoint to a key, or null if unkeyable.
function pairKeys(a, b) {
  const ka = engagerKey(a && a.lane, a && a.handle);
  const kb = engagerKey(b && b.lane, b && b.handle);
  return { ka, kb };
}

// LINK (S4c) - store an operator-confirmed same-person association. NOT a merge: both records
// stay separate and independently forgettable; the link only makes them PRESENT as one joined
// history. Additive/restorative, NO confirm. Idempotent (a pair is never double-stored).
export function linkEngagersVerb({ a, b } = {}) {
  const { ka, kb } = pairKeys(a, b);
  if (!ka || !kb) return errorBody('invalid_input', 'a and b each need a lane and handle to link two people');
  if (ka === kb) return errorBody('invalid_input', 'a and b are the same person - nothing to link');
  const state = loadState();
  linkEngagers(state, ka, kb);
  saveState();
  return { ok: true, a: ka, b: kb, linked: true };
}

// UN-LINK (S4u) - CONFIRM-gated (it removes an operator decision). LOSSLESS by construction:
// nothing was ever merged, so both underlying records are byte-identical to before the link.
export function unlinkEngagersVerb({ a, b, confirm } = {}) {
  const { ka, kb } = pairKeys(a, b);
  if (!ka || !kb) return errorBody('invalid_input', 'a and b each need a lane and handle to un-link two people');
  if (confirm !== true) {
    return errorBody('needs_confirm', 'un-link removes an operator-confirmed same-person link - pass confirm: true (it is lossless; nothing was merged)');
  }
  const state = loadState();
  unlinkEngagers(state, ka, kb);
  saveState();
  return { ok: true, a: ka, b: kb, unlinked: true };
}

// DISMISS-LINK (S4) - GUI/REST-only (no MCP twin): record that the operator dismissed a
// cross-lane GUESS for a pair so linkSuggestions stops re-surfacing it. Idempotent, no confirm.
export function dismissLinkVerb({ a, b } = {}) {
  const { ka, kb } = pairKeys(a, b);
  if (!ka || !kb) return errorBody('invalid_input', 'a and b each need a lane and handle to dismiss a cross-lane guess');
  if (ka === kb) return errorBody('invalid_input', 'a and b are the same person - nothing to dismiss');
  const state = loadState();
  dismissLinkGuess(state, ka, kb);
  saveState();
  return { ok: true, a: ka, b: kb, dismissed: true };
}
