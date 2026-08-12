import { describe, it, expect } from 'vitest';
import { splitTweetThread } from '../thread.js';

describe('splitTweetThread', () => {
  it('returns a short text as a single part', () => {
    expect(splitTweetThread('hello world')).toEqual(['hello world']);
  });

  it('keeps every part within the cap and loses no words', () => {
    const sentence = 'This is a sentence about the pendpost approval gate and why it matters. ';
    const text = sentence.repeat(12).trim(); // ~860 chars
    const parts = splitTweetThread(text, 280);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(280);
    expect(parts.join(' ').split(/\s+/)).toEqual(text.split(/\s+/));
  });

  it('prefers a paragraph break over a mid-sentence cut', () => {
    const a = 'x'.repeat(150);
    const b = 'y'.repeat(200);
    const parts = splitTweetThread(`${a}\n\n${b}`, 280);
    expect(parts).toEqual([a, b]);
  });

  it('prefers a sentence end over a word cut', () => {
    const a = `${'word '.repeat(40).trim()}.`; // ~200 chars ending a sentence
    const b = 'tail '.repeat(30).trim();
    const parts = splitTweetThread(`${a} ${b}`, 280);
    expect(parts[0]).toBe(a);
  });

  it('hard-cuts a single over-cap token instead of looping forever', () => {
    const token = 'z'.repeat(600);
    const parts = splitTweetThread(token, 280);
    expect(parts.length).toBe(3);
    expect(parts.join('')).toBe(token);
  });
});
