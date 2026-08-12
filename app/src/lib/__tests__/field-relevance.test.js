import { describe, it, expect } from 'vitest';
import { fieldRelevance, fieldsForPost } from '../format.js';

// The relevance model is the SINGLE source of truth shared by the Composer
// (authoring) and PostDetail (review), verified against the engine lanes in
// scripts/<lane>-social.mjs: which post fields each platform actually consumes.
// A field a NO targeted platform reads must never render (the "Kein Bildtext on a
// YouTube-only post" bug), and a per-platform override (xCaption / mastodonCaption
// / nostrCaption) belongs only to its own lane.

describe('fieldRelevance', () => {
  it('a meta reel uses the caption + IG first comment, nothing YouTube/blog', () => {
    const r = fieldRelevance(['instagram', 'facebook'], 'reel');
    expect(r.caption).toBe(true);
    expect(r.firstComment).toBe(true); // IG, non-story
    expect(r.title).toBe(false);
    expect(r.description).toBe(false);
    expect(r.tags).toBe(false);
    expect(r.body).toBe(false);
    expect(r.xCaption).toBe(false);
  });

  it('a YouTube short uses title + description + tags, NOT the shared caption', () => {
    const r = fieldRelevance(['youtube'], 'youtube-short');
    expect(r.caption).toBe(false); // the core bug: no "Kein Bildtext" for YouTube
    expect(r.title).toBe(true);
    expect(r.description).toBe(true);
    expect(r.tags).toBe(true);
    expect(r.blogSlug).toBe(true);
    expect(r.firstComment).toBe(true); // YouTube pins a first comment on the video
  });

  it('firstComment is Instagram-feed OR YouTube OR LinkedIn, never an IG story', () => {
    expect(fieldRelevance(['instagram'], 'reel').firstComment).toBe(true);
    expect(fieldRelevance(['instagram'], 'story').firstComment).toBe(false);
    expect(fieldRelevance(['youtube'], 'youtube-longform').firstComment).toBe(true);
    // Spec 11: LinkedIn extends the existing IG/YT first-comment field - any
    // share type carries a comment surface (unlike an IG story).
    expect(fieldRelevance(['linkedin'], 'video').firstComment).toBe(true);
    expect(fieldRelevance(['linkedin'], 'text').firstComment).toBe(true);
  });

  it('an X post exposes xCaption + xReplyTo (caption stays as the fallback base)', () => {
    const r = fieldRelevance(['x'], 'video');
    expect(r.xCaption).toBe(true);
    expect(r.xReplyTo).toBe(true);
    expect(r.caption).toBe(true); // x reads xCaption || caption
    expect(r.title).toBe(false);
  });

  it('mastodon / nostr each own their note override only', () => {
    expect(fieldRelevance(['mastodon'], 'video').mastodonCaption).toBe(true);
    expect(fieldRelevance(['mastodon'], 'video').nostrCaption).toBe(false);
    expect(fieldRelevance(['nostr'], 'video').nostrCaption).toBe(true);
    expect(fieldRelevance(['nostr'], 'video').mastodonCaption).toBe(false);
  });

  it('a WordPress article uses title + body + excerpt + tags + image, not caption', () => {
    const r = fieldRelevance(['wordpress'], 'text');
    expect(r.caption).toBe(false);
    expect(r.title).toBe(true);
    expect(r.body).toBe(true);
    expect(r.excerpt).toBe(true);
    expect(r.tags).toBe(true);
    expect(r.image).toBe(true);
    expect(r.canonicalUrl).toBe(false); // ghost-only
    expect(r.ghostEmail).toBe(false);
  });

  it('a Ghost article adds the canonical URL + newsletter opt-in', () => {
    const r = fieldRelevance(['ghost'], 'text');
    expect(r.canonicalUrl).toBe(true);
    expect(r.ghostEmail).toBe(true);
    expect(r.body).toBe(true);
  });

  // Spec 01: the three newsletter refinements ride the SAME ghost gate as
  // ghostEmail/canonicalUrl - never relevant for a non-ghost lane.
  it('spec 01: newsletter/emailSegment/emailOnly are ghost-only, like ghostEmail', () => {
    const ghost = fieldRelevance(['ghost'], 'text');
    expect(ghost.newsletter).toBe(true);
    expect(ghost.emailSegment).toBe(true);
    expect(ghost.emailOnly).toBe(true);
    const wp = fieldRelevance(['wordpress'], 'text');
    expect(wp.newsletter).toBe(false);
    expect(wp.emailSegment).toBe(false);
    expect(wp.emailOnly).toBe(false);
  });

  it('a LinkedIn text/article post carries title, liDescription, link + image', () => {
    const r = fieldRelevance(['linkedin'], 'text');
    expect(r.title).toBe(true);
    expect(r.liDescription).toBe(true);
    expect(r.link).toBe(true);
    expect(r.image).toBe(true);
    expect(r.caption).toBe(true);
  });

  it('a LinkedIn video keeps caption + title but not the article-only fields', () => {
    const r = fieldRelevance(['linkedin'], 'video');
    expect(r.caption).toBe(true);
    expect(r.title).toBe(true); // linkedin media title
    expect(r.liDescription).toBe(false);
    expect(r.link).toBe(false);
  });

  it('an IG story exposes interactive stickers + hashtags, not the first comment', () => {
    const r = fieldRelevance(['instagram'], 'story');
    expect(r.interactiveStory).toBe(true);
    expect(r.hashtags).toBe(true);
    expect(r.firstComment).toBe(false); // stories have no comment
  });

  it('gbp exposes the local-post intent', () => {
    expect(fieldRelevance(['gbp'], 'image').gbp).toBe(true);
  });

  it('a multi-platform X + YouTube post is the UNION of both field sets', () => {
    const r = fieldRelevance(['x', 'youtube'], 'youtube-short');
    expect(r.xCaption).toBe(true);
    expect(r.title).toBe(true);
    expect(r.description).toBe(true);
    expect(r.caption).toBe(true); // x still reads the base caption
  });

  it('telegram / discord / tiktok / reddit / pinterest ride the shared caption plus their own override', () => {
    for (const p of ['telegram', 'discord', 'tiktok', 'reddit', 'pinterest']) {
      const r = fieldRelevance([p], 'video');
      expect(r.caption, p).toBe(true);
      expect(r.title, p).toBe(false);
      expect(r.description, p).toBe(false);
      expect(r.xCaption, p).toBe(false);
    }
  });

  // B1 (ux-audit dim-6 P1): the six MCP-writable per-lane prose overrides the
  // engines publish (lib/writes.mjs POST_FIELDS -> telegram/discord/tiktok/
  // reddit/pinterest engines) must be registered in the app's relevance model,
  // or an agent can ship text the approver never saw. Each is lane-exclusive,
  // mirroring xCaption/mastodonCaption/nostrCaption.
  it('B1: tgCaption / dcCaption / ttCaption / redditText are each lane-exclusive caption overrides', () => {
    const laneField = { telegram: 'tgCaption', discord: 'dcCaption', tiktok: 'ttCaption', reddit: 'redditText' };
    for (const [lane, field] of Object.entries(laneField)) {
      expect(fieldRelevance([lane], 'video')[field], `${lane} owns ${field}`).toBe(true);
      for (const other of Object.keys(laneField).filter((l) => l !== lane)) {
        expect(fieldRelevance([other], 'video')[field], `${other} must not carry ${field}`).toBe(false);
      }
      expect(fieldRelevance(['instagram'], 'reel')[field], `instagram must not carry ${field}`).toBe(false);
    }
  });

  it('B1: pinTitle + pinDescription are pinterest-only', () => {
    const pin = fieldRelevance(['pinterest'], 'video');
    expect(pin.pinTitle).toBe(true);
    expect(pin.pinDescription).toBe(true);
    for (const p of ['telegram', 'discord', 'tiktok', 'reddit', 'instagram', 'x']) {
      const r = fieldRelevance([p], 'video');
      expect(r.pinTitle, p).toBe(false);
      expect(r.pinDescription, p).toBe(false);
    }
  });

  it('is a pure function of platforms + type (empty is all-false)', () => {
    const r = fieldRelevance([], 'reel');
    expect(Object.values(r).every((v) => v === false)).toBe(true);
  });

  // Specs 21+39: cross-lane image alt-text. Spec 39 closed the Instagram coverage
  // gate (the feed IMAGE container takes alt_text), so instagram joined the set.
  it('altText is relevant for x / wordpress / pinterest / instagram, not a linkedin-only post', () => {
    expect(fieldRelevance(['x'], 'video').altText).toBe(true);
    expect(fieldRelevance(['wordpress'], 'text').altText).toBe(true);
    expect(fieldRelevance(['pinterest'], 'video').altText).toBe(true);
    expect(fieldRelevance(['instagram'], 'image').altText).toBe(true);
    expect(fieldRelevance(['linkedin'], 'video').altText).toBe(false);
  });

  // Spec 13: rich long-form metadata - metaTitle/metaDescription/featureImageAlt
  // apply to EITHER blog lane; wpCategories is WordPress-only (Ghost has no
  // categories concept - tags + native meta cover it).
  it('spec 13: metaTitle/metaDescription/featureImageAlt are relevant for wordpress and ghost', () => {
    for (const key of ['metaTitle', 'metaDescription', 'featureImageAlt']) {
      expect(fieldRelevance(['wordpress'], 'text')[key]).toBe(true);
      expect(fieldRelevance(['ghost'], 'text')[key]).toBe(true);
      expect(fieldRelevance(['linkedin'], 'text')[key]).toBe(false);
      expect(fieldRelevance(['instagram'], 'reel')[key]).toBe(false);
    }
  });

  it('spec 13: wpCategories is WordPress-only, false for Ghost and every other lane', () => {
    expect(fieldRelevance(['wordpress'], 'text').wpCategories).toBe(true);
    expect(fieldRelevance(['ghost'], 'text').wpCategories).toBe(false);
    expect(fieldRelevance(['linkedin'], 'text').wpCategories).toBe(false);
  });

  // Specs 27+43: draft/pending-review publish status - wordpress, ghost and
  // tiktok (the three lanes with a native draft/inbox handoff; spec 43 added
  // ghost when its engine started honoring the flag).
  it('specs 27+43: publishAsDraft is relevant for wordpress, ghost and tiktok, false elsewhere', () => {
    expect(fieldRelevance(['wordpress'], 'text').publishAsDraft).toBe(true);
    expect(fieldRelevance(['ghost'], 'text').publishAsDraft).toBe(true);
    expect(fieldRelevance(['tiktok'], 'video').publishAsDraft).toBe(true);
    expect(fieldRelevance(['linkedin'], 'text').publishAsDraft).toBe(false);
    expect(fieldRelevance(['instagram'], 'reel').publishAsDraft).toBe(false);
  });

  // Spec 14: rich link/CTA - tgCta (Telegram) and dcEmbed (Discord) are each
  // lane-exclusive and not type-gated (any post type on that lane can carry one).
  it('spec 14: tgCta is Telegram-only, dcEmbed is Discord-only, neither is type-gated', () => {
    expect(fieldRelevance(['telegram'], 'text').tgCta).toBe(true);
    expect(fieldRelevance(['telegram'], 'video').tgCta).toBe(true);
    expect(fieldRelevance(['discord'], 'text').tgCta).toBe(false);
    expect(fieldRelevance(['discord'], 'text').dcEmbed).toBe(true);
    expect(fieldRelevance(['discord'], 'video').dcEmbed).toBe(true);
    expect(fieldRelevance(['telegram'], 'text').dcEmbed).toBe(false);
  });

  // Spec 25: disclosure & interaction settings - ttInteraction (TikTok),
  // spoilerText (Mastodon), xReplySettings (X) are each lane-exclusive and not
  // type-gated (any post type on that lane can carry one).
  it('spec 25: ttInteraction is TikTok-only, spoilerText is Mastodon-only, xReplySettings is X-only', () => {
    expect(fieldRelevance(['tiktok'], 'video').ttInteraction).toBe(true);
    expect(fieldRelevance(['tiktok'], 'text').ttInteraction).toBe(true);
    expect(fieldRelevance(['mastodon'], 'video').ttInteraction).toBe(false);
    expect(fieldRelevance(['mastodon'], 'video').spoilerText).toBe(true);
    expect(fieldRelevance(['mastodon'], 'text').spoilerText).toBe(true);
    expect(fieldRelevance(['x'], 'video').spoilerText).toBe(false);
    expect(fieldRelevance(['x'], 'video').xReplySettings).toBe(true);
    expect(fieldRelevance(['x'], 'text').xReplySettings).toBe(true);
    expect(fieldRelevance(['mastodon'], 'video').xReplySettings).toBe(false);
  });
});

