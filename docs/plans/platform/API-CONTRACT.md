# API contract

pendpost ships every capability with two faces that stay in lockstep:

- the JSON API (`/api/*`, consumed by the dashboard), and
- the MCP face (`/mcp`, consumed by agents).

The parity rule: **every write capability that exists on one face must exist on
the other.** `test/parity-check.mjs` enforces this statically by reading the
`ROUTES` table in `lib/api.mjs` (each entry carries an `mcpTool` key, which may be
`null` for read-only GET routes) and the `TOOLS` array in `lib/mcp.mjs`, then
checking that:

1. every non-GET route names an `mcpTool` that exists in `lib/mcp.mjs`, and
2. every MCP tool is reachable from the API face (it is some route's `mcpTool`),

unless the route or tool is listed in the exemptions below.

## How to read the mapping

The single source of truth is the code itself. Run the check any time:

```bash
node test/parity-check.mjs
```

It prints `OK - <N> routes, <M> tools, <K> documented UI-only capabilities` when
the two faces are in sync, and a `FAIL` with the specific drift otherwise.

`POST /api/agent/connect` is the OPERATOR-ONLY agent-credential ceremony (spec 41), and
carries the same rule as `/api/connect` for the same reason: entering a credential is a
human dashboard action, never an agent action. It is the ONE way the Claude Code
subscription token (or Anthropic API key) enters pendpost, and it is write-only by
construction - there is no GET twin, the key is absent from `config.mjs`'s `secrets()`
display map (so not even a `...abcd` tail is readable), it is not in `IDENTIFIER_ENV_KEYS`
(so `config_set` can never reach it), and its only consumer is the env of the child
pendpost spawns for the owner. An agent CAN walk the owner through minting it
(`setup.agent.playbook` is on `pendpost_health`) and CAN prove the result with
`agent_recheck`; it can never read, write or paste the token itself.

`POST /api/agent/adopt` (WP9) carries the same operator-only rule: it copies the agent
credential from ANOTHER client's `.env` into the active client's, entirely server-side
("use the same agent as {client}" on the Setup card). The value never appears in a
request, response or log - the dashboard sends only `{ fromClient, provider }`, and
`setup.agent.adoptFrom` on `pendpost_health` lists candidates presence-only. It is the
one deliberate crossing of per-client credential isolation, owner-initiated and
agent-unreachable.

`POST /api/radar/draft-comparison` (`radar_draft_comparison`) is the SPAWNED CHILD's tool, not an
operator surface (spec 42 S7). The operator presses "Draft it" on a Radar backlog row, which calls
`POST /api/radar/comparison-draft` (`radar_agent_comparison`, GUI-reachable); that spawns their agent,
and the agent calls THIS to file the page it wrote. An operator never calls it directly, because its
required argument is the page body - and if a human has already written the page, they do not need
Radar to file it, they need the composer. It carries its own tool rather than reusing
`plan_create_post` for a security reason worth stating: a comparison post has no `radarReplyTo`, so
`lib/auto-approve.mjs` has nothing to refuse it BY, and the broad auto-approve policy could match and
PUBLISH content that was seeded by untrusted threads. This one forces `approval:'draft'`.

## Parity exemptions

Capabilities that are intentionally present on only one face. Add an entry here
(with a one-line justification in this prose, not in the JSON) whenever a
capability is deliberately single-faced.

- `routes`: write routes that legitimately have no MCP tool.
- `tools`: MCP tools that legitimately have no API route.
- `uiOnly`: dashboard-only capabilities that never get an MCP tool.
- `agentOnly`: capabilities with an MCP face and deliberately no GUI face. An
  OBJECT (route -> rationale), because a bare list of paths accretes silently and
  stops meaning anything. The rationale is checked for substance, so a placeholder
  fails; say WHY no Studio surface should reach it.

`agentOnly` closes the third face. `routes` and `uiOnly` above kept the API and MCP
faces honest with each other, and a capability could satisfy both while being
completely unreachable in the Studio - which is the failure `_TEMPLATE.md` has always
forbidden ("Every ACTION must map to an engine verb, an MCP tool + API route pair,
AND a GUI touch-point. No orphan actions.") and which nothing enforced until
parity-check's check 3. Every entry below is a claim that an operator should never
need this; an entry that is really an unclosed gap must say so in its own words.

The four client-admin routes now ship MCP twins as GUARDED tools, closing the
former operator-only carve-outs toward 100% agent-operability without weakening
the "posted to the wrong client" anti-goal. `POST /api/clients/active`,
`POST /api/clients`, `PATCH /api/clients/<id>`, and `POST /api/clients/<id>/archive`
map to `client_set_active`, `client_create`, `client_update`, and `client_archive`.
Each MCP tool requires `actor: "owner"` (the same approval authority as the
no-self-approval rule) AND `confirm: true` (fail-closed `needs_confirm`), carries an
optional `clientId` for schema parity, and never reads or writes a credential VALUE
(the registry holds only non-secret profile data). (`client_list` stays a plain
read twin; reads are safe.)

`POST /api/dashboard-update` remains operator/dashboard-only: it fast-forward-pulls
the operator's git checkout (`scripts/dashboard-build.mjs` runs `git pull --ff-only`
with `cwd: REPO_ROOT`) and rebuilds the dashboard. An agent must never pull or
rebuild the operator's working tree, so no `confirm` gate can make it safe to
expose; it stays deliberately UI-only (triggered from the in-app "update available"
prompt).

`POST /api/connect` is the OPERATOR-ONLY platform connect ceremony. It kicks off the
engine's own connect command (`yt/linkedin/x-social.mjs auth`, or `meta-social.mjs
setup-system-user`) against the active client, passing the user's Client ID / Client
Secret / System User token straight to the engine as spawn args. The engine writes the
credential into the active client's `.env`; the server itself never persists a secret.
Because the request body bears the client secret and the action mints a credential, it
is deliberately NOT an agent tool - the same stance as the no-secrets-through-the-agent
guarantee. The dashboard collects the value and the GUI polls `health_recheck` for the
outcome.

`POST /api/disconnect` is the OPERATOR-ONLY inverse of the connect ceremony. It clears
every stored credential for one platform (secrets, identifiers, public handle, OAuth
client id) from the active client's `.env` via `removeEnvVars` (the per-platform key set
is `PLATFORM_ENV_KEYS` in `lib/config.mjs`), returning the lane to `incomplete`. Like
connect it handles a credential surface and so is deliberately NOT an agent tool (no
`mcpTool`); it is fail-closed on `confirm: true` and never echoes a cleared value.

The `POST /api/cloud/*` routes (`connect`, `heal`, `enabled`, `push`, `eject`, `hand-tokens`,
`migrate`, `enable/start`, `clients/always-on`, `checkout`, `billing-portal`, `spend-cap`) are the OPTIONAL managed-cloud (pendpost-cloud) operator
ceremonies. They are operator-only and deliberately NOT agent tools: connecting,
pushing, and handing tokens carry the cloud api key and the platform tokens (both .env
secrets, never exposed) and act on the paid always-on runtime, so an agent must never
connect a workspace, seal tokens into the vault, push to the cloud, or eject on the
operator's behalf. (`hand-tokens` seals the local `.env` platform tokens into the cloud
vault; `migrate` chains connect + hand-tokens + push as the one-command onboarding;
`enable/start` opens the one-click browser sign-in that mints the workspace api key over
a loopback claim, so no key is ever typed - its `GET enable/callback` twin is a plain
loopback redirect target; `heal` re-links a half-written connection (api key present,
`workspaceId` lost from `data/cloud.json`) by reading the authenticated subscription
echo and persisting the id - it authenticates with the same operator-held key the other
ceremonies protect, never mints one, and never touches brand flags, so it stays
operator-only with them; `clients/always-on` toggles one client brand's always-on in
the install-global workspace; `checkout` opens a Stripe Checkout to subscribe to a tier
(`plan` + `interval` in the body); `billing-portal` opens the Stripe billing portal to manage
plan, payment method, and invoices; `spend-cap` sets or clears the overage spend cap (the
running overage pauses once it is reached).) The core stays fully standalone when the feature is
unconnected (per-client always-on off by default), consistent with the open-core boundary
in `docs/specs/cloud-integration-contract.md`.

The cloud OBSERVABILITY reads now ship read-only MCP twins so an agent can observe
cloud / always-on state (it previously could not read it at all): `GET /api/cloud` ->
`cloud_status`, `GET /api/cloud/capabilities` -> `cloud_capabilities`, `GET /api/cloud/clients`
-> `cloud_clients`, `GET /api/cloud/subscription` -> `cloud_subscription`. They are strictly
read-only, carry NO secrets (the api key never leaves `.env`, tokens never leave the vault) and
NO confirm gate; `cloud_capabilities` / `cloud_subscription` proxy the cloud over the network and
degrade gracefully. The cloud CONTROL routes (`push`, `reconcile`, `enabled`, `clients/always-on`)
and the connect/billing ceremonies above stay operator-only and are NOT twinned. (`GET /api/cloud/enable/callback`
is a plain loopback redirect and needs no exemption.)

`connect_discover` (spec 22, connected-account discovery) is a READ tool: it enumerates who a
connected lane authenticates as and which assets it manages. Its GET twin
`GET /api/accounts/:platform/discover` carries no `mcpTool` (reads are exempt from the
route→tool parity direction), so the tool has no route that names it and is listed in `tools`
here. It reaches the platform (open-world) but never writes - picking an asset flows through the
existing `config_set` write, which has its own parity pair.

```json
{
  "routes": [
    "/api/dashboard-update",
    "/api/connect",
    "/api/agent/connect",
    "/api/agent/adopt",
    "/api/disconnect",
    "/api/cloud/connect",
    "/api/cloud/heal",
    "/api/cloud/enabled",
    "/api/cloud/push",
    "/api/cloud/reconcile",
    "/api/cloud/eject",
    "/api/cloud/hand-tokens",
    "/api/cloud/migrate",
    "/api/cloud/enable/start",
    "/api/cloud/clients/always-on",
    "/api/cloud/checkout",
    "/api/cloud/billing-portal",
    "/api/cloud/spend-cap",
    "/api/cloud/sign-out"
  ],
  "tools": [
    "connect_discover"
  ],
  "uiOnly": [],
  "agentOnly": {
    "/api/radar/draft-comparison": "The spawned child's own tool: the operator presses Draft it (which is /api/radar/comparison-draft, GUI-reachable), their agent writes the page, and calls this to file it. Its required argument is the page body, so a human calling it directly would already have written the page and would want the composer instead. It exists as its own tool, rather than plan_create_post, so that auto-approve cannot match a post seeded by untrusted threads.",
    "/api/radar/scan": "Spec 41 made Studio scanning AGENT-ONLY: Scan now spawns the operator's own agent (POST /api/radar/agent-scan), and a scan that cannot use an agent does not run rather than falling back to a keyword match pretending to be research. radar_scan / runLaneRadar stay SHIPPED for agents and headless callers that still want the credentialed keyword scan - deleting that machinery is its own net-simplify diff, not a rider on this feature. Until then it is genuinely agent-only, and a dead GUI helper kept alive to satisfy this check would fake the gate green.",
    "/api/preview": "Read-only publish dry-run (C3): reports which due posts would fire, on which lanes, in which mode, with what blockers. The operator's equivalent is the Planner itself, which shows the same state in situ; a second read-only mirror of it would be a duplicate surface, and the net-simplify bar rejects that. Agents need it because they cannot see the Planner.",
    "/api/radar/footprint": "Radar GEO footprint logging is agent-only BY DESIGN and this is load-bearing: pendpost never calls an LLM and never holds a model key (spec 39 invariant 1, model-free/key-free). The agent runs the buying question against its OWN model access and reports the result; a GUI button here would imply pendpost has model access, which is exactly the property the product promises it does not have. app/src/components/Radar.jsx:564 states the same rule at the surface that renders the trend.",
    "/api/radar/ingest": "Signal ingest is agent-only for the SAME model-free reason as /api/radar/footprint above: searching the open web is judgement work that needs a model, and pendpost has none. What pendpost can do itself it does - Radar's own scan searches each CONNECTED source's API on a button (Scan now) or daily on its own scheduler, and that is the whole GUI story. What it cannot do, an agent does through this tool with its own model access, and the signal lands in the same ranked feed. The GUI face this once had was a prompt to copy into a chat window and a box to paste JSON back into: a clipboard round-trip that made the operator the transport between two programs that can already talk to each other. It is removed, not replaced - an operator whose agent holds pendpost's tools asks the agent, and an operator with no agent uses the sources they connected. This is a DESIGN DECISION, not a tracked gap.",
    "/api/mastodon/follow": "Social-graph follow/unfollow (spec 31) is deliberately MCP-only. app/src/lib/api.js:591 records the decision in prose: 'follow/unfollow and the Nostr relay/list actions are MCP-only - no GUI face, so no helper here.' Following is a relationship action an agent performs while working a lane, not something the operator does from a publishing dashboard.",
    "/api/nostr/relay-list": "NIP-65 relay list (spec 31), MCP-only by the same decision as /api/mastodon/follow - see app/src/lib/api.js:591. Relay plumbing is identity configuration an agent manages; surfacing raw `r` tags in the Studio would add a screen that no operator task needs.",
    "/api/nostr/list": "NIP-51 lists - mute/pin/bookmark sets (spec 31), MCP-only by the same decision as /api/mastodon/follow - see app/src/lib/api.js:591. These are REPLACEABLE events whose whole-list semantics are hostile to a casual GUI edit; an agent composing the full list is the safer face. This is the POST (set) face.",
    "/api/nostr/list/": "NIP-51 list READ (spec 31). Declared separately from the POST because this route is registered with `prefix:` (the kind is a path segment), so its key carries the trailing slash. Same rationale: MCP-only by the decision recorded at app/src/lib/api.js:591.",
    "/api/accounts/x/profile": "GAP, NOT A DESIGN DECISION - do not read this entry as a rule. X profile edit is the ONLY lane whose profile edit has no GUI face: spec 28 generalized 'the shipped X profile-edit pattern' to mastodon/nostr/telegram/youtube and shipped an app/src/lib/api.js helper for each of those four (mastodonUpdateProfile, nostrUpdateProfile, telegramUpdateProfile, youtubeUpdateProfile), while the lane the pattern originated from was left agent-only. Nothing about X argues for that asymmetry. Exempted only to keep the gate green while the gap is tracked; closing it means an xUpdateProfile helper plus the Setup surface that calls it, sized as its own change."
  }
}
```
