# Changelog

All notable changes to pendpost are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and pendpost adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.13.0] - 2026-11-12

The Mac app can be downloaded again. GitHub retired the build machine the Mac release used, so 2.12.0 and 2.12.1 came out without one. This release also closes ten gaps that a security audit of pendpost found in November. Most of them were ways an agent connected over MCP could reach a file or an action it should never touch. In the Studio, every Check again button now shows that it ran, and an update no longer tells you to commit or stash files.

### Security

- pendpost now refuses to start on a non-loopback address (for example `PENDPOST_HOST=0.0.0.0`) when `PENDPOST_AUTH_TOKEN` is not set. Before this, anyone who could reach the port could send a forged `Host` header and use the whole API, every MCP tool and the Studio owner token. The container image hit this with the published `docker run -p 8090:8090` command. The new command publishes on your own machine only: `docker run -p 127.0.0.1:8090:8090 -e PENDPOST_ALLOW_UNAUTHENTICATED=1 ghcr.io/pendpost/pendpost`. `docker compose up` keeps working unchanged. Fly, Render and Railway deploys now need `PENDPOST_AUTH_TOKEN` set.
- Operator actions need the Studio token. The 15 REST calls that connect, replace, copy or delete credentials, and the ones that connect, migrate, eject, sign out of or bill the cloud, refuse a request without it (`403 owner_token_required`). Reads, rechecks, pushes and heals stay open to agents. The cloud key only travels over https (plain http is allowed for a cloud on your own machine), and checkout and billing links open only when they are plain https.
- `asset_upload` with a `filePath` checks that the file really is a JPEG, PNG, MP4 or MOV. An agent could otherwise copy any local file into the media folder under an image name and fetch it back over `/media`, a client's signing key included.
- `captionPath` must name a real `.srt` or `.vtt` file outside dot folders. pendpost checks this when the field is written and again at publish, and the file has to contain subtitle timings. Before, an agent could point it at the client `.env`, and the YouTube lane would have uploaded that file as captions.
- A reviewer's share link can decide only the posts waiting for that review, or ones a reviewer already decided. It can no longer approve a post you rejected or one you moved into an internal campaign.
- Respond for me takes decisions only from pendpost's own triage run. A token that only that run's brief carries binds the two, so another MCP client can no longer plant a signal and report a reply of its own while the drafter is idle. The automation browser only opens the platform's own hosts, and it blocks the daemon on its real port at every loopback address.
- A triage decision can no longer queue an original post. Only the theme sweep does that, and only behind `engage.originalPosts.enabled`.
- The Mac app hands only http, https and mailto links to your system, and a feed item keeps its link only when it is http or https. A hostile feed could otherwise have opened any URL scheme handler with one click.
- Dependabot's auto-merge only acts on Dependabot's own pull request, at the commit CI checked.

### Changed

- Every Check again button shows that it is working, then the result. That covers Published, post detail, Verify, Connect, cloud issues, Recheck in Cmd-K, Radar lanes, Needs you, the rules check and AI answers. When nothing changed, it says so with the time: "Checked again at 10:42, no change."
- pendpost draws its own platform logos now, so the Studio and the website could move to lucide 1.61.
- An empty week or month in the planner jumps to the nearest post. With no post to jump to, it offers New post.
- Dependency updates for the app and the website.

### Fixed

- The macOS download works again. The Mac build runs on the current GitHub runner, a release now fails when `pendpost-macos.dmg` is missing, and the download button on pendpost.com points at the newest release that has one.
- An update no longer stops with "commit or stash your changes" when only a `package-lock.json` changed. pendpost puts the committed lockfile back. If you really have edits in the folder, the update waits and tries again every minute instead of showing an error, and Try again shows that it ran.
- The README's approval queue picture was a browser error page. It and the planner picture are real screenshots again.

## [2.12.1] - 2026-11-09

When you edit, park, unapprove or delete a post that the always-on cloud already holds, the cloud now takes its copy back and never sends it. Before this, the cloud kept the version it was given and posted the old text at the old time.

### Fixed

- Changes reach the cloud. The local engine works out which cloud jobs must not fire (a post was edited since its approval, unapproved, parked, rejected or deleted) and sends them in one batch to the cloud's new withdraw endpoint before each push. Anything still owed is kept in `state.cloudWithdrawPending` and sent again on the next push until the cloud answers. An older cloud that does not know the endpoint is asked again once an hour. Approve or reschedule the post again and it is pushed again as usual.
- A deleted post's cloud job is no longer forgotten. Before the engine prunes the record of a deleted post, it turns that record into a pending withdraw, so the job still gets cancelled.
- Activity shows a "Cloud job withdrawn" row under System.

### Changed

- Dependency updates for the app (jsdom 31 and the app group), the website and the container release workflow.

## [2.12.0] - 2026-11-06

Approving many posts at once now leaves out the ones that cannot go out, and says why in one line, instead of sending them and failing. In Approvals a blocked post shows its cause in one short line with the fix beside it. When a project has Facebook turned off, you can turn it back on or take Facebook off the post from that line, and your agent may now remove such a platform from a post (it can never add one). What's new is shorter: a few items per release, each with a Show me link to where the change lives, and the full notes are on pendpost.com/changelog. The container image runs on Apple Silicon, and pendpost has plugin bundles for Claude Code and Cursor.

### Added

- Show me in What's new. Each release lists two to four short items marked New, Improved or Fixed, each with an icon. An item about a page has a Show me link that opens the page and marks the spot with a ring. "All releases" at the foot of the dialog opens pendpost.com/changelog, the full notes for every version.
- Fixes for a turned-off Facebook on the approval card. When Facebook publishing is off for a project, a post that goes to Facebook gets two buttons on its Approvals row: turn Facebook on for this project, or remove Facebook from this post. Turn on is hidden while the operator lock (`PENDPOST_DISABLED_PLATFORMS`) holds Facebook off, since a setting cannot turn it on then, and remove is hidden when Facebook is the post's only platform. Every blocked row also has "Copy a brief for an agent", which copies the problem as text for any agent you use.
- The agent can remove a turned-off platform. Fix with agent may now take Facebook off a post when Facebook is turned off for the project and the post has another platform to go to. It can only drop a platform that the post's own check flags as off: adding a platform, emptying the list or dropping any other platform is refused and ends the job. Turning the project setting on stays yours. A post whose only platform is Facebook is never handed to the agent, and like every agent edit the post comes back to you for approval.
- Claude Code and Cursor plugins, in the public repo. `packaging/claude-plugin/` connects Claude Code to the pendpost server already running on this computer (`http://127.0.0.1:8090/mcp`) instead of starting a copy of its own. `.cursor-plugin/` and `mcp.json` add pendpost to Cursor and start the exact release with `npx pendpost@2.12.0 --stdio`. `llms-install.md` is an install guide written for agents such as Cline; it asks for an absolute `PENDPOST_ROOT`, because a bare `npx` install would keep your workspace inside the npm cache.

### Changed

- Bulk approve in Approvals skips what cannot go out. A post whose own Approve is disabled, or one on a platform that is not connected, is left out, and before you press, the approve button shows a skip mark with the count. When nothing in the selection can be approved, the button looks disabled. After the run, one quiet line in the selection bar names what was left out or refused: the count, one chip per cause, Show only these, Fix all with agent and Dismiss. Fix all with agent asks before it starts, then edits the posts one after another, and each comes back to you. The line never shows post ids.
- A blocked post in Approvals shows one compact line instead of a boxed panel: the platform icon, a short cause such as "Text too long for X", a ? that holds the full sentence, and icon buttons for the fixes. On a narrow screen the buttons wrap below the cause, which is never cut off.
- Platforms that are not connected get one line per project above the list, and each platform icon on it is that platform's Connect button ("Connect LinkedIn"). The rows keep only a struck-through platform icon. In All projects view every project gets its own line.
- The update toast names only the version ("pendpost 2.12.0 is ready"), or reads "Small improvements ready" when only the commit moved. Help & feedback shows the version and keeps the commit in its tooltip.
- `GET /api/whats-new` returns `items` (kind, icon, title, body and an optional `go` spot) for each release instead of `highlights`, and each release's `url` is its anchor on pendpost.com/changelog instead of a GitHub release page.
- `server.json` carries a `title` for registry and directory listings, and `CITATION.cff` takes its `date-released` from the CHANGELOG heading of the release.

### Fixed

- The Facebook-off message says where the post still goes. For a post whose only platform is Facebook it said the post "would only reach Instagram"; it now says the post would go nowhere. A post without Instagram reads that it would reach only its other platforms.
- `docker pull ghcr.io/pendpost/pendpost` works on Apple Silicon. The image was built for amd64 only, so arm64 machines got "no matching manifest for linux/arm64". It is now published for both.
- The docs no longer offer `brew install`: the Homebrew tap was never published. The formula stays ready in `packaging/homebrew/`, and the 1.0.x entry below carries a correction.
- README links that pointed at files the public repo never ships (`docs/specs/`, `site-docs/`) are gone, and `docs/rfcs/` now ships so its links work.

## [2.11.0] - 2026-11-05

One post can now go out twice: switch on Also as story on a reel, a video or a single image, and pendpost publishes it as a feed post and as a story on Instagram and the Facebook Page, under one approval. Approval closes two gaps. A new cover, an agent's fix or an edit to an older approved post asks you again, and a later reschedule no longer clears that ask. Approvals, the planner and Published show each post media first, with the text the platform will really publish, and selecting posts in Approvals or the planner List is now one slim line with icon actions. pendpost can free disk space by deleting a video once every post that uses it is out, and it tries to fetch back a video that an upcoming post still needs. X accounts with a paid subscription can publish long posts. After an update, the Studio tells you what changed.

### Added

- Also as story. A reel, a video or a single-image post that goes to Instagram or a Facebook Page gets an "Also as story" switch in the editor (`alsoStory` on `plan_create_post` and `plan_update_post`). The story belongs to the same post: one row, one approval, one status. A video over 59 seconds is cut to its first 59 seconds when it publishes; the cut is a temporary file and is removed afterwards, so the library keeps only your original. If the story fails, only the story is retried and the reel is never published again. Instagram photo stories and Facebook Page photo and video stories are new. The Instagram and Facebook rows in a post's detail say "Story to come" until the story is out, and `plan_get` lists the story ids. A Facebook story whose publish could not be confirmed is checked against the Page's stories on the next run, never posted again blind. `posting.reelsAlsoStory` turns the switch on for every new reel in a project. Turning it on for an approved post sends the post back for approval.
- Stories on the cloud. A post with Also as story publishes from this computer until your cloud service says it can publish stories (`stories` in `GET /v1/capabilities`); from then on it fires from the cloud like any other post. pendpost asks the cloud only while such a post is open, so an idle project still makes no cloud calls. When the cloud cuts a long video for an Instagram story, Instagram fetches the cut by URL. An upload ran into Instagram's 35 second processing limit on long files.
- Delete local media once posted. A switch under Settings > Preferences (`posting.mediaCleanup`, off by default, with `graceDays` 7). When it is on, pendpost deletes a video from this computer once a day if every post that uses it, in every plan and in the trash, is published, rejected, deleted or natively scheduled on YouTube, and the grace days have passed since the last of them. A video no post uses, covers and images are never deleted, and a plan file that cannot be read stops the run with nothing deleted. Agents get `media_cleanup`, a dry run by default that lists what would go and why everything else stays, and its REST twin `POST /api/media/cleanup`. Each run writes one "Local media deleted" row to Activity with every file and its size.
- Getting missing media back. Every 10 minutes pendpost looks at the posts still to come in active campaigns. When a video one of them needs is gone from this computer, pendpost asks the cloud for its copy, checks it against the file's fingerprint and puts it back. A file that cannot come back becomes a blocker that names the post, the file and the reason (no cloud copy, never uploaded, already deleted in the cloud, or a copy that did not match) with what to do. Getting files back needs a cloud service that can send them; until yours can, the blocker says so.
- What's new after an update. The update toast now reads "Updated to 2.11.0" with a What's new button that opens the notes you have not seen yet, newest first, once per install. Help & feedback names the version you run and links to the same notes. The notes ship with pendpost, so they also work offline (`GET /api/whats-new`).
- Long X posts. The X health check reads the account's subscription. With Basic, Premium or Premium+ an X post can be up to 25,000 characters: brand lint, the readiness check, the publisher, the composer counter and the thread hint all use that limit. An account without a subscription, or one never checked, stays at 280. X jobs pushed to the cloud carry the subscription too, so the cloud can apply the same limit.

