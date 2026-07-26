import { useQuery, useQueryClient } from '@tanstack/react-query';

async function getJson(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

export function usePlans() {
  return useQuery({
    queryKey: ['plans'],
    queryFn: () => getJson('/api/plans'),
    refetchInterval: 30_000,
  });
}

export function useAccounts() {
  return useQuery({
    queryKey: ['accounts'],
    queryFn: () => getJson('/api/accounts'),
    refetchInterval: 60_000,
  });
}

// Dashboard build status (GET /api/health -> buildId, building) for the in-app
// updater. Polled on a short interval so a background rebuild's new bundle is
// noticed promptly; the payload is tiny. refetchIntervalInBackground keeps the
// poll alive when the dashboard is an unfocused tab/window - an updater is most
// useful precisely when you have left it open in the background.
export function useBuildStatus() {
  return useQuery({
    queryKey: ['health'],
    queryFn: () => getJson('/api/health'),
    refetchInterval: 15_000,
    refetchIntervalInBackground: true,
  });
}

export function useAssets(enabled) {
  return useQuery({
    queryKey: ['assets'],
    queryFn: () => getJson('/api/assets'),
    enabled,
    staleTime: 5 * 60_000,
  });
}

export function useActivity(enabled) {
  return useQuery({
    queryKey: ['activity'],
    queryFn: () => getJson('/api/activity?limit=500'),
    enabled,
    refetchInterval: 15_000,
  });
}

export function useInsights(enabled) {
  return useQuery({
    queryKey: ['insights'],
    queryFn: () => getJson('/api/insights'),
    enabled,
    refetchInterval: 60_000,
  });
}

export function useDigest(enabled) {
  return useQuery({
    queryKey: ['digest'],
    queryFn: () => getJson('/api/digest'),
    enabled,
    staleTime: 60_000,
  });
}

export function useConfig(enabled) {
  return useQuery({
    queryKey: ['config'],
    queryFn: () => getJson('/api/config'),
    enabled,
    staleTime: 30_000,
  });
}

// One-call readiness (US-ONB-05): { ok, ready, schedulerRunning, blockers[],
// nextDue[] } from GET /api/pendpost-health (lib/writes.mjs pendpostHealth). Read-only
// and client-scoped server-side; the checklist renders blockers as actionable steps.
export function usePendpostHealth(enabled) {
  return useQuery({
    queryKey: ['pendpost-health'],
    queryFn: () => getJson('/api/pendpost-health'),
    enabled,
    refetchInterval: 60_000,
  });
}

// Read-only per-platform publish readiness (B2): { ok, postId, platforms:{<p>:
// {ready, problems[], warnings[]}} } from GET /api/plans/<c>/posts/<id>/platform-validate
// (lib/writes.mjs platformValidate). Surfaced as advisory blocker rows in
// PostDetail/Composer so the owner learns of a bad post before publish, never at
// publish - read-only, never writes, never pokes a lane. enabled-gated and keyed
// per campaign+postId so it refetches per post and a client switch invalidates it.
// H3: `rev` (post.rev, a content hash of the raw post) is folded into the key so a
// cached verdict is STRUCTURALLY unable to be older than the post it describes. Before
// it, switching a post's type left the previous type's blockers on screen for up to the
// 30s staleTime. Fixing the KEY rather than the callers also covers an MCP-side edit
// (plan_update_post), which changes the post with no client mutation to hang an
// invalidateQueries call off at all. staleTime stays: a stale read of the SAME rev is
// still correct.
export function usePlatformValidate(campaign, postId, enabled = true, rev = null) {
  return useQuery({
    queryKey: ['platform-validate', campaign, postId, rev || null],
    queryFn: () => getJson(`/api/plans/${campaign}/posts/${postId}/platform-validate`),
    enabled: enabled && Boolean(campaign) && Boolean(postId),
    staleTime: 30_000,
  });
}

// Pre-submit validation reads (spec 09, Pattern P3/P4 read): a post's reddit/tiktok
// platform-specific submission rules, from GET /api/plans/<c>/posts/<id>/presubmit
// (lib/writes.mjs presubmitCheck). Modeled on usePlatformValidate - enabled-gated,
// keyed per campaign+postId, and merged into the SAME PlatformBlockers panel (one
// panel, two sources) so the owner learns of a subreddit/creator-rule violation
// before publish, never at publish. Only reddit/tiktok posts return an entry.
export function usePresubmitCheck(campaign, postId, enabled = true, rev = null) {
  return useQuery({
    queryKey: ['presubmit-check', campaign, postId, rev || null],
    queryFn: () => getJson(`/api/plans/${campaign}/posts/${postId}/presubmit`),
    enabled: enabled && Boolean(campaign) && Boolean(postId),
    staleTime: 30_000,
  });
}

// The inbound-engagement (inbox) seam (spec 02, Pattern P6): the normalized
// comments on one POSTED post from GET /api/comments (lib/writes.mjs listComments).
// Always resolves 200 with a structured body ({ ok, items, platform, needsScope?,
// scope?, error? }) so the PostDetail thread panel renders an honest state (populated
// / empty / needs-scope / error) rather than a thrown query error. Keyed per
// campaign+postId so it refetches per post; a client switch invalidates ['comments'].
// enabled-gated so it only fetches once the panel is opened on a posted post.
export function useComments(campaign, postId, enabled = true) {
  return useQuery({
    queryKey: ['comments', campaign, postId],
    queryFn: () => getJson(`/api/comments?campaign=${encodeURIComponent(campaign)}&postId=${encodeURIComponent(postId)}`),
    enabled: enabled && Boolean(campaign) && Boolean(postId),
    staleTime: 15_000,
  });
}

// GBP reviews (spec 03, Pattern P6 engagement): the location's Google Business reviews
// from GET /api/reviews (lib/writes.mjs listReviews). Always resolves 200 with a
// structured body ({ ok, items, averageRating, totalReviewCount, needsScope?, scope?,
// error? }) so the Activity reviews inbox renders an honest state (populated / empty /
// needs-scope / error) rather than a thrown query error. Reading also logs any NEW
// review as a review-received Activity entry server-side. enabled-gated so it only
// fetches when the inbox chip is open; a client switch invalidates ['reviews'].
// Pull-on-demand (staleTime only, NO refetchInterval - mirrors useComments): each read
// spawns a gbp subprocess and the Business Profile API quota is tight, so reviews refresh
// when the inbox is (re)opened, never on a background timer.
export function useReviews(enabled = true) {
  return useQuery({
    queryKey: ['reviews'],
    queryFn: () => getJson('/api/reviews'),
    enabled,
    staleTime: 15_000,
  });
}

// The Radar (beta) listening seam (spec 32, Pattern P4-read): the cached, scored
// signal feed from GET /api/radar (lib/writes.mjs listRadar). A PURE cache read (it
// never scans) so it always resolves 200 with a structured body ({ ok, enabled,
// items:[Signal], lastScan, capabilities }); the Radar panel renders an honest state
// (disabled / empty / populated) rather than a thrown query error. Pull-on-demand
// (staleTime only, mirrors useReviews) - the feed refreshes when the panel (re)mounts
// or after an explicit Scan now; a client switch invalidates ['radar'].
// Spec 41: while an agent job is RUNNING the feed also carries live progress, so it polls -
// but only then. An idle Radar keeps its pull-on-demand cost, and the moment the job settles
// the poll stops on its own (the predicate re-reads the last response's jobs[]). This is the
// same signal an agent or a second tab sees, so the row can never disagree with the truth.
const jobRunning = (data) => (data?.jobs || []).some((j) => j.state === 'running');
// `forcePoll` (the pre-first-poll gap): the predicate below reads the LAST response's jobs[],
// which at the instant Scan is pressed still shows nothing running - so the row a running job
// paints would never appear until the multi-minute scan POST settled. The panel passes its own
// in-flight flag to bridge exactly that window; the server's jobs[] takes over on the first hit.
export function useSignals(enabled = true, forcePoll = false) {
  return useQuery({
    queryKey: ['radar'],
    queryFn: () => getJson('/api/radar'),
    enabled,
    staleTime: 15_000,
    refetchInterval: (query) => (forcePoll || jobRunning(query.state.data) ? 3_000 : false),
    // A research job runs for minutes; the operator will not sit and watch it, and the whole
    // point of the row is that they can come back to a finished answer.
    refetchIntervalInBackground: true,
  });
}

// Connected-account discovery (spec 22, Pattern P4-read): who a connected lane
// authenticates as + which assets it can manage, from GET /api/accounts/<platform>/discover
// (lib/writes.mjs connectDiscover). Always resolves 200 with a structured body
// ({ ok, platform, connected, identity, assets, selected, needsScope?, scope?, error? })
// so the Setup DiscoveryBlock renders an honest state (single / multi / empty /
// needs-scope / error) rather than a thrown query error. Client-scoped server-side;
// keyed per platform so it refetches per card and a client switch invalidates ['discover'].
export function useDiscover(platform, enabled = true) {
  return useQuery({
    queryKey: ['discover', platform],
    queryFn: () => getJson(`/api/accounts/${encodeURIComponent(platform)}/discover`),
    enabled: enabled && Boolean(platform),
    staleTime: 30_000,
  });
}

// YouTube playlists (spec 15, Pattern P3+P4): this channel's playlists for the
// PostDetail "Add to playlist" picker, from GET /api/youtube/playlists
// (lib/writes.mjs listYoutubePlaylists). Always resolves 200 with a structured
// body ({ ok, platform, playlists, needsScope?, scope? }) so the picker renders an
// honest state (populated / empty / needs-scope) rather than a thrown query error.
export function useYoutubePlaylists(enabled = true) {
  return useQuery({
    queryKey: ['youtube-playlists'],
    queryFn: () => getJson('/api/youtube/playlists'),
    enabled,
    staleTime: 30_000,
  });
}

// Reddit flairs (spec 16, Pattern P3+P4): a subreddit's link-flair templates for the
// Composer flair picker, from GET /api/reddit/flairs (lib/writes.mjs listRedditFlairs).
// Always resolves 200 with a structured body ({ ok, subreddit, items } on success, or
// { ok:false, error } on a scope-absent/not-configured/failed read) so the picker renders
// an honest state (populated / empty / unavailable). Keyed per subreddit so it refetches
// per target; enabled-gated so it only fetches when reddit is actually being authored.
export function useRedditFlairs(subreddit, enabled = true) {
  return useQuery({
    queryKey: ['reddit-flairs', subreddit || ''],
    queryFn: () => getJson(`/api/reddit/flairs${subreddit ? `?subreddit=${encodeURIComponent(subreddit)}` : ''}`),
    enabled,
    staleTime: 30_000,
  });
}

// Pinterest board sections (spec 17, Pattern P3+P4): a board's sections for the
// Composer section picker, from GET /api/pinterest/board-sections (lib/writes.mjs
// listPinterestBoardSections). Always resolves a structured body ({ ok, boardId,
// items } on success, or { ok:false, error } on a scope-absent/not-configured/failed
// read) so the picker renders an honest state (populated / empty / unavailable).
// Keyed per board so it refetches per target; enabled-gated so it only fetches when
// pinterest is actually being authored.
export function usePinterestBoardSections(boardId, enabled = true) {
  return useQuery({
    queryKey: ['pinterest-board-sections', boardId || ''],
    queryFn: () => getJson(`/api/pinterest/board-sections${boardId ? `?boardId=${encodeURIComponent(boardId)}` : ''}`),
    enabled,
    staleTime: 30_000,
  });
}

// Pinterest boards (spec 29, Pattern P3+P4): this account's boards ({id,name,
// privacy,pinCount} + the connected `current` PINTEREST_BOARD_ID) for Setup's
// BoardManager panel, from GET /api/pinterest/boards (lib/writes.mjs
// listPinterestBoards). Shares the SAME read spec 22 discover uses under the
// hood (no drift). Always resolves a structured body ({ ok, boards, current }
// on success, or { ok:false, error } on a failed read) so the panel renders an
// honest state (populated / empty / unavailable) rather than a thrown query
// error. MOUNT-gated, not enabled-gated (spec 29 review, NIT-7): `enabled`
// defaults to true here (mirrors useReviews/useGbpMedia's pull-on-demand
// shape) - it only fetches once BoardManager itself mounts, which happens
// only when the connected Pinterest card is expanded.
export function useBoards(enabled = true) {
  return useQuery({
    queryKey: ['pinterest-boards'],
    queryFn: () => getJson('/api/pinterest/boards'),
    enabled,
    staleTime: 30_000,
  });
}

// GBP location media gallery (spec 19, account management, Pattern P4 read): the
// connected location's Business Profile photo/video gallery, from GET /api/gbp/media
// (lib/writes.mjs listGbpMedia). Always resolves 200 with a structured body ({ ok,
// items, needsScope?, scope?, error? }) so the Setup gallery panel renders an honest
// state (populated / empty / needs-scope / error) rather than a thrown query error.
// Pull-on-demand (staleTime only, mirrors useReviews) - each read spawns a gbp
// subprocess and the Business Profile API quota is tight.
export function useGbpMedia(enabled = true) {
  return useQuery({
    queryKey: ['gbp-media'],
    queryFn: () => getJson('/api/gbp/media'),
    enabled,
    staleTime: 30_000,
  });
}

// GBP location attributes (spec 19, account management, Pattern P4 read): the
// connected location's current Business Profile attributes, from GET /api/gbp/attributes
// (lib/writes.mjs getGbpAttributes). Same honest-state contract as useGbpMedia.
export function useGbpAttributes(enabled = true) {
  return useQuery({
    queryKey: ['gbp-attributes'],
    queryFn: () => getJson('/api/gbp/attributes'),
    enabled,
    staleTime: 30_000,
  });
}

// Ghost members + newsletters (spec 30, account management, Pattern P3+P4 read):
// the connected Ghost site's member list + free/paid/comped tally, from GET
// /api/ghost/members (lib/writes.mjs ghostMembers). Always resolves 200 with a
// structured body ({ ok, counts, items } on success, or { ok:false, code, error }
// on a not_configured/failed read) so the Setup audience block renders an honest
// state (populated / empty / not-connected / error) rather than a thrown query
// error. Pull-on-demand (staleTime only, mirrors useGbpMedia) - each read spawns
// a ghost subprocess. "Audience" is deliberately ONE hook name covering both
// reads (members + newsletters) - a single home for the Ghost card's account
// block, mirroring how GbpLocationControls fetches gallery+attributes together.
export function useGhostMembers(enabled = true) {
  return useQuery({
    queryKey: ['ghost-members'],
    queryFn: () => getJson('/api/ghost/members'),
    enabled,
    staleTime: 30_000,
  });
}

// Ghost members + newsletters (spec 30, Pattern P3+P4 read): the connected Ghost
// site's newsletter roster, from GET /api/ghost/newsletters (lib/writes.mjs
// ghostNewsletters) - the SAME read spec 01's publish-time newsletter resolution
// makes. Same honest-state contract as useGhostMembers.
export function useGhostNewsletters(enabled = true) {
  return useQuery({
    queryKey: ['ghost-newsletters'],
    queryFn: () => getJson('/api/ghost/newsletters'),
    enabled,
    staleTime: 30_000,
  });
}

// Read-only media spec-check (B2): { ok, media, probe, checks:{resolution,
// codecOk, faststart} } from GET /api/plans/<c>/posts/<id>/validate-media
// (lib/writes.mjs validateMedia). The checks surface as advisory rows (wrong
// resolution / no faststart / codec) - never blocking, never auto-retrying.
export function useValidateMedia(campaign, postId, enabled = true, rev = null) {
  return useQuery({
    queryKey: ['validate-media', campaign, postId, rev || null],
    queryFn: () => getJson(`/api/plans/${campaign}/posts/${postId}/validate-media`),
    enabled: enabled && Boolean(campaign) && Boolean(postId),
    staleTime: 30_000,
  });
}

// --- Multi-client (LOCAL, in-core) ---------------------------------------
// The active client scopes every other call server-side; these read the
// registry ({ activeClientId, clients:[{id,displayName,status,timezone?,accent?,logo?}] }).
export function useClients() {
  return useQuery({
    queryKey: ['clients'],
    queryFn: () => getJson('/api/clients'),
    staleTime: 30_000,
  });
}

// C4: read-only cross-client roll-up ({ activeClientId, clients:[{id,displayName,
// status,ready,schedulerRunning,pending,overdue,metaBlocked,nextDue,error}] })
// from GET /api/clients/overview (lib/writes.mjs clientsOverview). The server
// iterates the registry and scopes each row internally, so this is NOT
// client-scoped: it is a registry-wide read that does not refetch on a client
// switch. Booleans + counts only - never a 368's blockedUntil/reason/secret.
export function useClientsOverview() {
  return useQuery({
    queryKey: ['clients-overview'],
    queryFn: () => getJson('/api/clients/overview'),
    staleTime: 30_000,
  });
}

// Convenience selector over useClients(): the resolved active client object
// (or null while loading / if the active id is not in the list).
export function useActiveClient() {
  const q = useClients();
  const data = q.data;
  const active = data?.clients?.find((c) => c.id === data.activeClientId) || null;
  return { ...q, activeClient: active, activeClientId: data?.activeClientId || null };
}

// Switching the active client re-scopes every server read, so the cached data
// of every client-scoped page must be invalidated to refetch under the new
// client. Returns a function the switcher awaits.
export function useSetActiveClient() {
  const queryClient = useQueryClient();
  return async (id) => {
    const data = await setActiveClient(id);
    queryClient.invalidateQueries({ queryKey: ['clients'] });
    for (const key of CLIENT_SCOPED_KEYS) {
      // Most entries are a single-segment prefix (e.g. 'plans' -> ['plans']), matching
      // every query whose key starts with it. A few (e.g. the cloud inbound-events feed)
      // need a two-segment prefix so switching client does NOT also invalidate the
      // workspace-wide cloud queries (['cloud'], ['cloud','clients'], etc.) that are
      // NOT client-scoped - so those entries carry their full key array instead.
      queryClient.invalidateQueries({ queryKey: Array.isArray(key) ? key : [key] });
    }
    return data;
  };
}

// Every query key whose data is scoped to the active client on the server.
// Switching client or a client write (create/update/archive that flips the
// active one) invalidates all of these so no stale client's data lingers. Most
// entries are a plain string (the query's first key segment); an entry may also be a
// full key array (['cloud','events']) when only invalidating that exact key - not its
// whole namespace - is correct (spec 23: the inbound-events feed is client-scoped, but
// its cloud.js siblings ['cloud'], ['cloud','clients'], ['cloud','capabilities'],
// ['cloud','subscription'] are workspace-wide and must NOT refetch on a client switch).
const CLIENT_SCOPED_KEYS = ['plans', 'accounts', 'activity', 'insights', 'assets', 'config', 'digest', 'pendpost-health', 'platform-validate', 'validate-media', 'comments', 'reviews', 'discover', 'presubmit-check', 'youtube-playlists', 'reddit-flairs', 'pinterest-board-sections', 'pinterest-boards', 'gbp-media', 'gbp-attributes', 'ghost-members', 'ghost-newsletters', 'radar', ['cloud', 'events']];

async function sendJson(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || `${path}: HTTP ${res.status}`);
    err.code = data.code;
    // The finer discriminator some writes carry alongside a stable code (e.g. spec 06
    // moderate returns code:'invalid_input' with error:'unsupported_action').
    if (data.error) err.error = data.error;
    throw err;
  }
  return data;
}

