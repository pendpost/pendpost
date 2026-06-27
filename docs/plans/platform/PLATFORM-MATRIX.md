# Platform capability matrix

What each platform engine can actually do, and the cover/thumbnail mechanics that
genuinely apply. pendpost is honest about these differences rather than implying
one uniform behaviour. The cover map here mirrors `coverApplicability()` in
`lib/covers.mjs`.

| Capability | Facebook | Instagram | LinkedIn | YouTube |
| --- | --- | --- | --- | --- |
| Publish | Reels only (`type=reel`) | Reels + stories | Text, article, and video posts | Video upload |
| Native scheduling | Yes (scheduled post, `scheduled_publish_time`) | No (published at due time by the publish-due sweep) | No (published at due time by the publish-due sweep) | Yes (`publishAt`; private until it fires) |
| Cover / thumbnail | At publish AND post-hoc (`set-thumbnail`) | Frame offset only, at publish | During the upload ceremony only | At publish AND post-hoc (`set-thumbnail`) |
| Insights (read-only) | Video insights | Media insights | Share statistics | `videos.list` statistics |

## Cover / thumbnail details

- **Facebook.** Applied after publish via `POST /{video-id}/thumbnails` (`is_preferred`). Works for both frame covers and file covers. The `set-thumbnail` command re-applies it post-hoc.
- **Instagram.** Only a frame offset (`thumb_offset`, in milliseconds) at publish; there is no post-hoc change via the API. File covers cannot reach Instagram because there is no public hosting layer in this pipeline, so pick a frame instead. Stories have no cover concept.
- **LinkedIn.** Uploaded via the thumbnail step during the video upload ceremony, before finalize. It applies only to a not-yet-published post; there is no post-hoc change via the API.
- **YouTube.** `thumbnails.set` (JPEG, 2 MB or smaller, post-hoc is fine). The channel must be phone-verified or the API returns 403. The Shorts feed always shows a video frame; the custom thumbnail appears on search and channel surfaces.

## Notes

- Native scheduling means pendpost hands the post to the platform ahead of time
  (Facebook scheduled post, YouTube `publishAt`). Moving or cancelling a natively
  scheduled post deletes the platform object, which is a real mutation and
  requires explicit confirmation.
- Instagram and LinkedIn have no native scheduling API here, so their posts are
  published at the due time by the scheduler's publish-due sweep.
- All insights commands are read-only and never publish anything.