### Changed

- Media first. Rows in Approvals, the planner List and Published start with the picture or video at its real shape. A text post shows a quiet platform tile in that spot, so every caption starts at the same edge. A bold title shows only where the platform publishes one (YouTube, Reddit, Pinterest, WordPress, Ghost); an Instagram caption reads as one paragraph of up to three lines instead of a bold first sentence and a grey rest. Week cards show the caption in one run, and a text post is a text card instead of a picture of its own words.
- Rows use the full width, with the actions at the trailing edge. Dates in Approvals read like "Mon, Nov 9 · 17:00", or Today, Tomorrow and Yesterday with the time, with a year only outside the current one. Row labels show only exceptions: the 720p warning, and a short type such as "Short" or "Video" without the platform name.
- Selecting posts is one slim line. In Approvals and the planner List the line reads "N selected" and the actions sit right beside the checkbox as icons: approve and reject in Approvals; approve, move, park or resume, fix with agent and delete in the List. Each icon's tooltip says how many posts it will touch, or why it cannot run. Clicking the checkbox clears the selection. Results and Undo arrive as one toast, and the keyboard shortcuts moved into the filter bar's "?" popover. The selection line and the day headings get their fill only while they are pinned at the top, so they never show as dark bands in the middle of the list.
- Approvals shows one solid approve button at a time: the bulk approve while you select, otherwise the one on the row you hover or reach with the keyboard. The other rows keep a light green approve. Selected rows are tinted in Approvals and the planner List.
- Group cross-posts, an icon toggle in Approvals beside the density toggle, off by default and remembered per browser. A Reel and a Short with the same media and time show as one row with a line per platform and Approve all. Counts still count posts.
- In the Week and Month views a published post shows a filled green check and steps back, while an approved post that is still waiting keeps the ring. Hovering a published chip shows View live, one link per platform, and only where pendpost can prove the link. In the Week view the days before today have grey labels.

### Fixed

- Older approved posts ask again after an edit. A post approved before pendpost recorded what you approved stayed approved through any content edit (caption, platforms, media, Also as story). The first content edit now sends it back for approval, and undoing the edit clears the ask, as on every other approved post. Changing only the time or the mode keeps the approval.
- A new cover or an agent's fix on an approved post keeps waiting for your approval. Before, a later reschedule or mode change could clear it, and the unreviewed cover could publish. Setting a cover and then removing it still asks again, since pendpost has no approved cover to compare with.
- Rows show the text each platform publishes: the YouTube description, the Reddit text, the Pinterest description, a WordPress or Ghost excerpt. Before, a YouTube row showed its title and nothing under it.
- About 140 faint brand tints in the Studio drew nothing: hover rings, tinted cards, button shadows and selected rows. They show again.
- A LinkedIn post you publish as yourself rather than as the Company Page now sends your profile to the cloud with the job. Before, the cloud refused it as a missing permission. It needs the matching cloud update; until then such posts keep failing closed.
- An Instagram story post with an image is blocked with a reason. Before, it was skipped without a word.
- A file git does not track, such as a backup in the data folder, no longer stops the Studio update with "commit or stash". Only edits to tracked files block it, and the toast says so before you click.

## [2.10.0] - 2026-11-02

Fixing gets shorter. Every post that is blocked or waiting on you now carries the one button that fixes it, and a Needs you tray at the top of the planner groups the problems by cause, so connecting a platform once releases every post that waited on it. Your agent can fix content problems too, on request or on its own behind a switch that is off by default, and every edit it makes comes back to you for approval. Radar 2.0 shows a few sharp asks instead of a long feed, reads more sources when you turn them on, and learns from what you do with each one. Every reply to you now lands in one list, Radar "Replies to you": comments and replies to replies on your posts, mentions, quotes, zaps, Google reviews and answers to your Radar replies. In the planner List you can select many posts and approve, move, park, fix or delete them at once, with Undo, and a deleted post waits 30 days in the trash. The Studio's owner-only routes now need a per-process token, and the one-click update says which version you run, which one is new, and what it is doing.

### Added

- A Needs you tray at the top of the planner. One line per root cause ("Bluesky not connected, 4 replies, Connect"; "LinkedIn needs a new sign-in"; "X refused the content") with the group's one fix, plus the system rows the old readiness panel carried (scheduler off, a plan or settings file that cannot be read, a Meta action block) and "Agent fixed N posts, ready to approve". Hidden when nothing needs you. A platform that is not connected but blocks no post stays on Setup, not in the tray.
- One fix per post, where the post is. A blocked or waiting post shows a single button in its List row, its Approvals row and its detail: Connect, Reconnect, Fix with agent, Open in editor, Resume publishing, Open cloud service, Copy and post yourself, or Discard draft. Key-based platforms (Mastodon, Nostr, Telegram, Discord, WordPress, Ghost and Bluesky) connect in a small dialog right there; a sign-in platform opens Setup with that platform selected and the reconnect already started. In All projects view the fix targets the post's own project.
- Fix with agent. When a post is blocked on its content (text over a platform's limit, a dead media link the post's own assets can replace, a subreddit rule), the button hands it to your connected agent. The agent reads the post and its check results, fixes only what blocks it, keeps the voice, re-checks and reports one line. While it works the post is held, and it may touch only that one post: its content fields, and its time only when an overdue time is the post's only problem. Never the platforms, the approval or any setting. Every edit sets the post back to "approve again", so nothing the agent changed goes out without you. Agents get the same through `agent_fix_post`; the routes are `POST /api/plans/:campaign/posts/:id/agent-fix` and `GET /api/agent-fix` (recent fixes per project).
- A switch "Let the agent fix content issues" under Settings > Autonomy (`posting.radar.agent.autoFix`, owner-only, off by default). When on, the scheduler queues a fix for a post that fails or is blocked on content, at most one at a time per project and never twice for the same text. A post that is blocked on a missing connection is never handed to the agent.
- Bluesky can be connected from the Studio: handle or email plus an app password, which stays on this computer. A Bluesky reply with no login now reads "Bluesky is not connected" with a Connect button, instead of "a permission is missing" and a Setup page without a Bluesky card. `node scripts/bluesky-social.mjs auth` proves the pair from the terminal. Bluesky stays a Radar reply lane; it is not a composer target.
- A delivery indicator. The sidebar card and the header show where each project in view publishes from: on the cloud or on this computer, with counts and a dot on the icon (green: the cloud is delivering; amber: needs a look, or publishing from this computer is paused; red: disrupted). Every dot has a name for screen readers, the tooltip names the projects, and the sub-line says the last run or the cloud's reason. The card also shows when the active project runs on the cloud.
- Radar 2.0, step 1: fewer wrong hits. A single-word keyword that is also an everyday word, a mixed-case acronym such as "bLink" or a term of three letters or fewer anchors only on an exact, case-sensitive match, or beside another keyword of the same search (`posting.radar.ambiguousTerms` adds your own). Hacker News hits keep the story body and the thread title, stay inside the lookback window, and a comment under another product's "Show HN" is dropped unless the thread names your brand. Bluesky search runs without a login against the public AppView, so every project gets the lane. With no agent provider set, hits the judge never read stay hidden and the Radar page says "Judge not configured".
- Radar 2.0, step 2: a judge that decides with context. For every candidate the judge answers four facts (intent, who is asking: seeker, peer, vendor, competitor or bot, whether you can reply there, and how fresh it is), and the engine derives the action from those facts, never from the score: vendors, competitors and bots are dropped, only a seeker in a replyable place with a real intent is an ask, everything else is watch at most. The judge reads the thread title, the author's name and bio, the post age and the reply count where the lane returns them for free. The Radar inbox shows the top `posting.radar.dailyTarget` asks (default 5) and never pads; the rest sit under one collapsed "More signals" row. Your ordinary actions teach it: Done, a bulk sweep, a copy you posted by hand, a reply you queued, and a reply the author answered all become examples for the judge.
- Radar 2.0, step 3: more sources, each an optional switch under Settings > Radar searches > Extra sources with its cost line, hidden while its credential is missing. X recent search through the X API (`posting.radar.x.search`, owner-only, about $0.005 per post read, paused at `posting.radar.x.monthlyReadCap`, default 3000 a month; `posting.radar.x.lists` reads your X lists). Any RSS, Atom or JSON feed per search (`posting.radar.sources.feed.scan` plus a search's `feeds`; private and loopback hosts are refused unless you list them in `posting.radar.feedAllowPrivate`, for a self-hosted RSSHub). GitHub issues and, with a `GITHUB_TOKEN`, discussions (`posting.radar.sources.github.scan` plus a search's `githubRepos`). A watchlist (`posting.radar.watchlist`) keeps named people in view: their posts anchor without a keyword and rank higher in the inbox, and the people you act on are offered for it, never added by themselves. Reddit without a connected app now says "limited without a connected app" with Connect.
- Radar 2.0, step 4: bring your own research tools. `posting.radar.agent.extraTools` lists exact read-only MCP tool names (`mcp__<server>__<tool>`) from your own Claude user config that the scan child gets next to its usual tools, so an Exa or similar search you already pay for reaches fresh posts before a search engine indexes them. The list is owner-only, changed in the Studio or `config.json`, never through `config_set`, and wildcards, built-ins, write verbs, the pendpost server and browser servers are refused. The GEO check turns the threads AI answers cite into evergreen Radar signals (`radar_footprint_log` takes `citedUrls`): they never age out and the judge classifies them like any other find.
- Cloud recheck. "Check again" on a cloud problem now really probes the cloud (reach, worker liveness, subscription) instead of re-reading the last state, "Send again" pushes the brand and rechecks, and a stopped sync offers "Raise limit". Agents get `cloud_recheck`, the twin of `POST /api/cloud/recheck`. A stale-worker warning expires once its health check ages out, and an idle brand that still carries one is re-checked every five minutes, with zero cloud calls while healthy.
- A per-process Studio token (spec 56). The server mints one random token at boot, hands it to the Studio through `GET /api/session` (same-origin only) and writes it 0600 to `~/.pendpost/studio-token` (`studio-token-<port>` off 8090; `PENDPOST_STUDIO_TOKEN_DIR` moves the folder). The Studio sends it as `X-Pendpost-Studio-Token` on every write. Owner-only effects on the REST face (owner config keys through `POST /api/config`, Radar triage and replies counted as your own actions, and the update route) happen only with the token; a call without it runs at agent level, a wrong token is refused. Your own scripts read the token from that file.
- One-click update also covers a checkout whose HEAD moved locally and restarts the server when it is idle. The Studio notice names the installed and the new version ("Installed: 2.9.0 (a1b2c3d). New: 2.10.0 (f4e5d6c)"), walks the real steps (downloading, installing, waiting for a publish run or the Radar agent to finish, restarting), reloads by itself and then says "Updated to 2.10.0". A refused request, a failed step or a restart that never comes back is one sentence plus Try again; a dismissal is remembered per offered version, and the version you already run is never offered. `GET /api/dashboard-update` is the light status read the Studio polls.
- Deleting a post moves it to its campaign's trash for 30 days instead of removing it for good, and `restore_post` (or `POST /api/plans/<campaign>/posts/<postId>/restore`) puts it back where it was. Your own restore in the Studio keeps the approval of unchanged content; a restore by an agent, or by anything without the Studio token, brings an approved post back for review, so an agent cannot undo your delete into a publish.
- Replies to replies. Radar now reads the answers to comments on Instagram, Facebook, YouTube, Reddit, Discord and, where the Community Management product is granted, LinkedIn. Busy posts are paged within fixed caps (`READ_CAPS` in `lib/comments.mjs`: 5 pages, 300 items, 20 nested reads, 20 s per post). When a cap cuts a read short, what was already found stays in the inbox instead of being dropped as deleted.
- Nostr in full: replies at any depth from every configured relay, plus zaps (who zapped, how many sats, the zap note), reposts and quotes.
- Mentions outside your posts. Mastodon and Bluesky notifications (Bluesky with the app password you already connected), the Reddit inbox and Nostr `#p` tags bring in mentions, quotes and replies that no per-post read would see. One that answers a post of yours lands under that post.
- Answers to your Radar replies from anyone, in any round, arrive as `radar-reply` items. Before, only the original author's first answer counted. The "Author replied" signal works as before. A follow-up reply can now thread under any of those answers too, not only under the original author's.
- Google reviews and cached cloud X events come in on the same 4 hour sweep. You no longer have to open the Reviews panel to see a new review.
- The Radar daily digest gets a line for replies ("Replies to you: 3 new since yesterday, 7 still unanswered"). New replies also send one push per batch to Telegram and macOS, counting only what is new since the last push.
- A `replies` mock scenario for the Studio UI tests (`.claude/ui-tests/lib/replies-scenario.cjs`).
- Activity labels a restored post ("Post restored") beside "Post deleted".
- Select many posts in the planner List and act on them at once. A checkbox appears at the start of a row on hover or keyboard focus (or press `x`), and on every row once one is picked; shift-click picks a range, a day heading's checkbox picks the whole day, and "Select all N in this view" picks everything the current filters show. An X thread counts as one: picking one tweet picks the chain. Esc clears.
- Bulk actions in the List: Delete, Approve, Move, Park or Resume, and Fix with agent, always in that order. An action that applies to none of the selected posts is greyed out and says why on hover or focus; it is never hidden. Delete asks nothing: the posts go to the trash and one toast ("4 posts deleted") offers Undo for 10 seconds. Approve skips a post on a platform that is not connected. Move shifts by a number of days or onto one date, keeping each post's time, and has Undo too (the old times come back). A post on Facebook or YouTube's own schedule asks per post. Fix with agent takes only posts whose problem is their content, one at a time. In All projects view every action goes to the post's own project.
- One line under the actions says what a press will leave out ("3 will not be approved: LinkedIn not connected", with Connect) and, after the run, what did not happen and why ("1 not deleted: Launch post is published"). The posts that went through leave the selection, the buttons keep their verbs, and every run ends with one toast in the same pattern. A Radar reply approved after its time had passed goes out 5 minutes after the approval, and the toast says so.
- Keyboard in the List: `j` and `k` move between rows, `x` selects, Enter opens the post, `e` opens it in the editor (a post the editor cannot show, such as a Bluesky Radar reply, opens its detail), Esc clears the selection. Keys typed into a field stay there. The bar shows the keys while nothing is selected.

