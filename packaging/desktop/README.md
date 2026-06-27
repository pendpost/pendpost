# Desktop app (macOS .dmg + Windows installer)

The no-terminal path for non-technical users: download, double-click, and the
dashboard opens. It is hard-gated on code-signing + notarization (an unsigned
download trips Gatekeeper / SmartScreen, which is unacceptable for this audience),
so the build pipeline ships **now** but the signed assets only appear once the
owner adds the certificates below.

**Status:** the workflow, packaging scripts, and the bundled-Node approach are all
built and tested. What is left is owner-only: add the signing secrets, cut a
release, verify the signed assets, then flip the download flag. See
[Going live](#going-live-owner) at the end.

The web side is already wired: `/download` shows the OS-detected buttons only when
`DESKTOP_AVAILABLE` is `true` in `web/src/data/brand.ts`, and the button URLs are
`DESKTOP.mac` / `DESKTOP.windows` (the release assets `pendpost-macos.dmg` and
`pendpost-windows-setup.exe`). The flag stays `false` until the first signed assets
are attached - flipping it early would publish live buttons that 404.

## Approach (no Tauri, no Node SEA)

The dashboard is already a local web app, so the "app" is a thin native shell over
`http://127.0.0.1:8090` plus a bundled runtime. We reuse what exists and add no new
framework.

- **Runtime bundle** (shared by both platforms): the published pendpost file set
  (the same allowlist as npm's `files`: `server.mjs`, `lib/`, `scripts/`, `bin/`,
  `app/dist/`, the clean `data/{plans,media,captions}` example, `rules.json`,
  config templates, the contract docs) plus a **pinned, checksum-verified Node
  runtime** for the target platform. Assembled by
  [`build-bundle.mjs`](build-bundle.mjs). The app writes state to a per-user dir,
  not the read-only bundle: `PENDPOST_ROOT` is
  `~/Library/Application Support/pendpost` (macOS) / `%APPDATA%\pendpost` (Windows).
  On first run [`scripts/desktop-start.mjs`](../../scripts/desktop-start.mjs) seeds
  that dir from the bundled example so a fresh install opens to mock-mode demo data,
  exactly like `npx pendpost`; re-runs never clobber the user's workspace.
- **Bundle hygiene:** the bundle is an allowlist, so it can leak credentials the
  same way the npm tarball nearly did. `build-bundle.mjs` refuses to stage
  `data/clients/**`, raw `.env`, `config.json`, or `sync/`, and
  [`test/desktop-bundle.test.mjs`](../../test/desktop-bundle.test.mjs) stages the
  real output and fails the build on any leak (runs in `npm run check`).
- **macOS:** [`macos/PendpostApp.swift`](macos/PendpostApp.swift) is a WKWebView
  shell that spawns the bundled `node scripts/desktop-start.mjs` directly (no
  launchd, no system node), waits for health, then loads the window. v1 is
  app-lifetime: quitting the app stops the server. Packaged as a signed, notarized,
  **universal** (Intel + Apple Silicon) `.dmg`. The bundled Node needs JIT
  entitlements ([`macos/entitlements.plist`](macos/entitlements.plist)) to run under
  the hardened runtime.
- **Windows:** [`windows/pendpost.iss`](windows/pendpost.iss) (Inno Setup) installs
  the bundle per-user to `{localappdata}\pendpost`, adds a Start-menu shortcut and
  an optional "start on login" shortcut, and [`windows/launch.cmd`](windows/launch.cmd)
  starts the bundled server and opens `msedge --app=http://127.0.0.1:8090` for a
  chromeless window (Edge is on every Win10/11; falls back to the default browser).
  The installer is code-signed.

> The dev-mode launcher at the repo root (`launcher/PendpostApp.swift` + `install.sh`)
> is unchanged - it targets a developer's git clone with a launchd agent. The files
> here are the **bundled-mode** distribution variant.

## CI: `.github/workflows/release-desktop.yml`

Mirrors `release-npm.yml` / `release-image.yml`: runs on a published release or a
manual dispatch, never on a push, and only on `pendpost/pendpost`. Two jobs
(`macos-latest`, `windows-latest`).

**Cert-free by design.** Every step that does not need a certificate - building the
dashboard, assembling the bundle (with a checksum-verified Node), making the
`.dmg` / `.exe` - runs unconditionally. Signing + notarization are gated on the
secrets below:

| Trigger | Secrets present? | Result |
| --- | --- | --- |
| `workflow_dispatch` | either | **Unsigned** installers uploaded as **build artifacts** (testable today, before any certs). |
| release published | yes | **Signed + notarized** installers attached to the release. |
| release published | no | Everything assembles, upload is **skipped** (an unsigned asset must never hit a public release), job stays green with a warning. |

Test the whole pipeline now: Actions -> "release desktop" -> Run workflow, then
download the artifacts. They will be unsigned (Gatekeeper/SmartScreen will warn),
which only proves the build; signing is what the secrets below enable.

## Owner secrets (the only thing left to make downloads live)

Add these in the repo's **Settings -> Secrets and variables -> Actions**. Until
they exist the jobs still pass; they just produce unsigned artifacts.

### macOS (Apple Developer Program, ~$99/yr)

| Secret | What it is / how to get it |
| --- | --- |
| `APPLE_DEVELOPER_ID_CERT_P12_BASE64` | Your **Developer ID Application** certificate **with its private key**, exported from Keychain Access as a `.p12`, then base64-encoded: `base64 -i DeveloperID.p12 \| pbcopy`. |
| `APPLE_DEVELOPER_ID_CERT_PASSWORD` | The password you set on that `.p12` export. |
| `APPLE_ID` | Your Apple Developer account email (used by notarytool). |
| `APPLE_TEAM_ID` | Your 10-character Team ID (developer.apple.com -> Membership). |
| `APPLE_APP_PASSWORD` | An **app-specific password** for notarization: appleid.apple.com -> Sign-In and Security -> App-Specific Passwords. Not your account password. |

Get the Developer ID Application certificate from developer.apple.com ->
Certificates -> "+" -> **Developer ID Application** (not "Apple Distribution",
which is App Store only). Export it from Keychain Access including the private key.

### Windows (a code-signing certificate from a CA)

| Secret | What it is / how to get it |
| --- | --- |
| `WINDOWS_CERT_PFX_BASE64` | Your code-signing certificate **with its private key** as a `.pfx`, base64-encoded: `base64 -i cert.pfx \| pbcopy`. |
| `WINDOWS_CERT_PASSWORD` | The `.pfx` password. |

Buy an **OV** (organization-validated) code-signing certificate (DigiCert,
Sectigo, etc.); it is the cert type that exports to a `.pfx`. An **EV** cert builds
SmartScreen reputation fastest but is usually bound to a hardware token and
**cannot** be exported to a `.pfx` - for EV, use a cloud signing service (e.g.
Azure Trusted Signing) and adapt the "Sign the installer" step. New OV certs still
warm up SmartScreen reputation over the first downloads; that is expected.

## Going live (owner)

1. Add the secrets above (macOS, Windows, or both - each platform signs
   independently).
2. Trigger a build: publish a release, or run the workflow manually to sanity-check.
   On a release with secrets, `pendpost-macos.dmg` and `pendpost-windows-setup.exe`
   are attached automatically.
3. Verify on a clean machine: the `.dmg` opens without a Gatekeeper block
   (`spctl -a -vv /Applications/pendpost.app` says "accepted, source=Notarized
   Developer ID"); the `.exe` installs without a SmartScreen hard-block.
4. Flip the flag - the last step: set `DESKTOP_AVAILABLE = true` in
   `web/src/data/brand.ts` and deploy the site. Now `/download` shows the live
   buttons, which point at `releases/latest/download/...` and resolve to the signed
   assets from step 2.

## Known caveat (be honest on /download)

GUI install removes the *install* barrier, not the *connect-a-platform* barrier:
real platform OAuth still runs a short per-engine CLI ceremony. Mock mode is fully
GUI (the "try it now" path). In-app OAuth buttons, auto-update (Sparkle / MSIX), a
Windows system tray, and an optional always-on LaunchAgent on macOS are sensible
follow-ons, not v1.
