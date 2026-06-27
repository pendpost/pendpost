// x-oauth1.mjs - OAuth 1.0a (HMAC-SHA1) User Context request signing for X (Twitter).
//
// Extracted from the X engine (scripts/x-social.mjs) into a standalone, side-effect-free
// module so the signing math is verifiable OFFLINE against X's documented "Creating a
// signature" worked example (test/x-oauth1-signing.test.mjs) with zero credentials, zero
// network, and without running the engine's CLI. Nothing here reads env, the filesystem,
// or the network - it is pure functions over its arguments.
//
// OAuth 1.0a User Context is X's zero-browser auth path: a portal-generated API key/secret
// (consumer key/secret) plus an access token/secret sign every request HMAC-SHA1, with no
// redirect ceremony. See README.md "Going live" and .env.example for how the four env vars
// (X_API_KEY / X_API_SECRET / X_ACCESS_TOKEN / X_ACCESS_TOKEN_SECRET) are sourced.
import crypto from 'node:crypto';

// RFC-3986 percent-encoding. encodeURIComponent already escapes most reserved characters
// but leaves ! * ' ( ) unescaped; OAuth 1.0a requires those escaped too.
export function pctEncode(str) {
  return encodeURIComponent(String(str)).replace(/[!*'()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

// The OAuth 1.0a signature base string: METHOD + "&" + pctEncode(baseUrl) + "&" +
// pctEncode(sorted "k=v&..." paramString). `params` is EVERY parameter that enters the
// signature: the oauth_* set plus any signed request params (query-string params always
// + x-www-form-urlencoded body params; JSON and multipart bodies contribute none). Keys
// and values are percent-encoded, then sorted by encoded key (ties broken by encoded value).
export function signatureBaseString(method, baseUrl, params) {
  const paramString = Object.keys(params)
    .map((k) => [pctEncode(k), pctEncode(params[k])])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  return `${method.toUpperCase()}&${pctEncode(baseUrl)}&${pctEncode(paramString)}`;
}

// The OAuth 1.0a signing key: pctEncode(consumerSecret) + "&" + pctEncode(tokenSecret).
export function signingKey(consumerSecret, tokenSecret) {
  return `${pctEncode(consumerSecret)}&${pctEncode(tokenSecret)}`;
}

// HMAC-SHA1 over the base string with the signing key, base64-encoded (= oauth_signature).
export function oauth1Signature(method, baseUrl, params, consumerSecret, tokenSecret) {
  return crypto.createHmac('sha1', signingKey(consumerSecret, tokenSecret))
    .update(signatureBaseString(method, baseUrl, params))
    .digest('base64');
}

// Build the signed `Authorization: OAuth ...` header. `signedParams` are the request
// params that MUST enter the base string (query-string params always + form-urlencoded
// body params; JSON/multipart contribute none). `creds` = { consumerKey, consumerSecret,
// token, tokenSecret }. nonce/timestamp default to fresh random/now values; they are
// injectable so the signing can be reproduced deterministically in tests.
export function oauth1Header(method, baseUrl, signedParams, creds, { nonce, timestamp } = {}) {
  const oauth = {
    oauth_consumer_key: creds.consumerKey,
    oauth_nonce: nonce || crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: timestamp || String(Math.floor(Date.now() / 1000)),
    oauth_token: creds.token,
    oauth_version: '1.0',
  };
  oauth.oauth_signature = oauth1Signature(method, baseUrl, { ...signedParams, ...oauth }, creds.consumerSecret, creds.tokenSecret);
  return `OAuth ${Object.keys(oauth).sort().map((k) => `${pctEncode(k)}="${pctEncode(oauth[k])}"`).join(', ')}`;
}