const postJson = (path, body) => sendJson('POST', path, body);

// The pendpost UI always acts as the owner - they are its only user. Agents use
// the MCP face with their own actor strings.
const ACTOR = 'owner';

// The human "Check now" click (App.jsx) is the confirmation, so post
// confirm:true to satisfy the server's fail-closed needs_confirm gate. An
// optional scope { campaign, postId } narrows the run to a single post (the
// planner run-now review dialog loops it over the selected posts); omitting it
// publishes every due post, the original Activity-sweep behavior.
export const runPublishDue = (scope = {}) => postJson('/api/run/publish-due', { actor: 'ui', confirm: true, ...scope });
export const setSchedulerRunning = (running) => postJson('/api/scheduler', { running });

// --- Client admin (operator-only; mirrors the other write helpers) ---------
export const getClients = () => getJson('/api/clients');
export const setActiveClient = (id) => postJson('/api/clients/active', { id, actor: ACTOR });
export const createClient = (body) => postJson('/api/clients', { ...body, actor: ACTOR });
export const updateClient = (id, body) => sendJson('PATCH', `/api/clients/${id}`, { ...body, actor: ACTOR });
export const archiveClient = (id) => postJson(`/api/clients/${id}/archive`, { actor: ACTOR });

// --- Phase D write matrix ---
// Create a campaign (US-ONB-04): the first-run empty-state's primary action.
// body = { id, note?, timezone? }; maps to campaign_create / POST /api/campaigns.
export const createCampaign = (body) => postJson('/api/campaigns', { ...body, actor: ACTOR });
// Operator-only "hide from views" flag; maps to campaign_set_internal.
export const setCampaignInternal = (id, internal) => postJson(`/api/campaigns/${id}/internal`, { internal, actor: ACTOR });
export const createPost = (campaign, post) => postJson(`/api/plans/${campaign}/posts`, { post, actor: ACTOR });
export const updatePost = (campaign, postId, ifRev, fields) => sendJson('PATCH', `/api/plans/${campaign}/posts/${postId}`, { ifRev, fields, actor: ACTOR });
export const deletePost = (campaign, postId, force = false) => sendJson('DELETE', `/api/plans/${campaign}/posts/${postId}`, { force, actor: ACTOR });
export const approvePost = (campaign, postId, note) => postJson(`/api/plans/${campaign}/posts/${postId}/approve`, { actor: ACTOR, note });
export const rejectPost = (campaign, postId, note) => postJson(`/api/plans/${campaign}/posts/${postId}/reject`, { actor: ACTOR, note });
export const unschedulePost = (campaign, postId, confirm = false) => postJson(`/api/plans/${campaign}/posts/${postId}/unschedule`, { confirm, actor: ACTOR });
export const reschedulePost = (campaign, postId, scheduledAt, confirm = false) => postJson(`/api/plans/${campaign}/posts/${postId}/reschedule`, { scheduledAt, confirm, actor: ACTOR });
// Mark a post the owner published natively outside pendpost as posted, so it
// leaves the publish-due queue. Never publishes; externalUrl is optional.
export const markPosted = (campaign, postId, externalUrl) => postJson(`/api/plans/${campaign}/posts/${postId}/mark-posted`, { externalUrl, actor: ACTOR });
// Read a handed-off post back from its platforms to confirm it is live (writes a
// non-destructive verify block; never publishes). The caller invalidates ['plans'].
export const verifyPost = (campaign, postId) => postJson(`/api/plans/${campaign}/posts/${postId}/verify`, { actor: ACTOR });
// Live brand-lint. An optional platform tunes the server's caption/hashtag caps
// (A4); omitting it preserves the conservative default-cap behaviour for callers
// that have no platform context.
export const lintText = (text, platform) => postJson('/api/lint', platform ? { text, platform } : { text });
export const refreshLinkedinToken = () => postJson('/api/accounts/linkedin/refresh', {});
export const refreshXToken = () => postJson('/api/accounts/x/refresh', {});
// Run a live liveness probe (proves the token actually authenticates); result
// lands in account_status.<platform>.live. An optional platform scopes the probe
// to a single lane (C4); omitting it probes all lanes - existing no-arg callers
// (App.jsx, Sidebar.jsx) keep their whole-instance recheck unchanged.
export const recheckHealth = (platform) => postJson('/api/health/recheck', platform ? { platform } : {});
// Spec 41: prove the operator's agent CLI can actually run Radar research. Spawns it once
// and requires it to call pendpost_health back over MCP - "live" only if that call really
// landed. SPENDS the operator's subscription (one short turn), so it is only ever wired to
// an explicit "check again" click, never to a poll or a mount.
export const recheckAgent = () => postJson('/api/agent/recheck', {});
// The agent-credential paste ceremony. The token goes ONE WAY: there is no GET twin, no
// tail, and no tool that can read it back - it exists only to be injected into the env of
// the child pendpost spawns. Mirrors connectPlatform's operator-only posture.
export const connectAgent = (token, provider) => postJson('/api/agent/connect', provider ? { token, provider } : { token });
// WP9: adopt the agent credential another client already holds. Server-side copy between
// per-client .env files - the token never travels through the browser.
export const adoptAgent = (fromClient, provider) => postJson('/api/agent/adopt', { fromClient, provider });
// A Meta-368 block has no machine-readable clear time, so it never auto-expires;
// the owner confirms out of band (Meta Business Suite) that it lifted, then
// clears it here. blockedUntil:null records "cleared".
export const clearMetaBlock = () => postJson('/api/state/meta-block', { blockedUntil: null, source: ACTOR, actor: ACTOR, reason: 'owner confirmed Meta lifted the block' });
export const fetchInsights = (campaign) => postJson('/api/insights/fetch', campaign ? { campaign } : {});
// NOTE: there is deliberately no radar_scan (keyword engine) helper here any more. Spec 41
// made Studio scanning AGENT-ONLY: pressing Scan now spawns the operator's own agent, and a
// scan that cannot use an agent does not run rather than quietly falling back to a regex.
// radar_scan / GET /api/radar/scan stay SHIPPED as headless MCP surface for agents that still
// call them, and are declared agent-only in docs/plans/platform/API-CONTRACT.md. The route
// path is deliberately not written above: parity check 3 greps app/src for the literal, so
// keeping a dead helper alive just to satisfy it would fake the third-face gate green - worse
// than the gap it would hide.
// Spec 41: "Scan now" as the operator means it - spawn THEIR agent to do real research. It
// resolves only when the child finishes (minutes; bounded at 10), so the panel never depends
// on this promise to render progress: the job row reads state.radar.jobs from useSignals,
// which is the same thing an agent or a second tab would see.
// Accepts an options object { queryId?, scope? }. scope:'geo' runs the standalone KI-Sichtbarkeit
// recheck (the per-card "Jetzt pruefen"); omitted, it is the normal signal scan. A bare string arg
// still works as a queryId for older call sites.
export const radarAgentScan = (opts = {}) => {
  const { queryId, scope } = typeof opts === 'string' ? { queryId: opts } : (opts || {});
  const body = { actor: ACTOR };
  if (queryId) body.queryId = queryId;
  if (scope) body.scope = scope;
  return postJson('/api/radar/agent-scan', body);
};
// Spec 44: check now whether the authors of the threads we replied into have replied back.
// READ-only (re-reads our replies' threads); surfaces an "Author replied" badge, never posts.
export const radarFollowupCheck = () => postJson('/api/radar/followup', { actor: ACTOR });
// S8: a job spends the operator's subscription, so there is always a way out before the
// timeout. Resolves immediately; the scan promise above then settles as failed/stopped.
export const radarAgentStop = (jobId) => postJson('/api/radar/agent-stop', jobId ? { jobId } : {});
// Spec 42 S7: draft the comparison page one backlog row is asking for. The agent writes the prose;
// this files it as a DRAFT (never pending, never auto-approved) for the operator to edit.
export const radarDraftComparison = (backlogKey) => postJson('/api/radar/comparison-draft', { backlogKey, actor: ACTOR });
// Radar (beta) triage WRITE (spec 32): dismiss/watch/clear one cached signal (POST
// /api/radar/triage -> lib/writes.mjs triageSignal). A LOCAL state write making US6
// (dismiss never re-surfaces) + US7 (watch stays pinned) DURABLE across page/client
// changes. Idempotent; the UI always acts as the owner. Resolves { ok, source,
// externalId, action, watched } or throws. The caller invalidates ['radar'].
export const radarTriage = (source, externalId, action) => postJson('/api/radar/triage', { source, externalId, action, actor: ACTOR });
// NOTE: there is deliberately no radar ingest helper here. That capability is agent-only -
// an agent submits what it found through its MCP tool, with no Studio round-trip. The old
// helper backed a copy-the-prompt/paste-the-JSON surface that has been removed; the
// rationale is recorded in the parity exemptions in docs/plans/platform/API-CONTRACT.md.
// The route path is deliberately NOT written above: parity check 3 greps app/src for the
// literal path, so naming it here - even in a comment - would fake the third-face gate
// green, which is worse than the gap it would hide.
// Radar (beta) close-the-loop WRITE (spec 34): queue an approval-gated reply to a signal's
// EXTERNAL thread (POST /api/radar/reply -> lib/writes.mjs queueRadarReply). Creates a
// PENDING reply-post only - it does NOT post. The reply is EXCLUDED from auto-approve
// entirely and needs a DISTINCT approver; the queued reply then appears in the normal
// planner with its approval pill. confirm:true is INTRINSIC (the Queue click IS the
// confirmation). Reddit/Mastodon/Bluesky only - HN is surface-only (copy-paste). Resolves
// { ok, campaign, postId, approval:"pending" } or throws. The caller invalidates ['plans'].
export const radarQueueReply = ({ campaign, signalUrl, source, externalId, text, executionMode } = {}) =>
  postJson('/api/radar/reply', { campaign, signalUrl, source, externalId, text, executionMode, confirm: true, actor: ACTOR });
