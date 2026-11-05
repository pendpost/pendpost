import { describe, it, expect } from 'vitest';
import { postBodyText, postCaptionBody, postCaptionRun, markdownToText } from '../format.js';

// A row shows the text that will actually publish (2026-11-05). The titled lanes keep their body
// in their own field (yt-social.mjs buildMeta reads post.description, reddit-social.mjs bodyText
// post.redditText, pinterest-social.mjs pinDescription, wordpress / ghost post.body), so a row
// that read post.caption alone showed a YouTube title with nothing under it.
describe('postBodyText', () => {
  it('shows the YouTube description when the caption is empty', () => {
    const post = { title: 'Morning light', platforms: ['youtube'], caption: '', description: 'A study with 140 people.\nSources below.' };
    expect(postBodyText(post)).toBe('A study with 140 people.\nSources below.');
    expect(postCaptionRun(post)).toBe('A study with 140 people. Sources below.');
  });

  it('lets the shared caption win on a cross-post where a lane publishes it', () => {
    const post = { title: 'Morning light', platforms: ['instagram', 'youtube'], caption: 'The Reel caption.', description: 'The video description.' };
    expect(postBodyText(post)).toBe('The Reel caption.');
  });

  it('shows the description on a YouTube-only post even when a caption is set (YouTube never publishes the caption)', () => {
    const post = { title: 'Morning light', platforms: ['youtube'], caption: 'Unused caption.', description: 'The video description.' };
    expect(postBodyText(post)).toBe('The video description.');
  });

  it('keeps the caption when no lane publishes anything (old rows stay as they were)', () => {
    expect(postBodyText({ title: 'T', platforms: ['youtube'], caption: 'Only a caption.' })).toBe('Only a caption.');
  });

  it('shows the Reddit text', () => {
    expect(postBodyText({ title: 'Ask', platforms: ['reddit'], caption: '', redditText: 'What do you use for scheduling?' })).toBe('What do you use for scheduling?');
  });

  it('shows the Pinterest pin description', () => {
    expect(postBodyText({ title: 'Pin', platforms: ['pinterest'], pinDescription: 'Ten ideas for a calm morning.' })).toBe('Ten ideas for a calm morning.');
  });

  it('shows the Ghost excerpt before the body', () => {
    const post = { title: 'Release notes', platforms: ['ghost'], excerpt: 'What changed in 2.10.', body: '# Release notes\n\nLong article.' };
    expect(postBodyText(post)).toBe('What changed in 2.10.');
  });

  it('reads the WordPress markdown body as plain text', () => {
    const post = { title: 'Guide', platforms: ['wordpress'], body: '## Setup\n\nRun **one** command, see [the docs](https://example.com).\n\n![shot](a.png)\n\n```sh\nnpm i\n```' };
    expect(postBodyText(post)).toBe('Setup\n\nRun one command, see the docs.\n\nnpm i');
  });

  it('drops a description first line that repeats the title', () => {
    const post = { title: 'Morning light', platforms: ['youtube'], description: 'Morning light\nA study with 140 people.' };
    expect(postCaptionBody(post)).toBe('A study with 140 people.');
  });

  it('drops a markdown heading that repeats the title', () => {
    const post = { title: 'Release notes', platforms: ['wordpress'], body: '# Release notes\n\nWhat changed.' };
    expect(postCaptionRun(post)).toBe('What changed.');
  });
});

describe('markdownToText', () => {
  it('keeps words with underscores and plain asterisks intact', () => {
    expect(markdownToText('Use snake_case_name and 2 * 3 here, _really_.')).toBe('Use snake_case_name and 2 * 3 here, really.');
  });

  it('strips list, quote and rule marks', () => {
    expect(markdownToText('- one\n- two\n\n> quoted\n\n---\nend')).toBe('one\ntwo\n\nquoted\n\nend');
  });
});