### Changed

- The planner List uses the full width. Each row leads with the platform icon, then the title, and text posts show two lines of their caption instead of a placeholder thumbnail; media posts keep their real thumbnail at the end of the row, so every title starts at the same edge. A post that needs you gets one status line under the title: an alert icon, the plain reason and its fix button, in place of the status pill. The row menu sets Delete apart from the rest.
- Approvals is calmer. Each row has one action: Approve, or the fix when a platform is really not connected. Reject and Copy and post yourself sit in the row menu, the action sits in the same place on every row, the campaign name (now "Release 2.10.0", not "Release 2 10 0") moved into a tooltip on the date, and text posts show their title and two caption lines instead of a small text box. The "Publishing as" strip says "X not connected" with Connect, and it is hidden in All projects view, where one strip cannot be true for every project.
- One count everywhere. The header badge, the tray and the new "Needs you" status filter count the same set: posts that are blocked or waiting on you, plus the system rows. The badge and the tray use the same mark, the tray shows three causes and folds the rest under "n more", and the badge opens the List with that filter and the tray in view. The sidebar "Waiting on you" pill is gone; the next-post chip in the sidebar shows an alert when that post will not go out.
- A cloud problem changes the delivery icon itself, not only its dot, shows its reason with an alert icon on the sidebar card, and becomes a tray row naming the affected projects with "Check again". Clicking the card opens the 24/7 cloud service page with every project and where it publishes. The card's button reads "Pause publishing from this computer" or "Resume publishing", "Last run" reads "Last checked", and the Studio no longer says "scheduler" or "machine" where it means this computer. The "Keep publishing when your computer is off" card moved from the planner to the 24/7 cloud service page, so on a phone the posts start on the first screen.
- A post's detail explains the problem on one card for both blocked and waiting posts: what happened, why, the one fix, and a Details disclosure with the engine code, the platform, the last attempt and the number of failed attempts. The delivery row and the pre-publish card no longer offer a second connect for the same platform.
- A platform that was never connected reads "not connected" wherever a post mentions it, instead of "a permission is missing".
- Radar scans search in the language of your searches, not the dashboard language: a de-CH Studio over English searches now searches in English. The default lookback is 7 days (a saved `posting.radar.lookbackDays` still wins), and agent-found signals older than the lookback age out unless watched or evergreen.
- Search precision in Radar counts only what you did: Done and a published reply as precise, Not relevant and a bulk sweep as imprecise, unread finds as neither. A search nobody rated shows no precision instead of 100%, the tuner's weekly rule waits for ten rated finds, and the Radar page's precision line says so.
- Optional Radar sources show one line each in a scan: "paused, the monthly read limit is reached" for X at its cap, "limited without a connected app" for Reddit without OAuth.
- `GET /media` no longer serves dotfiles or dot-folders, and `asset_upload` refuses a source path with a dot segment or the Studio token file, by file identity, so a renamed or linked copy is refused too.
- The 2.9.0 notes said config writes go through `PUT /api/config`; the route is `POST /api/config`.
- The Studio stops asking to update after every local commit. If only commits in this computer's checkout moved and the version number did not change, pendpost installs them on its own. It waits until no new commit has landed for 10 minutes and nothing is publishing or running an agent job, then rebuilds and restarts; an open Studio reloads and shows the usual "Updated to" note (unless you are typing). A new version from GitHub, or a version change on disk, still shows the update toast. A read-only or hand-run server never updates itself this way. Set `PENDPOST_QUIET_UPDATES=0` to get the toast back for every change.
- `comment_inbox` and `GET /api/comments/inbox` add `elsewhere[]` (items not tied to one of your posts, each with a `ref`), `byKind`, and an `unanswered` count over both lists. Every item carries a `kind`. `comment_resolve` resolves any kind by its key, and a resolved item never comes back under a different key.
- A platform you cannot read with the logins you have (X, LinkedIn without the Community Management product, Discord without a bot token, TikTok without the comment scope) reports `needs_owner`. It used to look like zero replies.
- Radar "On your posts" is now "Replies to you": one list, newest first, of every reply to you. Comments and replies under your posts sit beside mentions, quotes, reposts and zaps elsewhere, Google reviews, X activity and answers to your Radar replies. Each row names its kind with an icon and a word for the event ("Replied", "Mention"), shows the author, the text, the time and what it belongs to, and a reply to a reply shows its parent in one quiet line. Reply opens a field right in the row, labelled with who the answer goes to and where it is public ("Antwort an Pia Steiner, öffentlich auf Google"), with Send on the right; it answers the newest message of a post, a Google review, an X event, or an answer to your Radar reply (queued for approval under that comment, next to "Open in Radar", which lands on the Radar card). A post's whole thread sits behind a quiet History toggle that carries the open count. Done takes a row away with "Done · Undo"; the row is marked handled only once the undo window passes. A zap or repost offers no Reply and no like, and a zap shows its sats only when the amount is verified. The segment label carries the unanswered count. A platform pendpost cannot read shows one line with its fix: Connect, Reconnect, or for a block only you can lift ("LinkedIn needs you") what the platform needs and a link to its Setup card, instead of counting as zero.
- A post's Comments panel threads replies to replies one level under the comment they answer.
- The filter bar has two rows where a status filter applies (the planner and Approvals' "All posts"): status tabs with live counts, then the platforms as icons, Type and Reset. The tabs are All, Needs you, Drafts, Awaiting approval, Approved, Published, and More for Rejected, Overdue and Parked. They use the same words as the post's status, every post sits under exactly one tab, so the counts add up to All, and the "?" legend closes the tab row. A count follows the platform and type filters. The Status dropdown is gone. Pages without a status filter keep one row. On a phone the tabs stay on one line and scroll.
- A post that is out reads "Published" even when it was marked posted without an approval, and a parked post reads "Parked" even as a draft.
- The planner List spans the whole panel like Approvals. Titles and captions stop near 90 characters so lines stay readable. The time, the status line and the row actions keep fixed columns at the edges, and a row lights up on hover. Day headings stay at the top while you scroll, right under the bulk bar. The bar keeps its place before anything is selected, so picking a post never moves the rows. On a phone it floats at the bottom of the screen while something is selected.
- The Needs you tray follows the platform and type filter. On a phone it starts folded to its title, so the first post starts in the top half of the screen.

### Removed

- The Inbox chip on Activity and the X event feed and Google reviews blocks it showed. Both now live in Radar "Replies to you"; their audit rows stay in the Activity log under Other.

### Fixed

- Instagram comments no longer show the author as "unknown" without a reason (pendpost/pendpost#44). Meta only says who wrote an Instagram comment, and only accepts replies to it, when the token has `instagram_manage_comments`, and the Meta setup never asked for it. The setup guide, Setup card and `setup-system-user` now ask for it, and `setup-system-user` warns when the token lacks it. When Meta withholds every author, the comment inbox shows a "Meta needs you" line that names the permission, and `comment_inbox` carries a `meta` `needs_owner` row (still `ok: true`). The Meta comment-scope hint now names `instagram_manage_comments` instead of the Instagram Login permission.
- The update notice no longer disappears and comes back. Before, a dismissal lasted one page load, the click put up a guessed spinner that fell back to the offer after a minute, a rebuilt bundle said "ready" while the old server still waited to restart, and a stale status file could offer an update to the version already running.
- An image post whose preview had not been checked yet rendered as a broken video and fell back to a document tile in the List, the Week view and the queue. It reads as an image again.
- A thread cited by an AI answer on another Mastodon instance no longer becomes a Mastodon-lane signal with that instance's status id, which on your home instance names a different post. It is a web thread now, so a reply cannot land on the wrong status.
- A vendor, competitor or bot that an agent reports to `radar_ingest` affects only that fresh candidate: no cached signal is removed and no triaged entry is replaced. Implicit judge examples are written only for actions you take in the Studio, never for an MCP call that merely claims to be you, and a published reply counts as yours only when a human approved it.
- In All projects view, a post is checked against its own project's connections. Before, every post was checked against the active project, so a project with X connected showed its X posts as "Blocked, X is not connected" whenever another project without X was active.
- The delivery card's sub-line no longer truncates in the narrow sidebar, and the tray and List rows fit a 375px phone.
- The tray's scheduler row says Setup comes first instead of offering a grey Start while Setup is unfinished.
- Brand lint counts an X caption the way X does (a link as 23, CJK and emoji as 2), like the readiness check and the publisher. Before, a link-heavy tweet X accepts was refused at approval as over 280, and a CJK or emoji tweet X refuses passed the lint.
- Telegram comments show only under their own post, with the reply chains in the discussion group. Each comment used to appear under every post.
- WordPress comments held for moderation now show up.
- A cloud post that pendpost is still retrying now shows a grey dot in the delivery popover and on its project row on the 24/7 cloud page. Its post detail and planner card were already grey; both rows showed red. A failure that no retry can fix keeps its red dot. The popover now reads a failure the way the post detail does, so a refusal that needs you, such as X's reply rule, no longer says "pendpost will retry" there. For agents, `cloud_status` issue rows now carry `recovery` and `halted`.
- The lines on the sidebar delivery card wrap to a second line instead of being cut off, in every state. At 1280 px, "Cloud not publishing" still ended in "...".
- A cloud that answers but does not publish has one name: "Cloud not publishing" ("Cloud veröffentlicht nicht") on the sidebar card, in the Needs you tray, in the delivery popover and on the 24/7 cloud page. The popover and the cloud page used to call it "Cloud is paused", which read like this computer's own pause. The longer explanation stays in the tooltip.
- Activity names a post by its title, or "a post in <campaign>" once the post is gone, instead of raw ids such as "bulk-8hje9 / thread-3-8hje9".
- Secondary text in Radar "Replies to you" and the segment labels across the Studio reach 4.5:1 contrast in light mode.
- Radar "Replies to you" no longer lists your own replies as waiting for an answer. A comment you answered on the platform itself (Instagram, Facebook, YouTube, Mastodon, or LinkedIn with the Community Management product) leaves the list for good. Both used to inflate the unanswered count, the digest line and the push alerts.
- On a phone the planner List shows every checkbox, so a tap starts a selection, and the bar offers "Select all N". Each row says its time and status under its title. The time no longer takes its own column there, so a caption keeps its width next to a thumbnail.
- On a phone the bulk bar's actions are 44 px with room between them. Tapping one that cannot run says why in the line under the actions.
- A List row that needs you keeps its approval status (Approved, Awaiting approval) next to the red reason. The tabs still count it once, under Needs you.
- After Approve, the line under the bar names every post that stays selected: a platform not connected, already approved or published. Undo clears the "not deleted" line.
- The status tabs never wrap: at 1024 px the ones that do not fit move into More. On a phone the tab strip fades at the edge where more tabs wait, and it only scrolls sideways.
- A post's ⋯ menu no longer offers Approve when its platform is not connected, the same rule the bulk bar follows.
- Approving a Radar reply after its time, from a row's menu, Approvals or the post detail, now says it goes out 5 minutes after the approval, as the bulk bar does.
- Grey text on grey cards reaches 4.5:1 contrast: the post detail's "Pending" and about 220 more spots across the Studio. A Bluesky reply's detail no longer shows an empty "Platforms" heading.
- An answer that goes through Approvals (a reply to an answer to your Radar reply) is sent with "Send for approval" / "Zur Freigabe" instead of "Send".
- An answer to your Radar reply whose signal was archived can still be answered (queued under that reply); the dead-end "Open in Radar" is gone from that row.
- On a phone the "Replies to you" platform lines fold to one line with Show, so the first reply starts in the top half of the screen.
- One Radar signal reads "1 signal" / "1 Signal" and "Dismiss the 1 shown" / "Den 1 angezeigten entfernen", never the plural.
- "History · N waiting" counts exactly the messages the opened thread marks as open, and the list keeps room for a toast so it never covers a row control at the end.

### Security

- Every Nostr event the inbox shows passes the NIP-01 id and BIP340 signature check before it is deduplicated or classified. A rogue relay can no longer inject a reply, mention or zap, or hide a real event behind a forged copy with the same id. Each relay gets its own check budget, so one noisy relay cannot crowd out the others.
- A zap needs a signed zap request that names you and matches the invoice amount. Its sats count as verified (`amountVerified`) only when your own Lightning provider issued the receipt; otherwise the zap shows, but its sats are never added up. Quotes and reposts count only when they target one of your notes.
- A reply-list item that is not on one of your posts (a mention, zap, review or Radar answer) can no longer outlive the 14-day window or jump to the top by claiming a future date: expiry uses the earlier of its own time and when pendpost first saw it, a time more than 10 minutes ahead is replaced by the receive time, and that part of the list is capped so a flood cannot push your real replies out: at most 20 per author (by platform id or unique handle, never a display name), 200 per platform and 500 in all, with room always kept for newly seen items, shared fairly between platforms and then senders.
- Nostr signature checks are about 8 times faster (Jacobian coordinates instead of one modular inverse per step).

### Dependencies

- Cleared the open npm audit advisories in the website (`fflate`) and video (`zod`, `fast-uri`) toolchains with lockfile-only updates. The published engine has no runtime dependencies.

## [2.9.0] - 2026-10-28

Approving gets clearer. Every refusal and every pre-flight check in the Studio now says what is wrong, why, and the one thing that fixes it, in your dashboard language, so the review queue no longer ends in "Something went wrong". YouTube uploads carry the right language, a category and the AI disclosure, and brand-lint runs when you approve, not only at publish.

### Added

- An approved post shows when its approval expires if `posting.approvalExpiryHours` is set, and warns in amber when the approval would lapse before the post's slot, so you can approve it again or plan it earlier (#43).
- A Draft replies switch under Settings > Autonomy > Respond for me turns Radar's reply drafting off and on (`posting.radar.drafting.enabled`). The two drafting knobs show only while drafting is on (#42).
- YouTube category and AI disclosure per post (#39). Set `youtubeCategoryId` (one of YouTube's assignable category ids, such as `"22"` for People & Blogs or `"28"` for Science & Technology) and `containsSyntheticMedia: true` (the altered or synthetic content label) on a post through `plan_create_post`, `plan_update_post` or the `/api` post routes. A brand-wide default category lives in `posting.youtube.defaultCategoryId` (set it with `config_set`); without one, videos stay under Education (27) as before. The disclosure goes out with the upload, again when pendpost releases an overdue scheduled video, and on a video already published when you add it later and push the edit. Editing a published video keeps its category unless the post sets one. When a post sets its own category or the disclosure, Check shows it, so you see it before you approve. Posts that are already approved keep their approval after the upgrade. Requested in GitHub issue #39.

### Changed

- Every approval refusal and every pre-flight check in the Studio now has its own sentence in your dashboard language: what is wrong, why, and the fix. An Edit or Setup button appears only where it actually fixes the problem. Before, a refusal such as a dead image link showed only "Something went wrong".
- A check that blocks a post shows in red and disables Approve before you click. Advice that does not block shows in grey. A refusal stays on its card until the post changes.
- The New post composer starts on a platform you can see. With only one platform it skips the platform hint, and field labels name only the platforms that field applies to. With no platform connected it says so and links to Setup (#41).
- Brand-lint now runs when you approve a post, not only when it publishes (#40). If a platform's caption (its own caption, such as the X text, or the shared one) breaks a brand-lint rule, the approval is refused with `lint_blocked` and a list of what failed per platform, so you fix it while you are still looking at the post instead of finding a platform quietly skipped at its slot. Fix the caption or remove that platform, then approve again. `force` does not override it. Lint warnings never block; they come back with the approval as `lintWarnings`. The same applies to `approve_post`, the `/api` approve route, auto-approve, Radar auto-replies and the client review link, where the reviewer sees a plain sentence saying the agency has to fix the text first. The check at publish time stays as it was. Requested in GitHub issue #40.
- An Instagram or Pinterest image that lives on your own site and is not online yet, such as a blog article's preview card that appears on release day, no longer blocks approval. If the link is on the same site as your public media folder (`posting.publicMediaBaseUrl`) but outside that folder, and the post is scheduled for later, pendpost approves it and lists the link as pending media. The link still has to work when the post is due: if it does not, the post is not sent and waits for you. A dead link anywhere else is still refused at approval, now with the link and platform named, and the `/api` route answers 409.

### Fixed

- The New post composer no longer pre-selects a hidden Instagram when Instagram is off or skipped, so a new post can't carry a platform you never saw (#41).
- Changing Radar's drafting knobs no longer turns reply drafting back on after you switched it off (#42).
- An approval no longer expires on a post that is already scheduled on the platform (YouTube, Facebook, WordPress). Before, it went back to review while the platform still published it.
- Editing an already published YouTube video keeps its category and language, and sends an AI disclosure you add later.
- X posts are counted the way X counts them (every URL 23, every emoji and CJK character 2) at approval, at publish and in the Composer. Before, a link-heavy post could pass approval and then be refused at publish for its raw length.
- YouTube checks match the Data API: title 100 characters, description 5,000 bytes (umlauts and emoji take more than one), no `<` or `>`, tags 500 characters counting commas and the quotes around tags that contain spaces.
- Instagram carousels can have up to 20 slides, as Meta now documents (was 10). Facebook albums stay at 10.
- Public pages corrected: /privacy lists all four YouTube permissions pendpost asks for, /radar describes the owner-only auto-reply switch, and the Postiz comparison describes its preview-link sign-off.
- The blog social reconciler (`scripts/reconcile-blog-social.mjs`) now runs every draft through the same length caps and brand-lint the Studio uses before writing it. A draft that would be flagged is still created, and the run lists each one with the reason, so you know which posts to shorten before approving. The blog writing guide now states the per-platform caps for social copy.
- Mastodon posts are counted the way Mastodon counts them: every link is 23 characters whatever its length, a mention like @name@server counts as @name, and an emoji counts once. Before, a link-heavy post that Mastodon would accept was flagged as over 500 at Check, at approval and at publish.
- YouTube uploads are no longer always marked as German (#38). The video's language and audio language now follow your content language (`posting.contentLanguage`, or the dashboard language when that is empty), so `de-CH` sends `de` and `en` sends `en`. This applies to new uploads and scheduled Shorts; editing a video that is already on YouTube keeps the language it has. Reported in GitHub issue #38.
- `PENDPOST_MODE=mock npx pendpost` starts again. Since 2.2.0 it exited with "mock mode refused", because under npx the data folder was the npm cache. Mock mode without `PENDPOST_ROOT` now runs in a private demo workspace in your temp folder (created 0700, refused if another user could write to it) and opens on the example Acme campaign. An explicit `PENDPOST_ROOT` still has to sit inside your temp folder in mock mode.

## [2.8.0] - 2026-10-27

Facebook Pages get photo and carousel posts, drafted and checked the same way as everything else and sent from your computer. Radar can now research and score signals with reply drafting turned off, for the workflow where every reply is written by hand. And the docs finally match the code on mock mode: pendpost runs live unless you ask for mock, so an unconnected lane is never mistaken for a safe sandbox.

### Added
- You can turn Radar's reply drafting off while keeping its research and scoring. Set `posting.radar.drafting.enabled` to false (through `config_set` or `POST /api/config`): a scan still researches, ranks and scores signals into your feed, it just skips drafting replies, so a run no longer spends agent budget on drafts you were going to write by hand. On by default, so nothing changes unless you turn it off. Requested in GitHub issue #37.
- Photo posts on your Facebook Page. Pick Image for a single-photo post or Carousel for a multi-photo post (up to 10 photos) on a post that includes Facebook, so a weekly carousel can reach Instagram and Facebook together. pendpost uploads the photos straight from your computer, so Facebook needs no public image link. Alt text goes with every photo, and Check flags what Facebook would refuse before you approve: a video slide in a carousel, a photo over 4 MB, or a format other than JPEG, PNG, GIF, BMP or TIFF. Agents get the same through `plan_create_post`, `platform_validate`, `verify_post`, the insights sweep and the comment inbox, and the whole loop runs in mock mode without credentials. Facebook photo posts are sent by pendpost on your computer at their time; the always-on cloud does not carry them yet. Your Meta token needs the `pages_manage_posts` permission for them. Requested in GitHub issue #7.

### Changed
- On a Facebook-only post the format menu now offers Reel, Image and Carousel. It no longer offers Text and Video, which Facebook in pendpost never published.
- Comments on Facebook Page posts and Facebook reels can be read, answered and hidden from the comment inbox. A post that went to both Instagram and Facebook now shows the comments from both, and each answer goes back to the network the comment came from.

- On a brand the always-on cloud manages, the cloud now publishes Facebook too: reels, single photos and photo carousels. A carousel that goes only to Facebook needs no extra setting; Instagram and mixed carousels still follow the carousel switch.
- When Facebook does not confirm a publish (a server error, a dropped connection, or pendpost stopping mid-call), pendpost notes the attempt before it sends anything, waits a few minutes, and then looks at your Page. If the post is there, it is recorded as published; if not, pendpost publishes it. If it cannot tell, nothing is posted again and the post waits for you with a short note on what to do: look at the Page, then mark the post as posted, or confirm Try again to publish it once more. Only you can release such a post, never an agent. pendpost never posts the same thing twice on its own, on your computer or in the cloud. A Facebook photo post without a caption now gets a warning in the check, because pendpost cannot recognise it on the Page.

### Fixed
- pendpost no longer says Facebook posts are scheduled on Facebook and go out with your computer off. They go out at their time from the cloud when it is on, otherwise from your computer.
- A carousel whose slides are listed by file name in the plan now reaches the cloud; before, the upload looked in the wrong folder and skipped the post.
- On a brand the always-on cloud manages, posts the cloud cannot send (Facebook photo posts, and Instagram carousels and feed images unless the cloud carries them) went out about 20 minutes late, because pendpost first waited for the cloud. They now go out on time from your computer.
- The docs and quickstart no longer say pendpost falls back to mock mode when no credentials are set. Since 2.7.0 pendpost runs live unless you set `PENDPOST_MODE=mock`; a lane with no credential is live-but-unauthenticated and waits for you to connect it rather than quietly faking a publish. The quickstart, the mock-mode and credentials pages, `CONTRIBUTING.md`, `SUPPORT.md`, `AGENTS.md` and the website now say so. Reported in GitHub issue #36.
- The dashboard build works again. An unintended `tailwindcss` v4 bump had broken `npm run build` (the app's PostCSS and Tailwind config target v3); pinned `tailwindcss` back to v3 to match the config.

## [2.7.0] - 2026-10-14

This release is about signal over noise. Radar now finds people who actually need you instead of every comment that happens to contain a keyword, and it learns from one tap. pendpost stops crying wolf: a message reaches you only when pendpost cannot fix the problem itself, and it names the one fix. LinkedIn and X sign-ins renew themselves well ahead of expiry, including in the always-on cloud. Every error in the Studio now reads as a plain sentence, with the raw technical line one tap away behind a "?".

### Added
- A relevance judge for Radar's keyword lanes. Candidates from Hacker News, Mastodon, Bluesky, and Reddit go to a small, fast model together with your audience, the search's brief, and your past feedback. It keeps real people asking, evaluating, or complaining, and drops vendors, bots, news relays, happy users, and off-topic posts. Without an AI provider, or when the judge fails, candidates stay below the visible threshold instead of flooding the feed.
- Pre-filters before anything reaches the Radar feed. A search phrase must appear as a phrase, within a few words, and bots, relay domains, muted authors, your own accounts, wrong-language posts, and duplicates are dropped. Each scan reports what it dropped and why.
- One-tap "Not relevant" on every Radar row, with Undo. The post becomes a negative example for its search, and two taps on the same author or domain mute it (never a shared host such as a large Mastodon instance). The "By search" view now shows how relevant each search is.
- A Radar query tuner. After five "Not relevant" taps on one search, or weekly, it reviews that search and applies narrowing changes itself: exclude words, mutes, a higher minimum score, or pausing a search that finds almost nothing. Every change is logged and can be undone. Broadening changes, such as new keywords or channels, arrive as a suggestion you apply or dismiss. Agents get the same controls through the `radar_tune` tool.
- Reddit in Radar without connecting an account. An unconnected Reddit lane reads Reddit's public search feed, read-only and gently paced, and replies there become copy-paste drafts.
- Opt-in LinkedIn Community Management scopes per brand. Set `LINKEDIN_CMA=1` in a brand's `.env` when your LinkedIn app holds the Community Management product, and sign-in asks for the statistics and comment scopes, which opens LinkedIn statistics and comment reads. It stays off by default, because LinkedIn refuses the whole sign-in for a scope the app lacks.
- A terminal sign-in now reaches the running pendpost and the cloud vault. After `auth` for LinkedIn, X, Meta, Telegram, Discord, or Nostr, pendpost rechecks that lane at once and a cloud-managed brand is resealed, instead of the cloud keeping the old token until a later check.

- The cloud icon in the header lists each cloud problem with its one fix (Neu verbinden, open the post, or check again), across every always-on project, and the Cloud page pill tells the same story. A failure for a post you have since moved into the future no longer shows.
- Steer Radar from a signal row: "Mehr davon" and "Weniger davon" teach the agent scan by example, and the search chip opens that search to edit or remove.
- Every status and technical detail in the Studio sits behind one tappable "?" that works with a finger or a keyboard, and every measured button and link has a 44px target.

### Changed
- LinkedIn sign-ins renew 14 days ahead of expiry instead of 5, X sign-ins now renew on a daily check too, and the cloud reseals right after. The LinkedIn refresh token, its expiry, and the app's client id are now sealed into the cloud vault, so the always-on cloud can renew LinkedIn by itself. A sign-in expiry shows in Setup only when a lane cannot renew itself, and a refresh that fails keeps the still-valid token.
- Insights stops crying wolf. Each platform is checked on its own, a loop stops at the first lane-wide refusal, and a state is logged only when it changes. A LinkedIn post with no activity yet reads as no data rather than a failure, a statistics refusal caused by your Page role says to ask for the admin role rather than claiming a missing scope, and a Meta post deleted on the platform reads as gone, not as a lane error.
- Radar budget and usage-limit skips are neutral notes, not failures, and repeating engine crash rows are de-duplicated.
- Radar matching is friendlier to German and Swiss spellings: ß and umlauts fold together in keywords and exclude words, Hacker News searches each keyword as an exact phrase, and Bluesky searches honour the query language.
- A cloud push whose confirmation never arrives now turns amber after ten minutes, so posts quietly going out from your computer instead of the cloud are visible. A cloud sync that is healing reads as a wait, not a warning.
- Approving a post on a platform you skipped at onboarding and never connected is refused with the fix ("Connect it in Setup or remove it from the post"), instead of failing later at publish.
- The overdue and failed chip counts late posts in every project, not only the one you are viewing, and a click opens the all-projects view when the late post lives elsewhere.
- Red now means act now. A failure pendpost retries by itself reads neutral on the planner card, the List row, the post banner, and Radar's lane rows, and only something you have to fix stays red.
- On a phone the Planner opens on the List. Week and month are one tap away and scroll inside their own box, so the page never scrolls sideways.
- A post chip in the month view shows its status word on hover and keyboard focus, and a tap still opens the post.
- Key-based lanes such as Nostr reconnect in place: "Neu verbinden" opens the key form right in the card without disconnecting first, and a bad key and unreachable relays each get their own plain sentence.
- Radar's auto-reply panel folds into one line above the feed once your reply channels are ready.
- Status pills and the next-step chip on approval cards no longer keep information in a hover-only tooltip that a phone or keyboard cannot reach.
- The website got a light motion pass: the hero animation and background film pause when off screen, menus and the download tabs fade and slide in, the agents loop reveals step by step on scroll, cards lift slightly on hover, and every copy button shares one helper with a check-mark confirmation.

### Fixed
- Mastodon replies to posts that Radar found on another instance are resolved on your home instance before replying, thread links never pair your home host with another instance's post id, and a failed lookup stays retryable instead of marking the target as gone for good. A Mastodon Radar reply is owed only once it is due.
- Timeouts, rate limits, and server errors from a platform (408, 429, 5xx) are treated as temporary and no longer count toward parking a post. An Instagram processing hiccup reads as temporary, not as a rejected post, and the Instagram upload step is named when it fails.
- Raw error sweep across the Studio. Approvals, Planner, post detail and row actions, Composer, thread composer, Setup, Radar feed and settings, comment inbox, Activity, Insights, review links, the autonomy ledger, the client switcher, and first run now say a plain sentence when something fails, with the raw server line behind a "?" instead of in a toast, a hover title, or a raw locale key. A test guard fails any component that renders a raw error line.
- A failed cloud copy after a reconnect has its own message and fix, rejected posts read as inactive, the pending count is correct, and posts that owe no media no longer report media as missing.
- Rescheduling, editing, or re-approving a post clears its old failure, so a post you fixed no longer shows yesterday's error.
- A malformed Nostr signing key parks the post with a reconnect action instead of retrying it.
- A saved or removed cloud spend cap closes its editor and refreshes the meter.
- When pendpost cannot reach the cloud, the log and the cloud status name the network cause (for example a failed DNS lookup or a connect timeout) instead of a bare "fetch failed".
- The cloud backstop never re-fires a post the cloud already has. When pendpost cannot get an answer from the cloud about a post the cloud acknowledged, it waits instead of publishing it from your computer, so a post the cloud already sent cannot go out twice. The wait shows in Activity, and after two hours the post asks you to check the cloud connection. Posts the cloud never received still go out locally as before.
- A burst of Studio requests can no longer stall pendpost for minutes. Reads no longer rewrite the state file or re-parse the config, and the plan views are reused between saves.
- Insights says when a platform has not refreshed for more than two days, on the Insights page and in the nightly summary, instead of logging it once and going quiet. A sweep that runs while the computer is offline records nothing and runs again once the network is back.
- Touch targets in the Planner's month view, including the "+n more" button, meet 24px on a mouse and 44px on touch, and the blocked line on an approval card wraps cleanly on a narrow phone.

- Posts that keep failing park sooner and say why: engine crashes, silent skips and blocked rows now count toward the three-attempt cap, and content errors stop after the first failure.
- A local credential failure waits for you with "Neu verbinden" instead of retrying three times, and a passing check releases it.
- A post rescheduled into the future is never fired from an old cloud job, the cloud refuses a delivery whose time no longer matches, and a cloud run that published nothing is no longer recorded as a failure.
- Signed publish receipts survive numeric platform error codes, and one failing platform no longer drops the receipts of the others.
- Reddit posts that cannot pass Reddit's pre-submit checks become a visible failure instead of being skipped quietly.

### Dependencies
- Cleared every open npm audit advisory in the app, website, and video toolchains with lockfile-only updates. None of these reach the published engine, which has no runtime dependencies.
- The app moves to React 19.3 and Vite 8.3, the website to Astro 7.3, and the test setup to jest-axe 11. The website's caching and image libraries were updated to clear two high advisories.

## [2.6.1] - 2026-09-23

This release cleans up Radar's feed and adds honest comparison pages to the website.

### Fixed
- Radar stops treating everyday words as competitor mentions. A competitor whose name is also a common word, such as Buffer or Later, now counts only when the post is actually about social tools: a buying-intent phrase appears, or the domain is named. A diary entry about doing something "later" no longer lands in the Medium tier as a comparison opportunity. Competitors with unique names match exactly as before.

### Changed
- The website has new comparison pages for people weighing Buffer, Hootsuite, Metricool and Postiz, and each one says where the other tool is the better pick. The main comparison table now reflects that Buffer, Hootsuite, Metricool and Mixpost ship MCP servers too, and every page's search description fits in 160 characters.

## [2.6.0] - 2026-09-19

This release adds signed publish receipts, so you can prove a post went out exactly as you approved it, without taking pendpost's word for it.

### Added
- Signed publish receipts. When pendpost fires an approved post, it signs a receipt that binds what actually published to what you approved, and records the platform's own post id against it. A verify command, `node scripts/attest.mjs verify`, checks any receipt against your public key, so you, or anyone you hand the public key to, can prove a post went out exactly as approved without taking pendpost's word for it. The signing key is per client, generated on first use, kept at 0600 beside your other local secrets, and never leaves your machine. The post detail view shows a shield on a signed platform and reports "verified", "content changed since", or "signature invalid" when you run Verify.

### Changed
- A post whose saved content no longer matches what you approved now waits for a fresh approval instead of publishing. This catches an edit made to the plan file outside the app. A missing signing key, or a post approved before content fingerprints existed, never blocks a publish: the post still goes out, it simply carries no receipt. If you are upgrading with posts approved on an older build, run `node scripts/migrate-attest-baseline.mjs --apply` once to retire their older-format fingerprints, so those approvals keep publishing (without a receipt) instead of asking for a re-approval. Every approval made from this release on carries a receipt.

## [2.5.0] - 2026-09-19

This release lets you publish to LinkedIn as yourself, not only as your Company Page. A LinkedIn post can now go out from your personal profile, chosen per post, so a personal brand can use the lane the same way a company page does. Everything else about the lane, drafts, approvals, and plans, stays the same.

### Added
- LinkedIn member posting. A post can publish to your personal LinkedIn profile instead of only a Company Page. Pick "Personal profile" per post in the composer; the default stays the Company Page. Reconnect LinkedIn once so the token carries the member scope, and pendpost captures your profile id for you at sign-in. This answers a community request (pendpost/pendpost#6).

## [2.4.1] - 2026-09-19

This release is about telling you the truth at publish time. When a post goes out, or does not, pendpost now shows the reason on the card and a short toast while the post is in flight, so you are never left guessing. YouTube got more reliable in the same breath: an approved Short is never silently skipped, and a post that fell behind ships late instead of being dropped. And when a YouTube read fails because an API is switched off in your Google Cloud project, pendpost points you at enabling that API rather than sending you to reconnect an account that was never the problem.

### Added
- Honest publish feedback. The Activity feed and the post card now carry the real reason a publish did or did not happen, and a short toast shows while a post is in flight, so a post is never a silent success or a silent failure.

### Changed
- The marketing site is simpler: one clear call to action on the home page, sentence-case navigation, a tighter type scale, and a pricing grid with a single highlighted plan. pendpost is also listed on the Glama and PulseMCP registries.

### Fixed
- Approved YouTube Shorts are never silently skipped, and a Short that is overdue ships late instead of being dropped. An overdue post is a warning at pre-flight, not a block.
- A YouTube read that fails because the API is switched off in your Google Cloud project now reads as exactly that. pendpost names the disabled API and links you straight to enabling it in the Cloud console, instead of sending you to reconnect the account, which never fixes a disabled API. The honest state shows up wherever the lane's health does: in Activity, on the Setup card, and in Insights.

### Dependencies
- Cleared every open dependency advisory across the app, website, and video toolchains with non-breaking updates. None of these reach the published engine, which has no runtime dependencies.

## [2.3.0] - 2026-09-05

This release makes Radar honest. A scan now only ever claims what it actually did: a failed run names the lanes it will retry, a stale result reads as "last tried" rather than a live error, and a run cut short by the machine going to sleep says so instead of blaming a timeout. You can scope a scan to named sources or resume just the lanes that did not finish, and Radar learned French and Italian, exclude words, and a minimum score. Alongside Radar, pendpost now catches a dead media link when you approve a post instead of at publish, and the Planner and the approval gate show a post's real state.

### Added
- Scoped and resumable Radar scans. You can run a scan against named sources only, and after a scan is cut short, for example by the machine sleeping mid-run, "Scan again" re-runs just the lanes that did not finish instead of starting over.
- Exclude words and a minimum score for Radar. You can tell Radar which words rule a signal out and set the lowest buyer-intent score worth surfacing, and leaving the source list empty now means every engine.
- Wider language and source coverage. The default scorer reads French and Italian buyer intent, Mastodon, Bluesky, and Hacker News each run one search per keyword so a multi-word query actually returns results, Quora joins as a copy-draft source, and a configurable look-back window lets a scan reach back over several days.
- An approve-time dead-URL gate. pendpost checks a post's media links when you approve it, so a link that has gone missing is caught at the gate instead of failing at publish, with a one-command fix to re-mirror the media.
- Instagram carousels and feed images can route through the always-on cloud, off by default, so those posts can publish while your machine is asleep.
- The note behind a scan is now something you can read in full, as a disclosure rather than a truncated tooltip, and every source row carries a "last tried" timestamp so staleness is visible.

### Changed
- Radar's daily scan runs in your brand's own timezone, counts only unattended feed scans against the daily budget, and packs its lanes exactly the way a manual run does.
- A scan tells the research step where to look, which languages count, and what is never a signal, and it fences out lanes that are out of scope so one query's hints cannot steer another.
- The look-back window fails closed on an undated result: if pendpost cannot tell how old a find is, it drops it rather than surfacing something stale, and the result says so.

### Fixed
- Radar scans report what actually happened. A run tells a timeout, a crash, and a sleep-interrupted run apart; a stopped run says when the agent last spoke; a never-connected source says "not connected" rather than "expired"; and an idle clean run leaves an honest zero-result note instead of a blank.
- A scan no longer overstates or double-counts: per-source state is merged rather than overwritten, per-reply refusals are tallied by reason on the job row, and a scan that was refused before it ran can no longer spend the daily budget.
- Radar holds the computer awake while an agent scan runs, so a scan is no longer silently killed by the machine going to sleep, and the daily scheduler resolves the right brand for each scan and repairs an orphaned running job on its own tick.
- The Planner shows the real failure reason on a post's status pill and gives an overdue post a short grace window, so a due post does not flash red while it is mid-publish.
- The approval gate refuses at the control when a post is not ready, and bulk approve and Mastodon publish are bounded so the spinner can never hang.
- A publish-time media fail-safe with a guarded retry stops the storm of missing-media errors, and a committed but undeployed media mirror now self-heals.
- A broad Radar accessibility pass: the inline action and the note toggle meet a full 44px tap target, and the stale-row and state glyphs clear WCAG AA contrast in both light and dark.
- Deployment fixes so preview builds stop erroring and the marketing-site deploy ships only the site rather than archiving the whole repository.

### Dependencies
- Bumped the app and web dependency groups and several GitHub Actions to current releases.

## [2.2.0] - 2026-08-24

This release closes the loop on X. pendpost now sees the mentions, replies, likes, follows, and direct messages your posts draw, gathers them into one inbound inbox, and lets you answer without leaving the app. In the same breath it stops the quiet money leak that a metered X account could spring: a lane that runs out of credits now says so honestly instead of pretending to publish, and the daily reading that used to drain those credits is off by default.

### Added
- The inbound X Activity engine. pendpost watches what happens to your X posts, mentions, replies, likes, follows, and direct messages, and shows them in one inbound inbox you can act on. You can reply to a mention or a reply straight from that inbox, and an agent can do the same through the `reply_to_inbound_event` tool with a REST twin. The always-on cloud runtime carries the same stream so the inbox stays current even while your machine is asleep.
- Honest recovery when an X lane runs out of credits. X bills per call, and a depleted account used to look like a post that quietly failed. Now the lane halts with a plain reason, the post keeps an honest Failed pill instead of a misleading Retrying one, and both the app and the `resume_lane` tool can re-check credits and pick the work back up. The credits panel links straight to the X top-up portal.
- Cost-aware Insights. Reading performance from a metered lane costs money, so the daily refresh now runs the free lanes on its own and leaves X as an explicit opt-in. This closes the case where a background read sweep drained X credits even though the balance looked fine. The Reddit and Mastodon sweeps are bounded the same way.
- A rebuilt Radar worklist. Radar opens on the work that is still open, hides the signals you have already handled, and marks a thread read in one click. The open and answered views are now separate filters with a three way sort, the nav shows a live count of new signals, and one hung source can no longer burn the whole scan because each source runs on its own. A partial or retrying scan reads as amber rather than a dead end, and once a signal is answered its card can never link back to the question again.
- An all-projects overview. When you run more than one brand, Activity, Insights, and the Radar comment inbox each have a combined view across every project, with weighted-average rates where an average makes sense, and both Approvals and the Planner can work in cross-project mode. Every card carries a clear project badge so you always know whose post you are looking at.
- Media upload in the editor. You can now upload or drag and drop a photo or video straight into the composer and the post detail, not only through the asset library.
- Covers that match the grid. A reel cover is shown the way each platform's profile grid will actually crop it, Instagram gets a grid-safe cover delivered without any extra dependency, and pendpost measures the rendition Instagram served after publishing so a cover surprise is caught. Video assets and cards carry an HD-quality badge.
- Connect ceremonies that ask for what they need. A hand-run command-line connect step now prompts for a missing credential instead of failing with an error, for both the OAuth and the static-token lanes, and the Setup page tells you the command will ask for the values.
- Smaller additions: auto-approve now only offers the lanes you have actually connected; a shared field primitive gives every labelled input the same shape; the Planner gained instant reschedule, a compact week view, and month drag and drop; deleting a post always works because the engine cancels the native platform object itself, in one confirm with an instant close; and the capability-drift gate now runs inside the OSS publish pipeline with a matching capability catalog on the website.

### Changed
- The website drops the managed-offering waitlist and goes self-serve.
- pendpost adopts the server's posting language when your machine has no local preference yet, so a fresh install speaks the right language.
- Every command-line engine verb now honours an explicit brand target, so a stray command cannot touch the wrong account.
- Radar's daily-run controls moved into Radar settings, and the reconcile now aligns to the daily run time.

### Fixed
- Native delete and unschedule are now idempotent across Ghost, WordPress, Mastodon, Facebook, and YouTube: removing a post that is already gone on the platform counts as success instead of an error.
- Intermittent Meta hiccups no longer park a healthy post; pendpost rides them out and lets the post go when the platform recovers.
- The cover that shows in the app is the cover that publishes, after a client-root path fix with a sibling fallback and an Instagram first-frame default.
- Mock mode is fenced and honestly bannered so a test run can never reach a live account, and a reverted YouTube handoff heals itself and ships the overdue posts.
- Cloud delivery: a rescheduled post clears its stale cloud markers so a retry drops the phantom failure, the health-dot popover copy matches the control it explains, and every red health state routes to the Planner.
- A broad accessibility pass clears Tier-1 contrast failures and meets WCAG AA across the comment inbox, the sidebar primaries, and the amber and zinc state colours, and the served dashboard now ships a robots.txt so it can be indexed.

## [2.1.0] - 2026-08-12

This release turns pendpost outward. It now watches the comments on your own posts, lets a client sign off on work through a link of their own, remembers the people who engage with you across lanes, and hardens the moment a post publishes so a broken one is caught before it ships rather than after.

### Added
- A comment inbox for your own posts. pendpost watches the comments on the posts it published and gathers them into an inbox on Radar, where you can like a comment or open it on the platform without leaving the app. The sweep rides the same scheduler tick as everything else, hides your own replies so the list stays about your audience, sorts newest first, tints anything you have not seen, and marks a thread done once you have dealt with it. A lane that cannot actually read comments, such as LinkedIn on the Community Management API, says so plainly instead of showing a false empty state.
- A client review link. You can invite a client or a teammate to sign off on posts through a dedicated review page that never exposes the rest of the app and fails closed. Reviewers get a shareable link, a post waits on a sign-off fence before it publishes, and both the approvals list and the post detail show whether a post is awaiting review or already signed. Reviewer management has full MCP and REST twins.
- Relationship memory. pendpost remembers the people who engage with you across lanes and shows how many times you have gone back and forth with each one, so a reply can acknowledge a returning voice instead of treating every exchange as the first. The store is local and can forget a person on request.
- An enforced pre-flight readiness gate. A post proves it is ready at three points: when you approve it, at the publish path itself, and when the cloud accepts it for always-on delivery. A lane that is not ready is refused rather than shipped broken, and you can force past the gate when you know better. The delivery envelope carries the verdict so the cloud and the local backstop agree on it.
- A fresh-bytes backstop on every video lane. Before a video goes out, pendpost re-checks that the caption is present and that audio and video stay in sync, on Instagram, Facebook, YouTube, Mastodon, TikTok, Reddit, and the cloud lanes (LinkedIn, X, Telegram, Discord), so a desynced reel is caught here instead of being rejected by the platform.
- A per-brand fact sheet for Radar. Each brand carries its own description that drives both what Radar scans for and how it drafts replies, editable from a Setup card with a live preview. An owner-only reset can prune a tenant's polluted AI-visibility state.
- An autonomy ledger. The scattered auto-approve and auto-reply controls now live in one place that shows exactly what pendpost is allowed to do on its own, with a dry-run view and a one-press revoke sweep.
- Performance memory in Insights. pendpost stores the metrics it reads, leads with what is working, flags breakout and slump outliers, and can recycle an evergreen post that earned it. Every lane that can measure now does, including X, Reddit, and Mastodon, and an MCP tool exposes the stored metrics to an agent.
- Brand-mention listening. Radar can watch for mentions of your brand as a first-class query, with a chip and a pill in the app and a count line in the daily digest.
- A closed loop on AI visibility (GEO). Radar bridges what it finds in AI answers into a backlog you can act on or decline, reads share-of-voice from the server, discloses the evidence behind each check, and labels which assistant it asked.
- Reply to a reply. When the author of a post you replied to answers back, the badge is now actionable and pendpost can thread a reply onto their follow-up.
- A feedback and suggestions pipeline. Feedback has three on-ramps that all land in GitHub without the app ever phoning home: an in-app Share feedback link that opens a prefilled, secret-safe GitHub page, a feedback issue form, and an optional form on pendpost.com for people without a GitHub account. Deeper proposals get an RFC track under `docs/rfcs/`, and issue triage is automated (auto-labelling, first-timer welcome, a needs-info stale policy, and RFC labelling). The full design is in `docs/specs/feedback-pipeline.md`.
- Real product documentation. The Mintlify starter template is replaced with pendpost's actual docs, published through a mirror pipeline.
- Smaller additions: a publish-failure hold across all thirteen engines that caps local retries at three and mirrors the cloud re-fire cap; approval-expiry and slot-slip sweeps in the publishing automation card; a digest that reports delivery, autonomy, GEO trend, and calendar gaps; a humanizer receipt that shows what the gate changed; the Nostr NIP-96 media upload path; splitting an over-cap X caption into an approvable thread; a today marker in the Week and Month planner; and one-decision project creation.

### Changed
- A hand-run command-line social ceremony now requires an explicit brand target or refuses, so a stray command can never post to the wrong account.
- The shared scheduler tick honours each brand's own enabled flag, so a brand switched off no longer rides along on another brand's timer.
- `config_set` can now write the Reddit subreddit and the Pinterest board id.

### Fixed
- A broad UX-audit sweep across the app: honest empty, error, and refused states; contrast and label fixes that meet WCAG AA; archive safety that surfaces in-flight work before you archive; a composer guard against losing edits on a project switch; a held post whose primary action clears the hold and refires; a delete gate that refuses to delete a natively scheduled post; and an auto-approve rule that matches nothing when its platform list is empty.
- Radar legibility: a grouped signal is one card that states how many places it appeared, source status reads as a glyph per state rather than colour alone, a limit failure explains itself and offers a rescan, the AI-visibility gauge says exactly what it counts, a limit-refused scan no longer spends the daily budget, and zero-count chips are hidden.
- Cloud delivery hardening: a cloud media-fetch fault fires the local backstop right away instead of after twenty minutes, and toggling a brand always-on seals its own tokens first, fail-closed.
- Dependency and security updates: the marketing site moves to Astro 7.2.0 to clear the Astro and sharp advisories, and lockfile bumps resolve the remaining npm-audit high and moderate advisories.

## [2.0.1] - 2026-07-29

Switching cloud always-on off now actually goes quiet. It always stopped the cloud from publishing, but the local daemon kept talking to it on every tick, and the app kept showing a green "on" pill while nothing was firing.

### Fixed
- A brand switched off no longer keeps the cloud awake. Stale in-flight markers (a push ack for a post the local backstop had already published) held the poll gate open forever, and the gate's second leg was not due-gated, so any approved future post kept it open too. Relic markers are pruned each tick, the gate reads the due time, and the off-flag re-assert is rate-limited instead of running every minute. Measured on a live install: roughly 2,880 cloud writes a day, down to none while nothing changes.
- The cloud result feed is a history, not a delta, so replayed old failures were written back on every poll and re-created the very relics that had just been pruned. A failure is now only recorded while its post is still approved and unposted.
- The 24/7 state pill said "on" whenever an account was linked, even with every project switched off. It now reflects whether the cloud is publishing anything, and the plan meter says plainly that the base fee keeps running, with the subscription portal one click away instead of buried in the account menu.

### Changed
- Turning a project off withdraws the jobs it had already pushed to the cloud, instead of leaving them queued to be refused one by one at their due time.
- A billing alert only claims a recovery after a real past-due period, and never claims publishing has resumed while no project is switched on.

## [2.0.0] - 2026-07-26

The largest release since 1.0: a full Radar listening-and-reply engine, native carousel/album publishing across every capable lane, and per-brand token sealing that hardens always-on delivery. Roughly forty capability specs landed since 1.4.0. Major version because Radar and multi-slide albums reshape the product surface, not because of a breaking API change.

### Added
- Radar: a listening-and-reply engine. pendpost scans where your buyers ask questions (Reddit, Mastodon, Bluesky, Hacker News, X, YouTube, Nostr), scores each signal for buying/service-seeking intent in EN and de/de-CH, and drafts a product-aware reply behind a human approval fence. Scanning runs on your own agent, so you can watch the child's transcript stream onto the job, and daily research arms itself from a chosen cadence, off by default and budgeted. Score-gated auto-reply, a warmth/karma builder for Reddit, author-reply read-back, and a GEO (AI-visibility) layer round it out.
- Carousel and album publishing end to end. A native multi-image / multi-slide post type flows through the composer, validation, the full-screen viewer, and delivery, with real albums on Mastodon and Instagram, image-carousel children on Instagram, carousel pins on Pinterest, and a public media-mirror seam for lanes that need per-slide URLs.
- Per-brand token sealing. Credentials are now sealed and resolved by brand and carry their destination in the delivery envelope, so an always-on job publishes to the account it was approved for. The cloud worker and local backstop share one atomic publish-claim lease, making a double-post structurally impossible.
- New and extended platform lanes and verbs: native polls; Ghost members + newsletter management; Pinterest board/board-section CRUD and native video pins; GBP reviews, media library and attributes; Nostr NIP-23 long-form, NIP-96/98 media upload, and zaps; Discord forum/thread targeting and scheduled events; cross-lane profile editing; edit-after-publish for YouTube/Telegram/Discord; universal self first-comment; cross-lane image alt-text; YouTube playlist management; richer own-account insights (reach, engagement, watch-time, audience demographics).
- Inbox: read and reply to inbound comments, moderate comments, and react as the brand (like/favourite/boost/emoji), with a webhook/realtime ingestion seam.
- An always-on humanizer gate on every outbound-text seam, and multi-select asset attach replacing the one-at-a-time flow.

### Changed
- Setup was rebuilt into a prompt-first, master-detail page: a grouped rail with one open lane, platform and Radar toggles living on each card, connected-account discovery, and one-press credential adopt to reuse another client's agent. The old Settings grid is retired.
- Freigaben/Approvals now say where each post publishes and prove it after the fact, sort newest-first with a per-tab control, can revive a rejected post to draft, and guard bulk-approve when offline.
- App polish throughout: Radar feed at scale with duplicate grouping, insights that lead with primary metrics, an activity feed that leads with content over bookkeeping, a resizable sidebar rail, and "don't show again" opt-outs across recurring confirm/prompt gates.
- The web marketing site gained an outcome-led hero with a full-loop approval demo, scannable pricing, and a consistent CTA.

### Fixed
- Cloud delivery hardening: failed and already-posted jobs stop being re-fired forever, a half-written connection heals instead of reading disconnected, stale cloud-failures clear on reconcile, and reconcile failures log their real HTTP status.
- Carousel correctness: albums render instead of erroring, derive their frame and ratio from the real slides, no longer strand slides as unused files, and speak de-CH in every blocker.
- A broad correctness sweep across Radar, planner, composer, inbox, insights and the setup flow, including honest empty/refused states and a11y fixes.

## [1.4.0] - 2026-07-08

### Added
- Backstop publish-claim gate for always-on. The cloud worker and the local overdue-backstop are two independent firers of the same job; both now assert one shared atomic publish-claim lease before firing, so a double-post is structurally impossible even when the machine wakes mid-fire. It fails open when the cloud is unreachable, so a self-hosted install behaves exactly as before.
- Read-only cloud observability over MCP. Four new read-only tools (`cloud_status`, `cloud_capabilities`, `cloud_clients`, and `cloud_subscription`) mirror the `GET /api/cloud*` routes so an agent can inspect cloud state with no secret and no confirm gate (API-key presence only, never the key itself).
- Single edit surface for a post. The post detail is now the one place a post is edited; a single-lane post (X, Mastodon, or Nostr only) shows one "Post text" field instead of a caption/override split, and the sidebar's next-post pill shows the platform glyph, the day and time, and a one-line content preview.

### Fixed
- X thread replies now thread correctly when fired as separate jobs. A reply job resolved its parent against a plan snapshot frozen before the parent tweet existed, so it fail-closed with an empty envelope. The parent id is now resolved at fire time, and an unresolvable parent emits a structured `parent_unpublished` (deferred, retryable) or `parent_missing` (terminal) result instead of a silent skip.
- UX-audit pass across 15 screens: collapsed status a11y and summary copy (Setup), a NaN guard and subtitle gating (Cloud), a single schedule control and auto-growing text areas (post detail, composer, thread composer), an exceptions-only health cell (Clients), timezone auto-save (Settings), and header and empty-state polish (Insights, Assets, Activity, Published, Planner).
- The planner readiness checklist no longer leaks raw shell commands into its blocker rows; the rows still deep-link to Setup, which is the actual next step.
- Honest, cloud-scoped delivery labels: the planner banner and the cloud popover no longer share one "undelivered" label for two different counts, and the duplicate active-client chip and reused labels across post detail, clients, and cloud are disambiguated.

## [1.3.0] - 2026-07-07

### Added
- Thread composer for X. Plan a whole X thread as one artifact. Draft every reply in a single editor, reorder the tweets, and schedule the chain as one unit instead of stitching separate `xReplyTo` posts by hand.
- Platform-aware post detail. The detail dialog now shows only the fields each network actually publishes, so you never edit a caption a platform will never use. It opens as a centered two-column layout with state-aware actions and keyboard triage, supports inline caption editing, and surfaces platform specifics like a YouTube first comment and the LinkedIn card description.
- Redesigned accounts sidebar. A compact logo cluster with a clean per-account status list replaces the old chip list; the sidebar is a static full-height rail that stays in view while the whole content column scrolls.
- Fail-closed approval trust gate. Editing a post after it was approved now revokes the approval instead of silently keeping the green light, so an approved-then-changed post can never ship un-reviewed.
- Server-side video cover JPEGs. The asset scan generates video cover thumbnails on the server, so the dashboard always has a real cover, `CoverThumb` no longer flashes an empty grey square, and cover generation stays binary-free in mock mode.
- Archived projects sink to the bottom of the clients list, greyed, with one-click restore.
- One-click "Fix in Setup" on actionable activity errors, deep-linking straight to the relevant Setup card.

### Fixed
- Link/article preview is now a contained, expandable card with a slim dialog scrollbar, instead of overflowing the composer.
- The composer hides the "Vorschau" label and toggle when a text-only post has nothing to preview.
- The delivery line reads as one honest, cloud-aware sentence with the repeats stripped.
- 35 missing composer and article-card keys are now translated for de-CH.

## [1.2.1] - 2026-07-06

### Added
- Six new publishing lanes. Mastodon, WordPress, Ghost, and Nostr each get a first-class publish engine wired through every seam (connect, validate, schedule, publish), plus Google Business Profile as a beta lane. The connect panel, sidebar account chips, and setup cards surface all of them.
- Native platform scheduling for Mastodon, WordPress, and Ghost: like YouTube, an approved post is handed to the platform's own scheduler instead of waiting on the local clock, so it fires even when the app is closed.
- Content-type-aware composer. WordPress and Ghost posts get a long-form article editor (title + body); Mastodon and Nostr get a note override; Google Business Profile gets its own post fields. The composer adapts to the platforms a post targets rather than showing one flat text box.
- Capability badges before you pay. Each lane is tagged by how it runs (cloud 24/7, native platform scheduling, or local-only), driven by the cloud's live capability map, so the trade-off is visible on the Cloud page before a plan is chosen.
- Cloud always-on now covers Telegram, Discord, and Nostr for managed brands, on top of the existing Meta / LinkedIn / X / Bluesky lanes.
- X reply-chain threading. A post can reference an earlier X post (`xReplyTo`) to publish as a threaded reply; the dashboard surfaces the chain and the composer has a set/clear affordance for it.
- Per-platform model overrides for the Telegram, Discord, TikTok, Reddit, and Pinterest lanes, matching the override support the other lanes already had.

### Fixed
- `platform_validate` now catches half-configured Mastodon and Nostr identifiers (and the other wave-2 lanes) instead of letting an incomplete setup reach publish time.
- Cloud hand-off is scoped to the lanes the cloud actually fires: local-only lanes are no longer pushed to the cloud, and Bluesky (which has no publish engine anywhere yet) was dropped from the cloud lane set so a deferred post can no longer land nowhere.

## [1.2.0] - 2026-07-04

### Added
- Cloud sync guarantee status: `GET /api/cloud` now returns a `sync` roll-up (`green` - every approved cloud-lane post is confirmed accepted by the cloud; `yellow` - a push is still pending; `red` - the guarantee is broken: cloud unreachable, an approved post overdue-unpublished, a failed cloud publish, or sync stopped). The header cloud icon surfaces it as a green/amber/red dot with a localized reason line (en + de-CH).
- Push acknowledgements, the last successful cloud contact, and the subscription view are now persisted per client (`state.cloudAccepted` / `state.cloudContact` / `state.cloudSubView`), so the status is computable offline and survives restarts.

### Fixed
- Cloud-managed brands never silently miss a post again. The scheduler no longer hands off blindly to the cloud: lanes the managed cloud does not fire (YouTube incl. the release-recovery lane, Telegram, Discord, Reddit, Pinterest, TikTok) always run on the normal local schedule, and cloud lanes (Meta, LinkedIn, X, Bluesky) get a 20-minute liveness backstop: a post the cloud provably has not fired past that grace publishes locally, with a `cloud-backstop` activity entry. Reconcile runs first each tick and the cloud worker's claim guard holds, so the backstop cannot double-post.
- A brand the cloud wrongly reports as paused while it is on locally now re-asserts its always-on flag every tick (the mirror of the existing off-flag self-heal).
- A stale cached cloud-failure entry for a post that has since published no longer holds the sync status red.

## [1.1.1] - 2026-06-28

### Fixed
- Docker/container startup: the one-time multi-client boot migration no longer crashes with `EXDEV: cross-device link not permitted` when `data/` is baked into a read-only image layer (e.g. running `pendpost --stdio` inside a container, the form MCP registries use to introspect the server). The migration now falls back to a copy + delete across the mount boundary, keeping its zero-loss, crash-safe re-entry behavior.

## [1.1.0] - 2026-06-28

### Added
- Connect panel: set up Instagram, Facebook, LinkedIn, YouTube, and X from inside the app. Credentials go into collapsible per-platform cards that save as you type (no Save button) and never leave your machine.
- Disconnect: clear a platform's stored credentials straight from its card, for rotating keys or stepping away from a shared machine.
- YouTube setup guidance: Production-first connect steps and plain-language reassurance for Google's "this app isn't verified" consent screen, so the one-time warning doesn't read as a dead end.
- `pendpost connect`: a CLI entry point for the same operator-only connect flow.

### Fixed
- The OAuth connect ceremony now reports progress and completion instead of leaving you on a dead-end screen.
- macOS approval notifications now show the pendpost icon.

## [1.0.1] - 2026-06-27

### Added
- 24/7 Cloud-Service in-app purchase: compare plans, review the order, open secure checkout, and return to an active plan without leaving the app, with graceful cancel handling. The website deep-links a chosen plan straight into the app (`/download?plan=<tier>`).
- A cloud account menu on the real account identity: manage billing (Stripe portal), manage account (Clerk), a lightweight reversible sign-out/switch, and an explicit sign-in entry, with the heavier "eject to self-host" kept separate.

### Added (always-on foundation)
- Always-on self-host: deploy templates for Fly.io, Railway, and Render (`deploy/`) and an always-on self-host guide, so Instagram, LinkedIn, and X publish on schedule even when your computer is off.
- An optional in-server bearer-token auth gate that activates only when `PENDPOST_HOST` is non-loopback and `PENDPOST_AUTH_TOKEN` is set; the loopback default stays no-auth and unchanged. `PENDPOST_PUBLIC_HOST` extends the host allowlist for a public deployment, and `GET /api/health` is exempt so platform health checks work.
- A cloud-ready publish-job seam: `lib/publish-job.mjs` builds a versioned, approval-proof publish-job envelope that a separate always-on runtime can consume, with a second approval fence that refuses unapproved or self-approved posts. The contract is documented in `docs/specs/cloud-integration-contract.md`.
- More ways to install: a published container image on GHCR (`docker run -p 8090:8090 ghcr.io/pendpost/pendpost`, no clone needed). (Correction, November 2026: this entry also announced a Homebrew tap. The formula in `packaging/homebrew/` is ready, but the tap was never published, so `brew install` does not work yet. Use `npx pendpost` or Docker.) Release automation publishes the npm package with provenance and the image when a GitHub release is cut (`.github/workflows/release-npm.yml`, `release-image.yml`).

### Changed
- The dashboard and marketing copy now make the per-platform power-off truth explicit: Facebook and YouTube schedule natively and fire even when your computer is off, while Instagram, LinkedIn, and X need pendpost running. The post detail shows a per-platform delivery hint and the schedule badges carry a one-line tooltip.
- The publish scheduler now dispatches through the publish-job envelope. Publish behavior is byte-identical (covered by the existing mock-loop and concurrency tests).

## [1.0.0] - 2026-06-19

The first public-ready release. pendpost is a local-first, MCP-native social planner: an agent drafts, schedules, and publishes for Facebook, Instagram, LinkedIn, YouTube, and X, and runs the loop autonomously once you trust it, with a human approval gate and anti-ban brakes you control.

### Added

- X (Twitter) as a first-class publishing lane: OAuth 1.0a request signing (verified offline against X's documented signature example) and OAuth 2.0 token refresh on both the dashboard and the MCP face.
- Guarded client-lifecycle MCP tools (`client_create`, `client_update`, `client_archive`, `client_set_active`), fail-closed behind `actor:"owner"` + `confirm:true` and never touching a credential value, so client administration is agent-operable without widening the credential boundary.
- A header language toggle (English / Swiss German) that switches the UI live, and a Settings time-format preference (automatic / 24-hour / 12-hour); Swiss German always renders 24-hour.
- Creating your first real client now promotes it to the active workspace and retires the empty starter default, so posts never land on the wrong project.
- A repo-root `AGENTS.md`, generated from the per-platform onboarding playbooks (`lib/playbooks.mjs`) and guarded by a freshness check in `npm run check`, so an agent can drive per-platform setup from the file alone.
- A per-platform **Copy AI prompt** action on the Setup page that copies a self-contained, secret-safe Claude-for-Chrome prompt for connecting that platform.

### Changed

- Accessibility and design coherence: a shared Tab focus trap on the slide-over and confirm/prompt dialogs (safe alongside nested Radix popovers), status and approval pills that lead with an icon so meaning never rests on color alone, and full-width data-dense tabs.
- The Clients page collapses its duplicated overview and admin table into one row per client (identity, status, health, and actions together).
- Marketing site: an autonomy-forward hero and a three-load-bearing-differentiators hierarchy (the gate, the brakes, the editor) set apart from the two supporting ones.
- Upstream references removed from the shipped surface toward the open-source release; the runtime is unchanged (account identifiers resolve from per-client `.env`).

## [0.4.0] - 2026-06-16

### Added

- Local multi-client / multi-workspace management. One pendpost instance manages several clients, each owning its own credentials, plans, brand rules, schedule, circuit-breaker state, insights, and activity log. A first-class `Client` entity (a `data/clients.json` registry plus `data/clients/<id>/` subtrees), an idempotent zero-loss boot migration of an existing single-workspace install into a `default` client, a `client_list` MCP read tool, a sidebar client switcher with an unmistakable active-client indicator, and Clients admin plus per-client Keys pages in the dashboard. Per-client theming via a CSS-variable accent layer.
- Per-client isolation guarantee: no client's keys, plans, breaker state, or activity can leak into another. Every MCP tool accepts an optional `clientId`; client lifecycle and active-context switching are operator-only dashboard actions, recorded as documented parity exemptions so they are never agent-accessible.
- Founder dashboard requests: color-coded scheduled-time chips (approved / needs-approval / halted, paired with an icon and an accessible name, never color alone), tooltips on every icon-only control, stories preview parity with reels, and interactive story elements (poll, question, link, mention, location, hashtag, music stickers) plus per-post hashtag overrides.
- Extensibility seams: an optional `drivers/registry.json` to add a platform driver without forking, a `PENDPOST_<LANE>_ENGINE` override for a custom publish engine, and per-client brand-rule profiles.
- i18n readiness: a locale-pack seam (a `t()` lookup, an English baseline catalog, and a `de-CH` example pack with fallback to English), wired through the multi-client UI.
- A frontend test suite (Vitest, React Testing Library, jest-axe) and expanded backend coverage (security, audit, anti-ban circuit breakers, supply-chain, and the pre-publish brand-lint gate).

### Changed

- The MCP surface grows to 32 tools (adds `client_list`); the parity check now also asserts that every write tool accepts an optional `clientId`.
- The publish path enforces the brand-lint error gate before every publish (an error-severity caption is blocked fail-closed; warnings stay advisory).
- The lane-pause kill switch now yields a clean no-op in mock mode as well as live.

## [0.3.0] - 2026-06-15

### Added

- Human approval gate. Every post carries an approval state and is fail-closed: a post with no approval never publishes. There is no self-approval, so the actor who created a post cannot approve it; the owner is exempt.
- Anti-ban circuit breakers: a Meta error 368 breaker that halts the Meta lane and never auto-resumes, a cadence cap that defers bursts rather than dropping them, and a lane pause kill switch.
- Humanizer brand-lint. Captions are checked before publish against editable rules in `rules.json`, which flag English AI-writing tells. Errors block publish; warnings are advisory.
- Native scheduling where the platform supports it.
- Dual interface: a web dashboard and an MCP server (31 tools), with a parity test that enforces every capability ships on both the `/api` and `/mcp` faces.
- Mock mode. The full `draft -> approve -> schedule -> publish -> insights` loop runs with zero credentials.
- Publish engines for Facebook, Instagram, LinkedIn, and YouTube.
- Docker support.

[Unreleased]: https://github.com/pendpost/pendpost/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/pendpost/pendpost/compare/v0.4.0...v1.0.0
[0.4.0]: https://github.com/pendpost/pendpost/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/pendpost/pendpost/releases/tag/v0.3.0
