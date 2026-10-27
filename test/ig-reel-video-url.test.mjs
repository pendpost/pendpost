#!/usr/bin/env node
// test/ig-reel-video-url.test.mjs - IG reels/stories publish from a video_url when the cloud
// injected one, instead of rupload.
//
// Root cause (2026-10-22, ig-kk-schlaf-erinnerung): rupload.facebook.com processes the video
// INSIDE the upload request and gives up after ~35s with HTTP 400 ProcessingFailedError
// (retriable:false). Non-publishing probes of the same bytes: every pass returned in <=26s,
// every failure at 35-37s whatever the size (a 35 MB 70s re-encode failed, a 42 MB 30s cut of
// the same file passed). The 70s reel needed ~64s of processing, so it failed ~25 times from
// both the Mac and the cloud, and the rejected container then sat IN_PROGRESS for good. The
// same bytes via video_url (async fetch, polled status_code) reached FINISHED in 64s.
//
// Source assertions, same pattern as engine-cover-fallback.test.mjs: no reel-publish
// scaffold exists to drive the Graph calls in-process.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0;
let failures = 0;
const ok = (cond, msg) => { if (cond) { pass += 1; console.log(`  ok - ${msg}`); } else { failures += 1; console.error(`  FAIL - ${msg}`); } };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'meta-social.mjs'), 'utf8');

ok(/const videoUrl = \/\^https:\\\/\\\/\\S\+\$\/i\.test\(post\.videoUrl/.test(src),
  'engine: only an https post.videoUrl selects the video_url path');
ok(/if \(videoUrl\) containerParams\.video_url = videoUrl;\s*else containerParams\.upload_type = 'resumable';/.test(src),
  'engine: video_url and upload_type=resumable are mutually exclusive container params');
ok(/if \(videoUrl\) \{[\s\S]{0,200}\} else \{[\s\S]{0,200}await igResumableUpload\(container\.id, mediaPath, pageToken\);/.test(src),
  'engine: rupload runs only when there is no video_url');
ok(/await pollContainer\(container\.id, pageToken, videoUrl \? 10 \* 60 \* 1000 : undefined\);/.test(src),
  'engine: a video_url container gets a 10 min processing window (a 70s reel took 64s)');

// videoUrl is transport, not content: it must stay out of the approval hash and out of the
// operator-editable fields, so a URL can only come from the cloud's sha256-verified presign.
const { POST_CONTENT_FIELDS } = await import('../lib/plans.mjs');
ok(!POST_CONTENT_FIELDS.includes('videoUrl'), 'plans: videoUrl is not a content field (operator cannot set it via plan_update_post)');
ok(!/ENGINE_OWNED_FIELDS = \[[^\]]*'videoUrl'/.test(src), 'engine: videoUrl is never persisted back to the plan');

console.log(`\n${pass} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