// The inbox seam WRITE (spec 02): reply to one comment on a posted post (POST
// /api/comments/reply -> lib/writes.mjs replyToComment). Operator-triggered; the UI
// always acts as the owner. Resolves { ok, id, platform } or throws (sendJson
// surfaces the server message + code, e.g. not_configured when the scope is missing).
// The caller invalidates ['plans'] + refetches the panel on success.
export const replyToComment = (campaign, postId, commentId, text, platform) => postJson('/api/comments/reply', { campaign, postId, commentId, text, platform, actor: ACTOR });
// The inbox seam WRITE (spec 06): moderate one comment (POST /api/comments/moderate ->
// lib/writes.mjs moderateComment). action is one of the lane's supported moderate
// actions (from the read's moderateActions). Operator-triggered; the UI supplies an
// inline confirm step for the content-suppressing actions (delete/hide/remove/spam)
// and posts confirm:true for them - a bare destructive call server-side returns
// needs_confirm (428). Restorative approve/unhide/hold pass confirm:false. Resolves
// { ok, id, action } or throws (sendJson surfaces the server message + code, e.g.
// not_configured on a missing scope / paused lane, unsupported_action when the lane
// cannot do it). The caller invalidates ['plans'] + refetches the panel on success.
export const moderateComment = (campaign, postId, commentId, action, platform, confirm) => postJson('/api/comments/moderate', { campaign, postId, commentId, action, platform, actor: ACTOR, confirm: confirm === true });
// The inbox seam WRITE (spec 24): react to one comment/mention (POST /api/comments/react
// -> lib/writes.mjs reactToPost). reaction is one of the lane's supported reactions (from
// the read's reactActions). Operator-triggered; NOT destructive and NOT confirm-gated
// (react is idempotent). Pass remove:true to un-react where the lane supports it; emoji
// is the optional glyph for the emoji lanes. authorPubkey is the reacted-to comment's
// author (threaded from the read's items[].author) - the nostr engine needs it for the
// NIP-25 p tag; every other lane ignores it. Resolves { ok, id, reaction, removed } or
// throws (sendJson surfaces the server message + code, e.g. not_configured on a missing
// scope, unsupported_reaction when the lane cannot do it). The caller invalidates
// ['plans'] + refetches the panel on success.
export const reactToPost = (campaign, postId, commentId, reaction, platform, emoji, remove, authorPubkey) => postJson('/api/comments/react', { campaign, postId, commentId, reaction, platform, actor: ACTOR, emoji, remove: remove === true, authorPubkey });
// GBP reviews WRITE (spec 03): upsert/remove the owner reply on one review (POST
// /api/reviews/reply -> lib/writes.mjs replyToReview). reviewId is the full resource
// name (from useReviews items[].commentId); an empty text REMOVES the reply. Operator-
// triggered; the UI always acts as the owner. Low-risk + reversible - no confirm gate.
// Resolves { ok, id, reviewId } or throws (sendJson surfaces the server message + code,
// e.g. not_configured when the Business Profile API is pending approval). The caller
// invalidates ['activity'] + ['reviews'] on success.
export const replyToReview = (reviewId, text) => postJson('/api/reviews/reply', { reviewId, text, actor: ACTOR });
// GBP location media gallery WRITE (spec 19): add one photo/video (POST /api/gbp/media
// -> lib/writes.mjs gbpMediaAdd). Pass EXACTLY ONE of sourceUrl (a public http(s) URL)
// or filePath (a client-root-relative local path); category is required. Low-risk +
// additive - no confirm gate. Resolves { ok, id, googleUrl } or throws (sendJson
// surfaces the server message + code, e.g. not_configured when the Business Profile
// API is pending approval). The caller invalidates ['gbp-media'] on success.
export const gbpMediaAdd = ({ sourceUrl, filePath, category, format } = {}) => postJson('/api/gbp/media', { sourceUrl, filePath, category, format, actor: ACTOR });
// GBP location attributes WRITE (spec 19): upsert one location attribute (POST
// /api/gbp/attributes -> lib/writes.mjs gbpAttributesSet). PATCH is an upsert -
// idempotent, so no confirm gate. Resolves { ok, id } or throws. The caller
// invalidates ['gbp-attributes'] on success.
export const gbpAttributesSet = ({ attribute, value } = {}) => postJson('/api/gbp/attributes', { attribute, value, actor: ACTOR });
// YouTube playlists WRITE pair (spec 15): create a playlist (POST /api/youtube/playlists
// -> lib/writes.mjs youtubePlaylistCreate) and add a published video to one (POST
// /api/youtube/playlists/<id>/items -> youtubePlaylistAdd). Re-adding an already-present
// video resolves { ok, duplicate:true } rather than throwing. The caller invalidates
// ['plans'] (the ytPlaylistItems echo) and ['youtube-playlists'] (a fresh itemCount).
// Nostr zaps WRITE (spec 20, the MONEY path): send REAL sats to a published nostr note
// (POST /api/plans/:campaign/posts/:postId/zap -> lib/writes.mjs sendZap). amount is in
// whole sats; comment is optional. confirm:true is INTRINSIC to the modal submit (the
// human clicking "Send zap" IS the confirmation) - the server fails closed without it.
// Resolves { ok, id:<preimage>, sats } or throws (sendJson surfaces the server message +
// code, e.g. not_configured when no NWC wallet is connected). The caller invalidates
// ['plans'] + ['insights'] on success (the next sweep shows the sats increment).
export const sendZap = (campaign, postId, { amount, comment } = {}) => postJson(`/api/plans/${encodeURIComponent(campaign)}/posts/${encodeURIComponent(postId)}/zap`, { amount, comment, confirm: true, actor: ACTOR });
// Edit-after-publish WRITE (spec 12): push the post's CURRENT content (already
// saved via the normal updatePost PATCH - the Composer/inline Save) to the
// already-published object on youtube/telegram/discord (POST /api/plans/
// :campaign/posts/:postId/edit-published -> lib/writes.mjs editPublished). This
// pushes an edit, it never re-publishes (the object id/permalink stay unchanged).
// confirm:true is INTRINSIC to the PostDetail confirm dialog (the click IS the
// confirmation) - the server fails closed without it. Resolves { ok,
// edited:[{platform,id}] } or throws (sendJson surfaces the server message +
// code, e.g. not_configured on a missing YouTube write scope). The caller
// invalidates ['plans'] on success.
export const editPublished = (campaign, postId) => postJson(`/api/plans/${encodeURIComponent(campaign)}/posts/${encodeURIComponent(postId)}/edit-published`, { confirm: true, actor: ACTOR });
// Discord guild scheduled events WRITE (spec 26): create a REAL guild scheduled
// event from a post's dcEvent intent (POST /api/plans/:campaign/posts/:postId/
// discord-event -> lib/writes.mjs discordScheduleEvent). confirm:true is
// INTRINSIC to the PostDetail confirm dialog (the click IS the confirmation) -
// the server fails closed without it. Resolves { ok, event:{id} } or throws
// (sendJson surfaces the server message + code, e.g. not_configured when no
// Discord bot token is set, invalid_input when the post has no dcEvent intent).
// The caller invalidates ['plans'] on success (the next read shows dcEventId).
export const discordScheduleEvent = (campaign, postId) => postJson(`/api/plans/${encodeURIComponent(campaign)}/posts/${encodeURIComponent(postId)}/discord-event`, { confirm: true, actor: ACTOR });
// Mastodon pin/unpin WRITE (spec 31): pin or unpin a published status to the
// profile (POST /api/mastodon/pin -> lib/writes.mjs mastodonPin). pinned:true
// pins, pinned:false unpins. IDEMPOTENT (re-pinning an already-pinned status is
// a safe no-op) - no confirm gate (non-destructive, reversible). Resolves
// { ok, id, pinned, alreadyPinned?, alreadyUnpinned? } or throws (sendJson
// surfaces the server message + code, e.g. not_configured on a missing
// write:accounts scope). The caller invalidates ['plans'] on success (the next
// read shows the flipped ids.mastodonPinned). follow/unfollow and the Nostr
// relay/list actions are MCP-only - no GUI face, so no helper here.
export const mastodonPin = (campaign, postId, pinned) => postJson('/api/mastodon/pin', { campaign, postId, pinned, actor: ACTOR });
export const createYoutubePlaylist = (title, description, privacy) => postJson('/api/youtube/playlists', { title, description, privacy, actor: ACTOR });
export const addToYoutubePlaylist = (playlistId, { campaign, postId, videoId } = {}) => postJson(`/api/youtube/playlists/${encodeURIComponent(playlistId)}/items`, { campaign, postId, videoId, actor: ACTOR });
// Pinterest board + section CRUD WRITEs (spec 29): create/rename a board (POST/PATCH
// /api/pinterest/boards[/:boardId] -> lib/writes.mjs createPinterestBoard/
// updatePinterestBoard) and create/rename a board section (POST/PATCH
// /api/pinterest/boards/:boardId/sections[/:sectionId] -> createPinterestBoardSection/
// updatePinterestBoardSection). Low-risk + additive/idempotent (a rename is a PATCH
// upsert) - no confirm gate, mirrors the YouTube playlist writes above. Resolves the
// engine result or throws (sendJson surfaces the server message + code, e.g.
// not_configured when the connected token predates the boards:write scope). The
// caller invalidates ['pinterest-boards'] (+ ['pinterest-board-sections', boardId]
// for the section writes) on success.
export const createPinterestBoard = (name, privacy, description) => postJson('/api/pinterest/boards', { name, privacy, description, actor: ACTOR });
export const updatePinterestBoard = (boardId, fields = {}) => sendJson('PATCH', `/api/pinterest/boards/${encodeURIComponent(boardId)}`, { ...fields, actor: ACTOR });
export const createPinterestBoardSection = (boardId, name) => postJson(`/api/pinterest/boards/${encodeURIComponent(boardId)}/sections`, { name, actor: ACTOR });
export const updatePinterestBoardSection = (boardId, sectionId, name) => sendJson('PATCH', `/api/pinterest/boards/${encodeURIComponent(boardId)}/sections/${encodeURIComponent(sectionId)}`, { name, actor: ACTOR });
// Ghost members + newsletters WRITEs (spec 30, account management). member/
// import/newsletter-create are MCP/agent-only by design (no bespoke GUI form -
// parity is MCP<=>API, not MCP<=>GUI, a deliberate net-simplify choice) but are
// still exported here for completeness/future use; ghostNewsletterUpdate is the
// ONE write Setup exposes inline (POST /api/ghost/newsletters/update -> lib/
// writes.mjs ghostNewsletterUpdate), the per-newsletter activate/archive toggle.
// IDEMPOTENT (a PUT) - no confirm gate. Resolves { ok, id, status } or throws
// (sendJson surfaces the server message + code, e.g. not_configured when no
// GHOST_ADMIN_API_KEY is set). The caller invalidates ['ghost-newsletters'] on success.
export const ghostMemberCreate = ({ email, name, note, labels, newsletters, subscribed } = {}) => postJson('/api/ghost/members', { email, name, note, labels, newsletters, subscribed, actor: ACTOR });
export const ghostMembersImport = ({ file, rows, upload } = {}) => postJson('/api/ghost/members/import', { file, rows, upload, actor: ACTOR });
export const ghostNewsletterCreate = ({ name, description, subscribeOnSignup } = {}) => postJson('/api/ghost/newsletters', { name, description, subscribeOnSignup, actor: ACTOR });
export const ghostNewsletterUpdate = ({ id, status, name, description } = {}) => postJson('/api/ghost/newsletters/update', { id, status, name, description, actor: ACTOR });
// Cross-lane profile edit WRITEs (spec 28, generalizes the shipped X profile-edit
// pattern to mastodon/nostr/telegram/youtube). Each posts to POST /api/accounts/
// <lane>/profile -> lib/writes.mjs <lane>UpdateProfile. probe:true runs a read-only
// access-tier check (confirm not required); an APPLY call (probe unset/false) always
// sends confirm:true - the Studio's Apply click IS the confirmation (mirrors
// sendZap/editPublished/discordScheduleEvent above) - the server fails closed
// without it regardless (the confirm gate lives INSIDE the shared writes.mjs helper,
// so a bare curl POST without confirm still gets needs_confirm). Resolves the engine
// envelope or throws (sendJson surfaces the server message + code, e.g.
// not_configured when a write scope is missing). The caller invalidates
// ['activity'] on a successful apply.
export const mastodonUpdateProfile = ({ name, bio, url, image, banner, probe } = {}) =>
  postJson('/api/accounts/mastodon/profile', { name, bio, url, image, banner, probe: probe === true, confirm: probe !== true, actor: ACTOR });
