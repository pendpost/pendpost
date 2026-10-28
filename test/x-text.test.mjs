#!/usr/bin/env node
// test/x-text.test.mjs - X tweet length is counted ONE way (lib/x-text.mjs), the
// way X counts it, and both the readiness validator and the publisher use it.
//
// Regression: the validator weighted URLs as 23 while scripts/x-social.mjs refused
// on raw .length, so a link-heavy tweet passed approval and was refused at publish.
//
// Zero-dep node:assert.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { xWeightedLength, xFits, X_TWEET_LIMIT } from '../lib/x-text.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// twitter-text v3 rules.
assert.equal(xWeightedLength('hello'), 5);
assert.equal(xWeightedLength('https://pendpost.com/blog/a-very-long-slug-that-keeps-going'), 23, 'a URL counts 23');
assert.equal(xWeightedLength('see pendpost.com now'), 31, 'a bare domain is linked and counts 23');
assert.equal(xWeightedLength('mail me@x.com'), 13, 'an email address is not a link');
assert.equal(xWeightedLength('👍'), 2, 'an emoji counts 2');
assert.equal(xWeightedLength('👨‍👩‍👧'), 2, 'a ZWJ family is one emoji');
assert.equal(xWeightedLength('🇨🇭'), 2, 'a flag is one emoji');
assert.equal(xWeightedLength('日本'), 4, 'CJK counts 2 per character');
assert.equal(xWeightedLength('café'), 4, 'NFC-normalized before counting');

// A link-heavy tweet: over 280 raw characters, 255 as X counts them (the launch
// thread that exposed the bug was 294 raw, 255 counted).
const longUrl = `https://pendpost.com/${'x'.repeat(62)}`;
const launch = `${'a'.repeat(231)} ${longUrl}`;
assert.equal(launch.length, 315);
assert.equal(xWeightedLength(launch), 255);
assert.equal(xFits(launch), true);
assert.equal(xFits('a'.repeat(X_TWEET_LIMIT + 1)), false);

// Both gates import the shared counter; no raw .length check on tweet text remains.
const publisher = fs.readFileSync(path.join(ROOT, 'scripts/x-social.mjs'), 'utf8');
const validator = fs.readFileSync(path.join(ROOT, 'lib/writes.mjs'), 'utf8');
assert.match(publisher, /from '\.\.\/lib\/x-text\.mjs'/);
assert.match(validator, /from '\.\/x-text\.mjs'/);
assert.doesNotMatch(publisher, /(text|body)\.length > TWEET_LIMIT/, 'the publisher must not count raw length');

console.log('x-text: all assertions passed');