describe('fieldsForPost', () => {
  const post = (platforms, type, extra = {}) => ({ platforms, type, ...extra });

  it('a YouTube short leads with title, then description + tags — no caption field', () => {
    const { fields } = fieldsForPost(post(['youtube'], 'youtube-short'));
    const keys = fields.map((f) => f.key);
    expect(keys).not.toContain('caption');
    expect(keys[0]).toBe('title'); // primary text leads
    expect(keys).toContain('description');
    expect(keys).toContain('tags');
  });

  it('a meta reel leads with the caption', () => {
    const { fields } = fieldsForPost(post(['instagram', 'facebook'], 'reel'));
    expect(fields[0].key).toBe('caption');
    expect(fields.map((f) => f.key)).toContain('firstComment');
  });

  it('an X-only post with NO saved override collapses to ONE text field (+ reply-to, + alt-text)', () => {
    const { fields } = fieldsForPost(post(['x'], 'video'));
    const keys = fields.map((f) => f.key);
    // Single-lane collapse: the caption IS the tweet, so no separate xCaption.
    expect(keys).toEqual(['caption', 'xReplyTo', 'altText']);
  });

  it('an X-only post with a LEGACY override keeps caption + xCaption, scoped to X', () => {
    const { fields } = fieldsForPost(post(['x'], 'video', { xCaption: 'tweet' }));
    const keys = fields.map((f) => f.key);
    expect(keys).toEqual(['caption', 'xCaption', 'xReplyTo', 'altText']);
    const x = fields.find((f) => f.key === 'xCaption');
    expect(x.platforms).toEqual(['x']);
  });

  it('a multi-platform X post keeps the override (base + per-lane text differ)', () => {
    const { fields } = fieldsForPost(post(['x', 'instagram'], 'video'));
    expect(fields.map((f) => f.key)).toContain('xCaption');
  });

  it('scopes each field to the targeted platforms that consume it (icons)', () => {
    const { fields } = fieldsForPost(post(['facebook', 'instagram', 'youtube'], 'video'));
    const caption = fields.find((f) => f.key === 'caption');
    // caption icons: fb + ig (youtube is NOT a caption platform)
    expect(caption.platforms).toEqual(['facebook', 'instagram']);
    const title = fields.find((f) => f.key === 'title');
    expect(title.platforms).toEqual(['youtube']);
  });

  it('surfaces read-only extras (image / canonicalUrl / ghostEmail) for a Ghost article', () => {
    const { fields, extras } = fieldsForPost(post(['ghost'], 'text'));
    const fKeys = fields.map((f) => f.key);
    const eKeys = extras.map((e) => e.key);
    expect(fKeys).toContain('title');
    expect(fKeys).toContain('body');
    expect(eKeys).toContain('image');
    expect(eKeys).toContain('canonicalUrl');
    expect(eKeys).toContain('ghostEmail');
    // Spec 01: the three newsletter refinements ride the same ghost gate.
    expect(eKeys).toContain('newsletter');
    expect(eKeys).toContain('emailSegment');
    expect(eKeys).toContain('emailOnly');
  });

  // Specs 27+43: draft/pending-review publish status is a read-only review extra
  // (like ghostEmail) - shown for wordpress/ghost/tiktok, never for a lane that
  // doesn't support a native draft/inbox handoff.
  it('surfaces publishAsDraft as a read-only extra for wordpress, ghost and tiktok', () => {
    expect(fieldsForPost(post(['wordpress'], 'text')).extras.map((e) => e.key)).toContain('publishAsDraft');
    expect(fieldsForPost(post(['ghost'], 'text')).extras.map((e) => e.key)).toContain('publishAsDraft');
    expect(fieldsForPost(post(['tiktok'], 'video')).extras.map((e) => e.key)).toContain('publishAsDraft');
    expect(fieldsForPost(post(['linkedin'], 'text')).extras.map((e) => e.key)).not.toContain('publishAsDraft');
  });

  it('a pure text post targeting only chat lanes shows the caption + per-lane overrides + Discord thread fields (+ the empty tgCta/dcEmbed review extras)', () => {
    const { fields, extras } = fieldsForPost(post(['telegram', 'discord'], 'text'));
    // Spec 26: dcThreadName/dcThreadId are plain EDITABLE fields (like xReplyTo),
    // not review-only extras - they list here whenever discord is targeted.
    // B1: tgCaption/dcCaption follow the multi-lane xCaption rule - the override
    // stays visible on a multi-platform post (base + per-lane text can differ).
    expect(fields.map((f) => f.key)).toEqual(['caption', 'tgCaption', 'dcCaption', 'dcThreadName', 'dcThreadId']);
    // Spec 14: tgCta/dcEmbed are RELEVANT the moment their lane is targeted (like
    // gbp), so they list as review extras here - PostExtras itself only renders a
    // row once the operator has actually authored one (content-gated, §6).
    expect(extras.map((e) => e.key)).toEqual(['tgCta', 'dcEmbed']);
  });

  // B1: the new overrides collapse exactly like xCaption - a single-lane post
  // authors ONE text (the caption), so its still-empty override is hidden; a
  // saved override (the MCP-agent case this fix exists for) always renders.
  it('B1: a telegram-only post with NO saved override collapses to the one caption field', () => {
    const { fields } = fieldsForPost(post(['telegram'], 'text'));
    expect(fields.map((f) => f.key)).toEqual(['caption']);
  });

  it('B1: a telegram-only post with a saved tgCaption keeps caption + tgCaption, scoped to telegram', () => {
    const { fields } = fieldsForPost(post(['telegram'], 'text', { tgCaption: 'vip text' }));
    expect(fields.map((f) => f.key)).toEqual(['caption', 'tgCaption']);
    expect(fields.find((f) => f.key === 'tgCaption').platforms).toEqual(['telegram']);
  });

  it('B1: a reddit-only post with a saved redditText keeps caption + redditText', () => {
    const { fields } = fieldsForPost(post(['reddit'], 'text', { redditText: 'self-post body' }));
    const keys = fields.map((f) => f.key);
    expect(keys).toContain('caption');
    expect(keys).toContain('redditText');
  });

  it('B1: a pinterest post shows pinTitle always, pinDescription per the override collapse', () => {
    // Empty override on a single-lane post: pinDescription collapses (the caption
    // IS the pin description), but pinTitle stays - it shadows post.title, which
    // has no pinterest surface of its own.
    const bare = fieldsForPost(post(['pinterest'], 'video'));
    expect(bare.fields.map((f) => f.key)).toEqual(['caption', 'pinTitle', 'altText']);
    // A saved pinDescription (the MCP-agent case) always renders.
    const withDesc = fieldsForPost(post(['pinterest'], 'video', { pinDescription: 'pin copy' }));
    expect(withDesc.fields.map((f) => f.key)).toEqual(['caption', 'pinTitle', 'pinDescription', 'altText']);
  });

  it('never lists a field no targeted platform uses', () => {
    const { fields, extras } = fieldsForPost(post(['x'], 'video'));
    const all = [...fields, ...extras].map((f) => f.key);
    expect(all).not.toContain('title');
    expect(all).not.toContain('description');
    expect(all).not.toContain('body');
  });

  // Spec 25: spoilerText is an EDITABLE (inline) field like mastodonCaption;
  // ttInteraction (structured) and xReplySettings (a select value) are read-only
  // review extras, like gbp/tgCta/dcEmbed.
  it('spec 25: spoilerText is editable inline for mastodon; ttInteraction/xReplySettings are review extras', () => {
    const masto = fieldsForPost(post(['mastodon'], 'video'));
    expect(masto.fields.map((f) => f.key)).toContain('spoilerText');
    expect(masto.extras.map((e) => e.key)).not.toContain('spoilerText');

    const tiktok = fieldsForPost(post(['tiktok'], 'video'));
    expect(tiktok.extras.map((e) => e.key)).toContain('ttInteraction');
    expect(tiktok.fields.map((f) => f.key)).not.toContain('ttInteraction');

    const x = fieldsForPost(post(['x'], 'video'));
    expect(x.extras.map((e) => e.key)).toContain('xReplySettings');
    expect(x.fields.map((f) => f.key)).not.toContain('xReplySettings');
  });
});
