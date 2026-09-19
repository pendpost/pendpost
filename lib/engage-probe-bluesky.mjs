// lib/engage-probe-bluesky.mjs - the ONE liveness probe bluesky was missing (spec 50 §7.6).
//
// WHY THIS EXISTS AS ITS OWN FILE. Every other engage lane answers its platform check through
// lib/health.mjs's probeAll(), which spawns that lane's engine `probe` verb. bluesky has no such
// verb: scripts/bluesky-social.mjs is a search-and-reply engine, deliberately absent from the
// publish lane registry (its own header explains why), so health.mjs has nothing to spawn. P2
// therefore reported bluesky as permanently un-probeable, which meant a platform the owner could
// switch ON and that could never turn green - every bluesky row would sit on waitingOn:'lane'
// with no control anywhere to fix it.
//
// The proof was always available; nothing had asked for it. An app password mints a session
// (com.atproto.server.createSession) and the session reads its own profile back
// (app.bsky.actor.getProfile). Two READS. Nothing is posted, liked, followed or written - which
// is the whole contract of a probe, and the reason this can run on the owner's "Check again"
// button without a confirm.
//
// It is a separate module rather than a branch inside lib/health.mjs because health.mjs is the
// PUBLISH-lane health bar and bluesky is not a publish lane there; adding it would put a lane in
// the Setup health list that the Composer cannot target. One narrow probe for one narrow caller.
import { readEnv } from './util.mjs';
import { radarHttp } from './radar.mjs';

// { ok, handle, detail }. NEVER throws (the P9 posture every probe in this repo keeps): a dead
// network, a refused password and a missing credential are three different sentences, all
// returned rather than raised.
export async function blueskyProbe() {
  const identifier = readEnv('BLUESKY_IDENTIFIER') || readEnv('BLUESKY_HANDLE');
  const password = readEnv('BLUESKY_APP_PASSWORD');
  if (!identifier || !password) {
    return { ok: false, handle: '', detail: 'no Bluesky app password is stored here - set BLUESKY_IDENTIFIER and BLUESKY_APP_PASSWORD (an app password from bsky.app settings, never the account password)' };
  }
  const pds = (readEnv('BLUESKY_PDS_URL') || 'https://bsky.social').replace(/\/+$/, '');
  const sess = await radarHttp(`${pds}/xrpc/com.atproto.server.createSession`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier, password }),
  });
  if (!sess.ok || !sess.json || !sess.json.accessJwt) {
    const said = (sess.json && (sess.json.message || sess.json.error)) || sess.error || (sess.status ? `HTTP ${sess.status}` : 'no answer');
    return { ok: false, handle: '', detail: `Bluesky refused the app password: ${String(said).slice(0, 200)}` };
  }
  // The session alone already proves the credential. The profile read is what makes the probe
  // able to REPORT WHICH ACCOUNT it authenticated as - the same fact the browser lanes get from
  // their identity check, and what row 2e2's handle confirmation reads.
  const who = sess.json.handle || identifier;
  const profile = await radarHttp(`${pds}/xrpc/app.bsky.actor.getProfile?${new URLSearchParams({ actor: sess.json.did || who }).toString()}`, {
    headers: { Authorization: `Bearer ${sess.json.accessJwt}` },
  });
  if (!profile.ok) {
    const said = (profile.json && (profile.json.message || profile.json.error)) || profile.error || `HTTP ${profile.status}`;
    return { ok: false, handle: who, detail: `signed in as @${who}, but the profile read failed: ${String(said).slice(0, 200)}` };
  }
  const handle = (profile.json && profile.json.handle) || who;
  return { ok: true, handle, detail: `signed in as @${handle}` };
}
