// The ONE guard every client-switch path runs before re-scoping the app
// (sidebar ClientSwitcher and the Cmd-K palette both call it - never duplicate
// this logic per path). Rationale (ux-audit-2026-08-04, dim 4 gap 1): switching
// the active client while the Composer holds a dirty draft used to silently
// re-scope the app but keep the form state, so Save posted the draft into the
// WRONG client's identically-named campaign - the exact anti-goal of
// docs/specs/multi-client.md. Contract:
//   - clean composer (or no composer open): resolve true, no dialog;
//   - dirty composer: confirm the discard; cancel resolves false (stay put),
//     confirm discards the composer state FIRST, then resolves true so the
//     caller may switch.
export function makeClientSwitchGuard({ isComposerDirty, confirmDiscard, discardComposer }) {
  return async () => {
    if (!isComposerDirty()) return true;
    if (!(await confirmDiscard())) return false;
    discardComposer();
    return true;
  };
}