export const nostrUpdateProfile = ({ name, about, picture, nip05, website, probe } = {}) =>
  postJson('/api/accounts/nostr/profile', { name, about, picture, nip05, website, probe: probe === true, confirm: probe !== true, actor: ACTOR });
export const telegramUpdateProfile = ({ title, description, image, probe } = {}) =>
  postJson('/api/accounts/telegram/profile', { title, description, image, probe: probe === true, confirm: probe !== true, actor: ACTOR });
export const youtubeUpdateProfile = ({ description, keywords, country, defaultLanguage, probe } = {}) =>
  postJson('/api/accounts/youtube/profile', { description, keywords, country, defaultLanguage, probe: probe === true, confirm: probe !== true, actor: ACTOR });
// C1: set the Meta publishing lane's cadence cap and/or pause/resume it. body =
// { cadence?, paused?, reason? }; maps to meta_lane_set / POST /api/state/meta-lane.
// The caller invalidates ['accounts'] (account_status.meta carries the lane state).
export const setMetaLane = (body) => postJson('/api/state/meta-lane', { ...body, actor: ACTOR });
// Edit non-secret config (identifiers -> .env, posting vars -> config.json).
// Secrets are display-only and never sent. set = { identifiers?, posting? }.
export const saveConfig = (ifRev, set) => postJson('/api/config', { ifRev, set, actor: ACTOR });

