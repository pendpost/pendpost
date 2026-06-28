#!/usr/bin/env node
// test/connect-clientid.test.mjs - the GUI Connect panel's OAuth client id must NOT
// ride the reserved `clientId` body key. `clientId` is how a request selects its
// workspace (resolveClientId -> clientRoot, validated against the workspace-slug
// regex /^[a-z0-9][a-z0-9-]*$/). A real Google OAuth client id has dots
// (715549991658-....apps.googleusercontent.com), so it fails that regex and 400s
// the connect request before startConnect ever runs. The fix renames the field to
// `oauthClientId`; this guards that the rename keeps the OAuth id out of routing
// while real workspace selection via `clientId` still works.
//
// We test the ROUTING HELPER (resolveClientId) directly rather than POSTing a valid
// connect body to handleApi: a valid connect body would make startConnect spawn
// scripts/yt-social.mjs auth, which binds a port and opens a browser - it is NOT
// mock-safe. resolveClientId is a pure body/query peek, so it is the right seam.
//
// PENDPOST_MODE=mock + a throwaway PENDPOST_ROOT, both set BEFORE importing lib
// (util binds WORKSPACE_ROOT at import; mirrors test/x-profile-mock.test.mjs).
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-connect-id-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';

const { resolveClientId } = await import('../lib/api.mjs');
const { clientRoot } = await import('../lib/multi-client.mjs');

// A non-GET, application/json request whose body resolveClientId peeks.
function mockReq(body) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  req.method = 'POST';
  req.headers = { 'content-type': 'application/json' };
  return req;
}

const OAUTH_ID = '715549991658-hffv7q7h7atteae6hk44nh2913jv6dpq.apps.googleusercontent.com';

try {
  // a. A connect-shaped body on the NEW field name does not hijack workspace routing.
  //    null => handleApi falls back to activeClientId(), so the dotted OAuth id never
  //    reaches clientRoot (this is the whole point of the rename).
  {
    const got = await resolveClientId(
      mockReq({ platform: 'youtube', oauthClientId: OAUTH_ID, clientSecret: 'shh' }),
      new URL('http://127.0.0.1/api/connect'),
    );
    ok(got === null, 'connect body with oauthClientId does NOT select a workspace (resolves to null)');
  }

  // b. Workspace selection via the reserved key still works.
  {
    const got = await resolveClientId(
      mockReq({ clientId: 'acme' }),
      new URL('http://127.0.0.1/api/config'),
    );
    ok(got === 'acme', 'reserved clientId body key still selects the workspace ("acme")');
  }

  // c. Document the reserved-key contract (why the rename was needed): a dotted OAuth
  //    id fails the workspace-slug regex in clientRoot, a real slug passes.
  {
    assert.throws(() => clientRoot(OAUTH_ID), /client id must match/);
    ok(true, 'clientRoot rejects a dotted OAuth id (would have 400d if it reached routing)');
    assert.doesNotThrow(() => clientRoot('default'));
    ok(true, 'clientRoot accepts a real workspace slug ("default")');
  }

  console.log(`[connect-clientid] OK - OAuth client id rides oauthClientId, not the reserved clientId routing key (${pass} assertions).`);
} catch (err) {
  console.error(`[connect-clientid] FAIL - ${err && err.message}`);
  process.exitCode = 1;
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
