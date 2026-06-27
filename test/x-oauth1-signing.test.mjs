#!/usr/bin/env node
// test/x-oauth1-signing.test.mjs - offline correctness gate for the X OAuth 1.0a
// (HMAC-SHA1) request signing used by scripts/x-social.mjs. NO credentials, no
// network, no account: it reproduces X's own documented "Creating a signature"
// worked example (https://docs.x.com/fundamentals/authentication/oauth-1-0a/
// creating-a-signature) and asserts our signing math matches it byte-for-byte.
//
// If this passes, the OAuth 1.0a Authorization header the engine sends is built
// exactly as X specifies, so a 401 "Could not authenticate you" (code 32) can be
// blamed on a wrong/typo'd credential, never on the signing algorithm.
//
// Provenance note: the X "Creating a signature" page documents this example with
// base URL https://api.x.com/1.1/statuses/update.json and consumer secret ending
// ...PAoE3Z7kBw, yielding oauth_signature `Ls93hJiZbQ3akF3HF3x1Bz8/zU4=`. (The
// older developer.twitter.com page used the same params against api.twitter.com,
// which yields the historic `hCtSmYh+iHYCEqBWrE7C7hYmtUk=`.) We pin the CURRENT
// docs.x.com value.
import assert from 'node:assert';
import {
  pctEncode,
  signatureBaseString,
  signingKey,
  oauth1Signature,
  oauth1Header,
} from '../lib/x-oauth1.mjs';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

// ---- X's documented "Creating a signature" example (docs.x.com) ----
const METHOD = 'POST';
const BASE_URL = 'https://api.x.com/1.1/statuses/update.json';
// The two request parameters from the example.
const REQUEST_PARAMS = {
  status: 'Hello Ladies + Gentlemen, a signed OAuth request!',
  include_entities: 'true',
};
// The OAuth parameters from the example.
const OAUTH_PARAMS = {
  oauth_consumer_key: 'xvz1evFS4wEEPTGEFPHBog',
  oauth_nonce: 'kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg',
  oauth_signature_method: 'HMAC-SHA1',
  oauth_timestamp: '1318622958',
  oauth_token: '370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb',
  oauth_version: '1.0',
};
const CONSUMER_SECRET = 'kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw';
const TOKEN_SECRET = 'LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE';

// The values X documents as the expected intermediate + final results.
const DOC_BASE_STRING = 'POST&https%3A%2F%2Fapi.x.com%2F1.1%2Fstatuses%2Fupdate.json&include_entities%3Dtrue%26oauth_consumer_key%3Dxvz1evFS4wEEPTGEFPHBog%26oauth_nonce%3DkYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg%26oauth_signature_method%3DHMAC-SHA1%26oauth_timestamp%3D1318622958%26oauth_token%3D370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb%26oauth_version%3D1.0%26status%3DHello%2520Ladies%2520%252B%2520Gentlemen%252C%2520a%2520signed%2520OAuth%2520request%2521';
const DOC_SIGNING_KEY = 'kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw&LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE';
const DOC_SIGNATURE = 'Ls93hJiZbQ3akF3HF3x1Bz8/zU4=';

const allParams = { ...REQUEST_PARAMS, ...OAUTH_PARAMS };

// 1. The signature base string matches X's documented base string exactly.
ok(signatureBaseString(METHOD, BASE_URL, allParams) === DOC_BASE_STRING,
  'signature base string equals X documented base string');

// 2. The signing key matches X's documented signing key exactly.
ok(signingKey(CONSUMER_SECRET, TOKEN_SECRET) === DOC_SIGNING_KEY,
  'signing key equals X documented signing key (pctEncode(consumerSecret)&pctEncode(tokenSecret))');

// 3. The HMAC-SHA1 over that base string equals X's documented oauth_signature.
ok(oauth1Signature(METHOD, BASE_URL, allParams, CONSUMER_SECRET, TOKEN_SECRET) === DOC_SIGNATURE,
  `HMAC-SHA1 signature equals X documented value (${DOC_SIGNATURE})`);

// 4. End-to-end: the full Authorization header carries the documented signature
//    (the engine passes only the request params; oauth1Header adds the oauth_* set).
const header = oauth1Header(METHOD, BASE_URL, REQUEST_PARAMS, {
  consumerKey: OAUTH_PARAMS.oauth_consumer_key,
  consumerSecret: CONSUMER_SECRET,
  token: OAUTH_PARAMS.oauth_token,
  tokenSecret: TOKEN_SECRET,
}, { nonce: OAUTH_PARAMS.oauth_nonce, timestamp: OAUTH_PARAMS.oauth_timestamp });
ok(header.startsWith('OAuth '), 'oauth1Header returns an "OAuth ..." Authorization header');
const sigMatch = /oauth_signature="([^"]+)"/.exec(header);
ok(sigMatch && decodeURIComponent(sigMatch[1]) === DOC_SIGNATURE,
  'oauth1Header end-to-end embeds the documented oauth_signature (percent-encoded)');
ok(/oauth_signature_method="HMAC-SHA1"/.test(header) && /oauth_version="1.0"/.test(header),
  'oauth1Header includes oauth_signature_method=HMAC-SHA1 and oauth_version=1.0');

// 5. RFC-3986 percent-encoding escapes the chars encodeURIComponent leaves alone.
ok(pctEncode("Ladies + Gentlemen") === 'Ladies%20%2B%20Gentlemen',
  'pctEncode encodes space as %20 and + as %2B');
ok(pctEncode("!*'()") === '%21%2A%27%28%29',
  "pctEncode escapes ! * ' ( ) that encodeURIComponent leaves unescaped");

console.log(`[x-oauth1-signing] OK - signing reproduces X's documented Creating-a-signature example (${pass} assertions).`);