// Operator-only connect ceremony (POST /api/connect). Kicks off the engine's connect
// command for one platform against the active client; the ENGINE writes the .env (the
// server never persists the secret). creds carry the public Client ID + the secret/token
// the operator entered (youtube/linkedin/x: clientId+clientSecret; meta: systemUserToken).
// Resolves { started, interactive } - the caller then polls recheckHealth until the lane
// flips. The secret stays on this machine (a 127.0.0.1 POST into the local .env).
export const connectPlatform = (platform, creds = {}) => postJson('/api/connect', { platform, ...creds });

// Imperative read of the engine connect ceremony's live state for one platform
// (GET /api/connect/status?platform=<p>). Resolves { ok, state:'idle'|'running'|
// 'failed'|'connected', detail, authUrl, at }. The ConnectPanel polls this while
// 'waiting' so it can surface the consent link and a hard failure instead of a
// dead-end spinner. Mirrors the file's other GETs (getJson throws on a non-2xx).
export const connectStatus = (platform) => getJson('/api/connect/status?platform=' + encodeURIComponent(platform));

// Operator-only platform disconnect (POST /api/disconnect): clear ALL stored
// credentials for the platform from the active client's .env - the inverse of connect.
// confirm:true rides the body (the human's confirm-dialog click IS the confirmation),
// satisfying the server's fail-closed needs_confirm gate. Resolves { ok, platform,
// cleared } or throws (sendJson surfaces the server message).
export const disconnectPlatform = (platform) => postJson('/api/disconnect', { platform, confirm: true, actor: ACTOR });

