import { describe, it, expect } from 'vitest';
import { effectiveLaneText } from '../format.js';

// The hand-off ("post it yourself") used to copy post.caption only, but the engines
// publish the per-lane EFFECTIVE text: reddit publishes (redditText || caption), X
// publishes (xCaption || caption), and so on. So the clipboard could differ from what
// the approval gate approved - a leak in the "post exactly this" promise (ux-audit
// dim-1, gap G5). effectiveLaneText is the ONE resolver, and each row below mirrors
// the engine's own resolution line - the precedence is copied, never invented.

const CAPTION = 'The shared caption everyone falls back to.';

// [platform, overrideField, engine source of the rule]
const OVERRIDE_LANES = [
  ['x', 'xCaption', 'scripts/x-social.mjs tweetText'],
  ['telegram', 'tgCaption', 'scripts/telegram-social.mjs messageText'],
  ['discord', 'dcCaption', 'scripts/discord-social.mjs messageText'],
  ['tiktok', 'ttCaption', 'scripts/tiktok-social.mjs captionText'],
  ['mastodon', 'mastodonCaption', 'scripts/mastodon-social.mjs statusText'],
  ['nostr', 'nostrCaption', 'scripts/nostr-social.mjs noteText'],
  ['reddit', 'redditText', 'scripts/reddit-social.mjs bodyText'],
  ['pinterest', 'pinDescription', 'scripts/pinterest-social.mjs pinDescription'],
  ['wordpress', 'body', 'scripts/wordpress-social.mjs bodyMarkdown'],
  ['ghost', 'body', 'scripts/ghost-social.mjs postHtml'],
];

describe('lanes with a per-platform override field', () => {
  it.each(OVERRIDE_LANES)('%s: the %s override wins when set', (platform, field) => {
    const post = { caption: CAPTION, [field]: `The ${platform} version.` };
    expect(effectiveLaneText(post, platform)).toBe(`The ${platform} version.`);
  });

  it.each(OVERRIDE_LANES)('%s: falls back to the shared caption when %s is unset', (platform) => {
    expect(effectiveLaneText({ caption: CAPTION }, platform)).toBe(CAPTION);
  });

  it.each(OVERRIDE_LANES)('%s: a blank %s override is unset, not empty text', (platform, field) => {
    // Engines use (override || caption) - falsy/whitespace overrides never publish blank.
    expect(effectiveLaneText({ caption: CAPTION, [field]: '   ' }, platform)).toBe(CAPTION);
  });
});

describe('lanes that publish the shared caption directly', () => {
  it.each(['instagram', 'facebook', 'linkedin', 'bluesky', 'gbp'])('%s publishes the caption', (platform) => {
    // Another lane's override never bleeds across.
    const post = { caption: CAPTION, xCaption: 'The x version.', redditText: 'The reddit version.' };
    expect(effectiveLaneText(post, platform)).toBe(CAPTION);
  });
});

describe('youtube', () => {
  it('publishes post.description and ONLY post.description (yt-social.mjs buildMeta)', () => {
    // The yt engine has no caption fallback: snippet.description = post.description || ''.
    // Faithfulness beats helpfulness - copying the caption here would hand over text
    // the engine would never have published.
    expect(effectiveLaneText({ caption: CAPTION, description: 'The video description.' }, 'youtube')).toBe('The video description.');
    expect(effectiveLaneText({ caption: CAPTION }, 'youtube')).toBe('');
  });
});

describe('edges', () => {
  it('trims the resolved text, like every engine resolver does', () => {
    expect(effectiveLaneText({ caption: `  ${CAPTION}  ` }, 'x')).toBe(CAPTION);
  });

  it('returns the empty string with nothing to resolve', () => {
    expect(effectiveLaneText({}, 'x')).toBe('');
    expect(effectiveLaneText(null, 'telegram')).toBe('');
  });

  it('an unknown platform falls back to the caption (the dominant engine rule)', () => {
    expect(effectiveLaneText({ caption: CAPTION }, 'somefutureplatform')).toBe(CAPTION);
  });
});
