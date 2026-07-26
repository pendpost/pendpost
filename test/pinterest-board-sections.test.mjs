#!/usr/bin/env node
// test/pinterest-board-sections.test.mjs - spec 17 (Pinterest board-section read
// verb + lib face).
//   1. LIVE (stubbed global.fetch, no network): the engine's board-sections verb
//      normalizes a paginated GET /v5/boards/{id}/sections response into
//      { items:[{id,name}], boardId }.
//   2. LIB FACE (P9): the `board-sections` verb is LIVE-ONLY (left out of
//      MOCKABLE_COMMANDS, like probe/flairs), so with no credentials
//      listPinterestBoardSections degrades to a STRUCTURED ok:FALSE
//      (not_configured / needs_scope) - NEVER a false-empty { ok:true, items:[] }
//      that would read as "no sections" for a read that failed.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-pin-sections-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));

// Guarded entrypoint (no main() on import) - cmdBoardSections + RUN are importable
// without running the CLI (mirrors cmdPublishDue in pinterest-video-pin.test.mjs).
const { cmdBoardSections, RUN } = await import('../scripts/pinterest-social.mjs');
const { listPinterestBoardSections } = await import('../lib/writes.mjs');

try {
  // ---- (1) LIVE: normalizes a paginated sections response --------------------
  {
    fs.writeFileSync(path.join(WS, '.env'), [
      'PINTEREST_ACCESS_TOKEN=tok',
      `PINTEREST_TOKEN_EXPIRES_AT=${Date.now() + 3600_000}`,
      'PINTEREST_BOARD_ID=board1',
    ].join('\n'));
    const realFetch = global.fetch;
    const jsonRes = (status, body) => Promise.resolve({ ok: status >= 200 && status < 300, status, text: () => Promise.resolve(JSON.stringify(body)) });
    let calls = 0;
    global.fetch = (url) => {
      const u = new URL(String(url));
      assert.strictEqual(u.pathname, '/v5/boards/board1/sections', 'requests the real v5 sections path for the resolved board');
      calls += 1;
      if (calls === 1) {
        return jsonRes(200, { items: [{ id: 's1', name: 'Recipes' }], bookmark: 'next-page' });
      }
      return jsonRes(200, { items: [{ id: 's2', name: 'DIY' }, { id: '', name: 'junk-no-id' }], bookmark: null });
    };
    try {
      await cmdBoardSections({});
      const row = RUN.results.filter((r) => r.action === 'board-sections').at(-1);
      ok(row && row.ok === true, 'a successful read resolves ok:true');
      ok(row.boardId === 'board1', 'boardId falls back to PINTEREST_BOARD_ID when --boardId is omitted');
      ok(Array.isArray(row.items) && row.items.length === 2, 'items normalizes across BOTH pages (bookmark pagination), dropping the id-less junk entry');
      ok(row.items[0].id === 's1' && row.items[0].name === 'Recipes', 'a section normalizes to { id, name }');
      ok(calls === 2, 'the bookmark cursor drives a second page fetch');
    } finally {
      global.fetch = realFetch;
    }
  }

  // ---- (1b) LIVE: an explicit --boardId overrides PINTEREST_BOARD_ID ---------
  {
    const realFetch = global.fetch;
    const jsonRes = (status, body) => Promise.resolve({ ok: status >= 200 && status < 300, status, text: () => Promise.resolve(JSON.stringify(body)) });
    global.fetch = (url) => {
      const u = new URL(String(url));
      assert.strictEqual(u.pathname, '/v5/boards/otherBoard/sections', 'the explicit boardId argument wins over PINTEREST_BOARD_ID');
      return jsonRes(200, { items: [], bookmark: null });
    };
    try {
      await cmdBoardSections({ boardId: 'otherBoard' });
      const row = RUN.results.filter((r) => r.action === 'board-sections').at(-1);
      ok(row && row.ok === true && row.boardId === 'otherBoard', 'an explicit --boardId is honored + echoed');
      ok(Array.isArray(row.items) && row.items.length === 0, 'a genuinely empty board is the only ok:true, items:[] case');
    } finally {
      global.fetch = realFetch;
    }
  }

  // ---- (1c) LIVE: a failed read (403) resolves a STRUCTURED ok:false, never a
  // false-empty { ok:true, items:[] } -------------------------------------------
  {
    const realFetch = global.fetch;
    global.fetch = () => Promise.resolve({ ok: false, status: 403, text: () => Promise.resolve(JSON.stringify({ message: 'forbidden' })) });
    try {
      await cmdBoardSections({});
      const row = RUN.results.filter((r) => r.action === 'board-sections').at(-1);
      ok(row && row.ok === false, 'a 403 read resolves ok:FALSE (never a false-empty items:[])');
      ok(row.error === 'needs_scope', 'a 403 maps to the needs_scope error (P9)');
      ok(Array.isArray(row.items) && row.items.length === 0, 'items stays an empty array on the degrade (safe for the picker to .map)');
    } finally {
      global.fetch = realFetch;
    }
  }

  // ---- (1d) LIVE: no token stored at all -> not_configured, distinct from the
  // 403/auth-failure needs_scope above (spec 17 review MINOR-2) - a never-
  // connected lane must read "not configured", not "reconnect" -------------
  {
    fs.rmSync(path.join(WS, '.env'), { force: true });
    await cmdBoardSections({ boardId: 'board1' });
    const row = RUN.results.filter((r) => r.action === 'board-sections').at(-1);
    ok(row && row.ok === false, 'a no-token read resolves ok:false');
    ok(row.error === 'not_configured', 'a never-connected lane reads not_configured (not needs_scope, which is reserved for a broken stored credential)');
    ok(Array.isArray(row.items) && row.items.length === 0, 'items stays an empty array on the degrade');
  }

  // ---- (2) LIB FACE: no credentials -> structured ok:false, never false-empty --
  {
    fs.rmSync(path.join(WS, '.env'), { force: true }); // no PINTEREST_ACCESS_TOKEN/BOARD_ID
    const res = await listPinterestBoardSections({ boardId: 'board1' });
    ok(res.ok === false, 'a credential-absent read resolves ok:FALSE (never { ok:true, items:[] })');
    ok(res.error === 'not_configured' || res.error === 'needs_scope', `the degrade carries a structured error (${res.error})`);
    ok(res.code === 'not_configured' || res.code === 'engine_failure', 'the degrade carries a stable ERROR_CODE for the MCP toolError path');
    ok(Array.isArray(res.items) && res.items.length === 0, 'items is an empty array on the degrade (so the Composer picker can .map safely)');
    ok(typeof res.message === 'string' && res.message.length > 0, 'the degrade carries an honest message (never empty)');
  }

  // ---- (2b) LIB FACE: no board id at all (and no PINTEREST_BOARD_ID) -----------
  {
    const res = await listPinterestBoardSections({});
    ok(res.ok === false, 'a board-id-absent read also resolves ok:FALSE');
    ok(Array.isArray(res.items) && res.items.length === 0, 'items stays [] (never a false-empty ok:true)');
  }

  console.log(`\n${pass} checks passed`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
