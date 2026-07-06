# Publish-lane sandboxes

Signup-free **live verification** for the wave-2 publish lanes. Each sandbox is
the real platform software running locally in Docker, so a lane can prove a
REAL publish (media included where the platform supports it) plus a REAL
read-back of the minted id/permalink - without creating an account anywhere.

Everything binds to `127.0.0.1` only, every credential is a locally minted
dummy, and `down` removes the volumes. Not part of `npm run check` (needs
Docker); the credential-free mock loop for the same lanes lives in
`test/lanes-wave2.test.mjs`.

| Lane | Sandbox | Port | Proof |
|---|---|---|---|
| wordpress | wordpress:6.7 + mariadb:11 | 8085 | REST publish (title/markdown body/excerpt/tags/featured image) + permalink fetch |
| ghost | ghost:5-alpine (sqlite) | 8086 | Admin-API draft→publish (feature image, canonical, tags) + permalink fetch |
| nostr | dockurr/strfry | 8087 | NIP-01 kind-1 event accepted by the relay (it validates the BIP340 signature) + REQ read-back |
| mastodon | ghcr.io/mastodon/mastodon:v4.3 (+postgres+redis+sidekiq) | 8083 | v2/media upload + status publish + status read-back + permalink fetch |

## Usage

```bash
node test/integration/sandbox.mjs up <lane|all>        # start containers
node test/integration/sandbox.mjs provision <lane|all> # one-time in-container setup
node test/integration/sandbox.mjs verify <lane|all>    # the publish proof (real engine, real API)
node test/integration/sandbox.mjs status               # containers + credentials overview
node test/integration/sandbox.mjs down                 # stop + remove volumes
```

`verify` builds a throwaway client workspace, points the REAL engine
(`scripts/<lane>-social.mjs`) at the sandbox via a temp `.env`, runs
`publish-due`, asserts the minted id on the plan, runs the engine's `verify`
read-back, and (where the platform serves http) fetches the permalink
anonymously. Proof artifacts land in `.proofs/<lane>.json` (gitignored).

## Gotchas learned the hard way (all handled by sandbox.mjs / the compose file)

- **WordPress** disables application passwords over plain http; the sandbox sets
  `WP_ENVIRONMENT_TYPE=local` (via wp-cli on first provision).
- **Ghost**'s integration-CREATE response carries a truncated admin secret; only
  the authenticated GET read-back returns the real 64-hex secret. Also:
  `/ghost/api/admin/site/` is unauthenticated - do not use it to "prove" a key.
- **Mastodon** production hardcodes `force_ssl`; a sandbox-only initializer
  (`mastodon-sandbox.rb`, mounted by compose) disables the redirect. Its email
  validator does live MX lookups, so the throwaway account uses an MX-resolvable
  domain. Boot secrets (rails + VAPID + ActiveRecord encryption trio) are minted
  once into the gitignored `.mastodon.env`.
- **Nostr**: `scsibug/nostr-rs-relay` is amd64-only (segfaults under qemu on
  Apple Silicon) - the sandbox uses the multi-arch `dockurr/strfry`, with
  `nofiles = 0` in `strfry.conf` (strfry's 1M NOFILES default exceeds the
  colima VM hard cap).
- **colima clock drift**: right after the VM boots, container clocks can be off
  far enough to break Ghost's 5-minute JWTs. If Ghost auth 401s with
  "invalid signature" on a fresh VM, wait for NTP to settle (or restart colima).