// --- Covers (Phase C surface, UI face lands with the composer) ---
export const setCoverFrame = (campaign, postId, frameSec) => postJson(`/api/plans/${campaign}/posts/${postId}/cover`, { frameSec });
export const clearCover = (campaign, postId) => sendJson('DELETE', `/api/plans/${campaign}/posts/${postId}/cover`, undefined);
export async function uploadCover(campaign, postId, file) {
  const res = await fetch(`/api/plans/${campaign}/posts/${postId}/cover`, {
    method: 'POST',
    headers: { 'Content-Type': file.type || 'image/jpeg' },
    body: file,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || `cover upload: HTTP ${res.status}`);
    err.code = data.code;
    throw err;
  }
  return data;
}

// --- Assets mutation (C2): delete / rename a library file. Both are confirm-
// gated + in-use-protected server-side (needs_confirm/428 names the using
// post(s)); pendpost always acts as the owner. The caller invalidates
// ['assets']. delete_asset takes confirm in the JSON body (DELETE with a body);
// rename_asset POSTs the new name + confirm to /api/assets/<name>/rename.
export const deleteAsset = (file, confirm = false) => sendJson('DELETE', `/api/assets/${encodeURIComponent(file)}`, { confirm, actor: ACTOR });
export const renameAsset = (file, toName, confirm = false) => postJson(`/api/assets/${encodeURIComponent(file)}/rename`, { toName, confirm, actor: ACTOR });

// --- Assets ingestion (WP6): stream a new media file into data/media. The
// filename + actor ride the query string (the CORS header allowlist is fixed).
export async function uploadAssetFile(file) {
  const res = await fetch(`/api/assets/upload?filename=${encodeURIComponent(file.name)}&actor=${ACTOR}`, {
    method: 'POST',
    headers: { 'Content-Type': file.type || 'application/octet-stream' },
    body: file,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || `asset upload: HTTP ${res.status}`);
    err.code = data.code;
    throw err;
  }
  return data;
}
