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

## Parity exemptions

Capabilities that are intentionally present on only one face. Add an entry here
(with a one-line justification in this prose, not in the JSON) whenever a
capability is deliberately single-faced.

- `routes`: write routes that legitimately have no MCP tool.
- `tools`: MCP tools that legitimately have no API route.
- `uiOnly`: dashboard-only capabilities that never get an MCP tool.

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

The `POST /api/cloud/*` routes (`connect`, `enabled`, `push`, `eject`, `hand-tokens`,
`migrate`, `enable/start`, `clients/always-on`, `checkout`, `billing-portal`, `spend-cap`) are the OPTIONAL managed-cloud (pendpost-cloud) operator
ceremonies. They are operator-only and deliberately NOT agent tools: connecting,
pushing, and handing tokens carry the cloud api key and the platform tokens (both .env
secrets, never exposed) and act on the paid always-on runtime, so an agent must never
connect a workspace, seal tokens into the vault, push to the cloud, or eject on the
operator's behalf. (`hand-tokens` seals the local `.env` platform tokens into the cloud
vault; `migrate` chains connect + hand-tokens + push as the one-command onboarding;
`enable/start` opens the one-click browser sign-in that mints the workspace api key over
a loopback claim, so no key is ever typed - its `GET enable/callback` twin is a plain
loopback redirect target; `clients/always-on` toggles one client brand's always-on in
the install-global workspace; `checkout` opens a Stripe Checkout to subscribe to a tier
(`plan` + `interval` in the body); `billing-portal` opens the Stripe billing portal to manage
plan, payment method, and invoices; `spend-cap` sets or clears the overage spend cap (the
running overage pauses once it is reached).) The core stays fully standalone when the feature is
unconnected (per-client always-on off by default), consistent with the open-core boundary
in `docs/specs/cloud-integration-contract.md`. (`GET /api/cloud`, `GET /api/cloud/clients`,
`GET /api/cloud/subscription`, and `GET /api/cloud/enable/callback` are plain reads/redirects
and need no exemption.)

```json
{
  "routes": [
    "/api/dashboard-update",
    "/api/cloud/connect",
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
    "/api/cloud/spend-cap"
  ],
  "tools": [],
  "uiOnly": []
}
```
