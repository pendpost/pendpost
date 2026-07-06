# Platform capability matrix

What each platform lane can actually do. pendpost is honest about these
differences rather than implying one uniform behaviour.

## The fourteen platform lanes

| Platform | Lane / engine | Auth model | Content shape | Media | Verification status |
| --- | --- | --- | --- | --- | --- |
| Facebook | `meta` (`scripts/meta-social.mjs`) | System User / Page token | Reels | video | live (production use) |
| Instagram | `meta` | System User / Page token | Reels, stories | video | live (production use) |
| LinkedIn | `linkedin` | OAuth (browser) | Text, article card, video | video | live (production use) |
| YouTube | `youtube` | Google OAuth | Shorts + longform video | video | live (production use) |
| X | `x` | OAuth 2.0 PKCE / 1.0a | Text + media posts | image, video | live (production use) |
| Telegram | `telegram` | Static bot token | Channel messages | image, video | live (real test channel) |
| Discord | `discord` | Static webhook URL | Channel messages | image, video | live (real test channel) |
| Reddit | `reddit` | Script-app password grant | Title + text posts | - | **beta** (built, not live-proven) |
| Pinterest | `pinterest` | OAuth (browser) | Pins by image URL | image URL | **beta** (built, not live-proven) |
| TikTok | `tiktok` | OAuth (browser) | Video posts | video | **beta** (built, not live-proven) |
| Mastodon | `mastodon` | Static app token | Short notes (500 default cap) | image, video | live (sandbox-verified, real instance) |
| WordPress | `wordpress` | Application password | **Long-form article**: title, markdown body, excerpt, tags, featured image | image (featured) | live (sandbox-verified, real instance) |
| Ghost | `ghost` | Admin API key (JWT) | **Long-form article** + optional newsletter email: title, markdown body, excerpt, canonical URL, tags, feature image | image (feature) | live (sandbox-verified, real instance) |
| Nostr | `nostr` | nsec keypair + relays | Short text notes (NIP-01) | none (no media hosting in the protocol) | live (sandbox-verified, real relay) |
| Google Business Profile | `gbp` | Google OAuth (business.manage) | Local posts: What's New / Offer / Event + CTA | image by public URL | **beta** (mock-verified; Google gates the API behind per-project approval) |
| Bluesky | **none yet** (contract-reserved name) | app password (planned) | Text posts | image | **not shipped** - no engine locally or in the cloud (pendpost-cloud marks the lane disabled); do not target it |

- **Sandbox-verified** = a REAL publish + a REAL read-back against the real
  platform software running locally (`test/integration/` - no signups, media
  included where the platform supports it). The proof harness ships in the
  repo; anyone can re-run it with Docker.
- **Beta** = built and mock-verified through the full loop, flagged `beta:true`
  in Setup until a real publish is proven. Treat delivery as unconfirmed.

## Local-only vs managed cloud

The managed cloud fires **meta, linkedin, x, telegram, discord, nostr**
(`CLOUD_LANES`, mirrored by pendpost-cloud's enabled platforms). Every other
lane - youtube, reddit, pinterest, tiktok, mastodon, wordpress, ghost, gbp -
is **LOCAL-ONLY**: the cloud never fires it. For the native lanes
(youtube, mastodon, wordpress, ghost) that costs nothing: the platform's own
scheduler fires them on time even with the machine off (see Native scheduling
below). The remaining local-only lanes fire from the machine running pendpost at
the due minute, and the 24/7 cloud guarantee does not extend to them. A lane
joins `CLOUD_LANES` only after its engine is live in cloud prod (cloud-first,
core-second) - deferring a lane the cloud skips as `lane_disabled` means the
post fires nowhere.

## Content model notes

- The long-form lanes (wordpress, ghost) read `title` (required), `body`
  (markdown - rendered by the deliberately small subset in `lib/markdown.mjs`),
  `excerpt`, `tags`, and a hero image (the `image` URL for ghost, or the post's
  local image media as the uploaded featured image). Ghost additionally honors
  `canonicalUrl` and the `ghostEmail` newsletter opt-in (emails members exactly
  once, on the draft-to-published transition).
- The short-note lanes (mastodon, nostr) read the shared caption with the
  additive per-platform overrides `mastodonCaption` / `nostrCaption` (the same
  pattern as `xCaption`).
- GBP posts carry a `gbp` intent object: `topic` (`standard` | `offer` |
  `event`), an optional CTA (`ctaType` + `ctaUrl`), event fields, offer fields.
  Media reaches GBP only as a public `image` URL (the v4 API takes
  `sourceUrl`, not uploads).

## Native scheduling

Native scheduling means pendpost hands the post to the platform ahead of time,
so it fires even if the machine is off: Facebook scheduled post, YouTube
`publishAt`, and (since 2026-07-05) Mastodon `scheduled_at`, WordPress status
`future` and Ghost status `scheduled` + `published_at` (the `?newsletter=`
attached on the scheduling transition still emails at publish - verified against
the v5 Admin API docs). Every other lane publishes at the due time by the
scheduler's publish-due sweep. Moving or cancelling a natively scheduled post
deletes the platform object(s), which is a real mutation and requires explicit
confirmation.

Per-lane native quirks and their recovery lanes (all local-only, modeled on
`youtube-release`):

- **Mastodon** - the instance rejects `scheduled_at` less than ~5 min out (such
  entries just publish at due time), media uploads at schedule time, and the
  fired status gets a NEW id: the `mastodon-resolve` lane records it post-due
  (or cancels + republishes a queue entry the instance never fired).
- **WordPress** - wp-cron only runs on site traffic, so a quiet site can leave a
  post `future` past its date: verify reads `future-overdue` and the
  `wordpress-release` lane flips it live. The post id survives the transition.
- **Ghost** - if the site was down at the publish minute the post stays
  `scheduled`: verify reads `scheduled-overdue` and the `ghost-release` lane
  flips it live (the newsletter attached at schedule time rides along). The
  post id survives the transition.

## Cover / thumbnail details (the video platforms)

The cover map mirrors `coverApplicability()` in `lib/covers.mjs`.

- **Facebook.** Applied after publish via `POST /{video-id}/thumbnails`
  (`is_preferred`). Works for both frame covers and file covers. The
  `set-thumbnail` command re-applies it post-hoc.
- **Instagram.** Only a frame offset (`thumb_offset`, in milliseconds) at
  publish; there is no post-hoc change via the API. File covers cannot reach
  Instagram because there is no public hosting layer in this pipeline, so pick
  a frame instead. Stories have no cover concept.
- **LinkedIn.** Uploaded via the thumbnail step during the video upload
  ceremony, before finalize. It applies only to a not-yet-published post; there
  is no post-hoc change via the API.
- **YouTube.** `thumbnails.set` (JPEG, 2 MB or smaller, post-hoc is fine). The
  channel must be phone-verified or the API returns 403. The Shorts feed always
  shows a video frame; the custom thumbnail appears on search and channel
  surfaces.

## Insights

Read-only, never publish anything. Real metrics: Facebook/Instagram (Graph
insights), LinkedIn (share statistics), YouTube (`videos.list`), X, Pinterest,
TikTok, Reddit (post scores), **Mastodon** (favourites/reblogs/replies), GBP
(`reportInsights`, post-approval). Honest no-ops (the platform exposes no
per-post metrics to this integration): Telegram, Discord, WordPress core,
Ghost, Nostr.
