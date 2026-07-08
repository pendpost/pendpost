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

  it('firstComment is Instagram-feed OR YouTube, never a story', () => {
    expect(fieldRelevance(['instagram'], 'reel').firstComment).toBe(true);
    expect(fieldRelevance(['instagram'], 'story').firstComment).toBe(false);
    expect(fieldRelevance(['youtube'], 'youtube-longform').firstComment).toBe(true);
    expect(fieldRelevance(['linkedin'], 'video').firstComment).toBe(false);
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

  it('telegram / discord / tiktok / reddit / pinterest all ride the shared caption only', () => {
    for (const p of ['telegram', 'discord', 'tiktok', 'reddit', 'pinterest']) {
      const r = fieldRelevance([p], 'video');
      expect(r.caption, p).toBe(true);
      expect(r.title, p).toBe(false);
      expect(r.description, p).toBe(false);
      expect(r.xCaption, p).toBe(false);
    }
  });

  it('is a pure function of platforms + type (empty is all-false)', () => {
    const r = fieldRelevance([], 'reel');
    expect(Object.values(r).every((v) => v === false)).toBe(true);
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

  it('an X-only post with NO saved override collapses to ONE text field (+ reply-to)', () => {
    const { fields } = fieldsForPost(post(['x'], 'video'));
    const keys = fields.map((f) => f.key);
    // Single-lane collapse: the caption IS the tweet, so no separate xCaption.
    expect(keys).toEqual(['caption', 'xReplyTo']);
  });

  it('an X-only post with a LEGACY override keeps caption + xCaption, scoped to X', () => {
    const { fields } = fieldsForPost(post(['x'], 'video', { xCaption: 'tweet' }));
    const keys = fields.map((f) => f.key);
    expect(keys).toEqual(['caption', 'xCaption', 'xReplyTo']);
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
  });

  it('a pure text post targeting only chat lanes shows just the caption', () => {
    const { fields, extras } = fieldsForPost(post(['telegram', 'discord'], 'text'));
    expect(fields.map((f) => f.key)).toEqual(['caption']);
    expect(extras).toEqual([]);
  });

  it('never lists a field no targeted platform uses', () => {
    const { fields, extras } = fieldsForPost(post(['x'], 'video'));
    const all = [...fields, ...extras].map((f) => f.key);
    expect(all).not.toContain('title');
    expect(all).not.toContain('description');
    expect(all).not.toContain('body');
  });
});
