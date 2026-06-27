#!/usr/bin/env node
// test/x-profile-signing.test.mjs - offline correctness gate for the OAuth 1.0a
// signing of the X v1.1 account/* profile-edit endpoints (scripts/x-social.mjs
// cmdProfile). NO credentials, network, or account: pure lib/x-oauth1.mjs over
// fixed inputs with injected nonce/timestamp, so signatures are deterministic.
//
// Two load-bearing claims:
//  1. update_profile sends its fields as SIGNED query params - they MUST enter the
//     signature base string (sorted, percent-encoded), exactly like a tweet's params.
//  2. update_profile_image / _banner send the binary as MULTIPART - the image/banner
//     field MUST NOT enter the signature (only the oauth_* set does), mirroring the
//     chunked media upload (uploadCommand signs oauth1Header('POST', endpoint, {}, o1)).
import assert from 'node:assert';
import { signatureBaseString, oauth1Signature, oauth1Header, pctEncode } from '../lib/x-oauth1.mjs';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const CREDS = { consumerKey: 'CK_demo', consumerSecret: 'CS_demo', token: 'TK_demo', tokenSecret: 'TS_demo' };
const NT = { nonce: 'fixednonce0123456789', timestamp: '1700000000' };
const OAUTH = {
  oauth_consumer_key: CREDS.consumerKey,
  oauth_nonce: NT.nonce,
  oauth_signature_method: 'HMAC-SHA1',
  oauth_timestamp: NT.timestamp,
  oauth_token: CREDS.token,
  oauth_version: '1.0',
};
const sigOf = (header) => { const m = /oauth_signature="([^"]+)"/.exec(header); return m ? decodeURIComponent(m[1]) : null; };

// ---- 1. update_profile: fields ARE signed query params --------------------
const UP_URL = 'https://api.twitter.com/1.1/account/update_profile.json';
const FIELDS = { name: 'pendpost', description: 'agent-operated social media with a human approval gate.', skip_status: 'true', include_entities: 'false' };
const upBase = signatureBaseString('POST', UP_URL, { ...FIELDS, ...OAUTH });

ok(upBase.startsWith(`POST&${pctEncode(UP_URL)}&`), 'update_profile base string is POST&<encoded url>&<params>');
ok(upBase.includes('name%3Dpendpost'), 'update_profile base string carries name=pendpost (field is signed)');
ok(upBase.includes('description%3D'), 'update_profile base string carries the description key (bio is signed)');
// Params sorted by encoded key: description < include_entities < name < oauth_consumer_key < skip_status.
const idx = (k) => upBase.indexOf(`${k}%3D`);
ok(idx('description') >= 0 && idx('description') < idx('include_entities')
  && idx('include_entities') < idx('name')
  && idx('name') < idx('oauth_consumer_key')
  && idx('oauth_consumer_key') < idx('skip_status'),
  'update_profile params are sorted by encoded key in the base string');

// End-to-end: oauth1Header embeds the signature over EXACTLY that base string.
const upHeader = oauth1Header('POST', UP_URL, FIELDS, CREDS, NT);
const upExpectSig = oauth1Signature('POST', UP_URL, { ...FIELDS, ...OAUTH }, CREDS.consumerSecret, CREDS.tokenSecret);
ok(sigOf(upHeader) === upExpectSig, 'update_profile oauth1Header embeds the signature over the signed fields');
ok(oauth1Header('POST', UP_URL, FIELDS, CREDS, NT) === upHeader, 'update_profile signing is deterministic for a fixed nonce/timestamp');
// Changing a signed field MUST change the signature (proves the field enters the base).
ok(sigOf(oauth1Header('POST', UP_URL, { ...FIELDS, name: 'other' }, CREDS, NT)) !== upExpectSig,
  'changing name changes the signature (name is signed)');
ok(sigOf(oauth1Header('POST', UP_URL, { ...FIELDS, description: 'different bio' }, CREDS, NT)) !== upExpectSig,
  'changing the bio/description changes the signature (bio is signed)');

// ---- 2. update_profile_image / _banner: multipart field is NOT signed -----
const IMG_URL = 'https://api.twitter.com/1.1/account/update_profile_image.json';
const BAN_URL = 'https://api.twitter.com/1.1/account/update_profile_banner.json';
// The engine signs these with EMPTY signed params (the multipart body is excluded).
const imgBase = signatureBaseString('POST', IMG_URL, { ...OAUTH });
// The endpoint URL legitimately contains the word "image"; the load-bearing claim
// is that no image=/banner= PARAM is signed (the multipart field is excluded).
ok(!imgBase.includes('image%3D') && !imgBase.includes('banner%3D'),
  'image base string carries NO image=/banner= param (multipart field excluded from the signature)');
ok(imgBase.includes('oauth_consumer_key%3D'), 'image base string still carries the oauth_* set');

const imgHeader = oauth1Header('POST', IMG_URL, {}, CREDS, NT);
const imgExpectSig = oauth1Signature('POST', IMG_URL, { ...OAUTH }, CREDS.consumerSecret, CREDS.tokenSecret);
ok(sigOf(imgHeader) === imgExpectSig, 'update_profile_image oauth1Header signs only the oauth_* set (empty signed params)');
ok(!imgHeader.includes('image'), 'update_profile_image Authorization header carries no image param');
ok(sigOf(oauth1Header('POST', BAN_URL, {}, CREDS, NT)) !== imgExpectSig,
  'banner vs image signatures differ (distinct endpoint base URL)');

console.log(`[x-profile-signing] OK - profile-edit signing: fields signed for update_profile, multipart field excluded for image/banner (${pass} assertions).`);
