#!/usr/bin/env node
// test/pinterest-boards.test.mjs - spec 29 (Pinterest board + board-section CRUD,
// Pattern P3 engine verbs + P4 read/write pair + P9).
//
//   1. LIVE (stubbed global.fetch, no network): board-list normalizes a paginated
//      GET /v5/boards response into {id,name,privacy,pinCount} + echoes `current`;
//      board-create/board-update/board-section-create/board-section-update hit the
//      real v5 endpoints and classify errors (403->needs_scope, other 4xx->
//      invalid_input, else engine_failure).
//   2. MOCK-MODE (subprocess, PENDPOST_MODE=mock): board-list is mockable (UNLIKE
//      board-sections) and returns the canned boards; the four writes fabricate a
//      result and degrade to needs_scope under PENDPOST_MOCK_UNGRANTED=pinterest.
//   3. LIB FACE (lib/writes.mjs, mock-mode subprocess): listPinterestBoards /
//      createPinterestBoard / updatePinterestBoard / createPinterestBoardSection /
//      updatePinterestBoardSection normalize the envelope + classify not_configured/
//      invalid_input/engine_failure the same way the sibling Pinterest/YouTube reads do.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const engine = path.join(REPO, 'scripts', 'pinterest-social.mjs');
const pinSrc = fs.readFileSync(engine, 'utf8');

let pass = 0;
let failures = 0;
function ok(cond, msg) {
  if (cond) { pass += 1; console.log(`  ok - ${msg}`); } else { failures += 1; console.error(`  FAIL - ${msg}`); }
}

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-pin-boards-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));

function runPin(args, extraEnv = {}) {
  const out = execFileSync(process.execPath, [engine, ...args], {
    cwd: REPO,
    env: { ...process.env, PENDPOST_ROOT: WS, PENDPOST_MODE: 'mock', ...extraEnv },
    encoding: 'utf8',
  });
  return JSON.parse(out.trim().split('\n').pop());
}
const row = (envelope, action) => (envelope.results || []).find((r) => r.action === action);

// Guarded entrypoint (no main() on import) - the cmd* functions + RUN are
// importable without running the CLI (mirrors pinterest-board-sections.test.mjs).
const {
  cmdBoardList, cmdBoardCreate, cmdBoardUpdate, cmdBoardSectionCreate, cmdBoardSectionUpdate, RUN,
} = await import('../scripts/pinterest-social.mjs');

try {
  // ===== (0) source-level wiring =====
  ok(pinSrc.includes('boards:write'), 'SCOPES carries the NEW boards:write scope (spec 29, mirrors media:write)');
  ok(/'board-list':\s*cmdBoardList/.test(pinSrc) && /'board-create':\s*cmdBoardCreate/.test(pinSrc)
    && /'board-update':\s*cmdBoardUpdate/.test(pinSrc) && /'board-section-create':\s*cmdBoardSectionCreate/.test(pinSrc)
    && /'board-section-update':\s*cmdBoardSectionUpdate/.test(pinSrc),
  'all 5 verbs are wired into the COMMANDS map');
  const guardLine = pinSrc.match(/\[['"]validate['"][^\]]*\]\.includes\(commandName\)/);
  ok(guardLine && !/board-list|board-create|board-update|board-section-create|board-section-update/.test(guardLine[0]),
    'none of the 5 new verbs are in the plan-required guard (they take --name/--id/--board/--section, not --plan)');

  // ===== (1) LIVE: board-list normalizes a paginated boards response, echoes current =====
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
      assert.strictEqual(u.pathname, '/v5/boards', 'requests the real v5 boards path');
      calls += 1;
      if (calls === 1) return jsonRes(200, { items: [{ id: 'b1', name: 'Recipes', privacy: 'PUBLIC', pin_count: 12 }], bookmark: 'next-page' });
      return jsonRes(200, { items: [{ id: 'b2', name: 'DIY', privacy: 'SECRET', pin_count: 3 }], bookmark: null });
    };
    try {
      await cmdBoardList();
      const r = RUN.results.filter((x) => x.action === 'board-list').at(-1);
      ok(r && r.ok === true, 'a successful board-list read resolves ok:true');
      ok(r.current === 'board1', 'current echoes PINTEREST_BOARD_ID');
      ok(Array.isArray(r.boards) && r.boards.length === 2, 'boards normalizes across BOTH pages (bookmark pagination)');
      ok(r.boards[0].id === 'b1' && r.boards[0].name === 'Recipes' && r.boards[0].privacy === 'PUBLIC' && r.boards[0].pinCount === 12, 'a board normalizes to { id, name, privacy, pinCount }');
      ok(calls === 2, 'the bookmark cursor drives a second page fetch');
    } finally {
      global.fetch = realFetch;
    }
  }

  // ===== (1b) LIVE: a failed board-list read (403) resolves a STRUCTURED
  // ok:false, never a false-empty { ok:true, boards:[] } =====
  {
    const realFetch = global.fetch;
    global.fetch = () => Promise.resolve({ ok: false, status: 403, text: () => Promise.resolve(JSON.stringify({ message: 'forbidden' })) });
    try {
      await cmdBoardList();
      const r = RUN.results.filter((x) => x.action === 'board-list').at(-1);
      ok(r && r.ok === false, 'a 403 board-list read resolves ok:FALSE (never a false-empty boards:[])');
      ok(r.error === 'needs_scope', 'a 403 maps to needs_scope (P9)');
      ok(Array.isArray(r.boards) && r.boards.length === 0 && r.current === null, 'boards/current stay empty/null on the degrade');
    } finally {
      global.fetch = realFetch;
    }
  }

  // ===== (2) LIVE: board-create returns an id + echoes the name; a name clash
  // (409) maps to invalid_input =====
  {
    const realFetch = global.fetch;
    const jsonRes = (status, body) => Promise.resolve({ ok: status >= 200 && status < 300, status, text: () => Promise.resolve(JSON.stringify(body)) });
    global.fetch = (url, opts) => {
      const u = new URL(String(url));
      assert.strictEqual(u.pathname, '/v5/boards', 'board-create posts to the real v5 boards path');
      assert.strictEqual(opts.method, 'POST', 'board-create uses POST');
      const body = JSON.parse(opts.body);
      assert.strictEqual(body.name, 'Launch Boards', 'the request body carries the requested name');
      assert.strictEqual(body.privacy, 'SECRET', 'the request body carries the requested privacy');
      return jsonRes(201, { id: 'newboard1', name: body.name });
    };
    try {
      await cmdBoardCreate({ name: 'Launch Boards', privacy: 'secret' });
      const r = RUN.results.filter((x) => x.action === 'board-create').at(-1);
      ok(r && r.ok === true && r.id === 'newboard1', 'board-create resolves { ok:true, id }');
      ok(r.name === 'Launch Boards', 'board-create echoes the requested name');
    } finally {
      global.fetch = realFetch;
    }
  }
  {
    const realFetch = global.fetch;
    global.fetch = () => Promise.resolve({ ok: false, status: 409, text: () => Promise.resolve(JSON.stringify({ message: 'a board with this name already exists' })) });
    try {
      await cmdBoardCreate({ name: 'Dup' });
      const r = RUN.results.filter((x) => x.action === 'board-create').at(-1);
      ok(r && r.ok === false && r.error === 'invalid_input', 'a name-clash 4xx maps to invalid_input with detail');
      ok(typeof r.message === 'string' && r.message.includes('already exists'), 'the detail is carried through');
    } finally {
      global.fetch = realFetch;
    }
  }
  // Spec 29 review (NIT-6): a 401 (a token revoked mid-flight) is ALSO an auth
  // problem, not a caller-fault 4xx - classifyBoardWriteError must bucket it with
  // 403 under needs_scope, never invalid_input.
  {
    const realFetch = global.fetch;
    global.fetch = () => Promise.resolve({ ok: false, status: 401, text: () => Promise.resolve(JSON.stringify({ message: 'unauthorized' })) });
    try {
      await cmdBoardCreate({ name: 'X' });
      const r = RUN.results.filter((x) => x.action === 'board-create').at(-1);
      ok(r && r.ok === false && r.error === 'needs_scope' && r.scope === 'boards:write', 'a 401 (revoked token) maps to needs_scope:boards:write, not invalid_input');
    } finally {
      global.fetch = realFetch;
    }
  }
  {
    await cmdBoardCreate({});
    const r = RUN.results.filter((x) => x.action === 'board-create').at(-1);
    ok(r && r.ok === false && r.error === 'invalid_input', 'board-create with no --name is a pre-flight invalid_input (no network call)');
  }

  // ===== (3) LIVE: board-update PATCHes only the provided fields, IDEMPOTENT shape =====
  {
    const realFetch = global.fetch;
    const jsonRes = (status, body) => Promise.resolve({ ok: status >= 200 && status < 300, status, text: () => Promise.resolve(JSON.stringify(body)) });
    global.fetch = (url, opts) => {
      const u = new URL(String(url));
      assert.strictEqual(u.pathname, '/v5/boards/board1', 'board-update PATCHes the specific board path');
      assert.strictEqual(opts.method, 'PATCH', 'board-update uses PATCH');
      const body = JSON.parse(opts.body);
      assert.deepStrictEqual(body, { name: 'Renamed' }, 'only the provided field is sent');
      return jsonRes(200, { id: 'board1', name: 'Renamed' });
    };
    try {
      await cmdBoardUpdate({ id: 'board1', name: 'Renamed' });
      const r = RUN.results.filter((x) => x.action === 'board-update').at(-1);
      ok(r && r.ok === true && r.id === 'board1' && r.name === 'Renamed', 'board-update resolves { ok:true, id, name }');
    } finally {
      global.fetch = realFetch;
    }
  }
  {
    await cmdBoardUpdate({ id: 'board1' });
    const r = RUN.results.filter((x) => x.action === 'board-update').at(-1);
    ok(r && r.ok === false && r.error === 'invalid_input', 'board-update with no fields is a pre-flight invalid_input (no network call)');
  }

  // ===== (4) LIVE: board-section-create nests under the board; needs_scope on 403 =====
  {
    const realFetch = global.fetch;
    const jsonRes = (status, body) => Promise.resolve({ ok: status >= 200 && status < 300, status, text: () => Promise.resolve(JSON.stringify(body)) });
    global.fetch = (url, opts) => {
      const u = new URL(String(url));
      assert.strictEqual(u.pathname, '/v5/boards/board1/sections', 'board-section-create posts under the parent board');
      assert.strictEqual(opts.method, 'POST', 'board-section-create uses POST');
      return jsonRes(201, { id: 'sect1', name: 'Winter' });
    };
    try {
      await cmdBoardSectionCreate({ board: 'board1', name: 'Winter' });
      const r = RUN.results.filter((x) => x.action === 'board-section-create').at(-1);
      ok(r && r.ok === true && r.boardId === 'board1' && r.id === 'sect1' && r.name === 'Winter', 'board-section-create nests the new section under boardId');
    } finally {
      global.fetch = realFetch;
    }
  }
  {
    const realFetch = global.fetch;
    global.fetch = () => Promise.resolve({ ok: false, status: 403, text: () => Promise.resolve(JSON.stringify({ message: 'forbidden' })) });
    try {
      await cmdBoardSectionCreate({ board: 'board1', name: 'Winter' });
      const r = RUN.results.filter((x) => x.action === 'board-section-create').at(-1);
      ok(r && r.ok === false && r.error === 'needs_scope' && r.scope === 'boards:write', 'a 403 on section-create maps to needs_scope:boards:write');
    } finally {
      global.fetch = realFetch;
    }
  }

  // ===== (5) LIVE: board-section-update renames the section =====
  {
    const realFetch = global.fetch;
    const jsonRes = (status, body) => Promise.resolve({ ok: status >= 200 && status < 300, status, text: () => Promise.resolve(JSON.stringify(body)) });
    global.fetch = (url, opts) => {
      const u = new URL(String(url));
      assert.strictEqual(u.pathname, '/v5/boards/board1/sections/sect1', 'board-section-update PATCHes the specific section path');
      assert.strictEqual(opts.method, 'PATCH', 'board-section-update uses PATCH');
      return jsonRes(200, { id: 'sect1', name: 'Spring' });
    };
    try {
      await cmdBoardSectionUpdate({ board: 'board1', section: 'sect1', name: 'Spring' });
      const r = RUN.results.filter((x) => x.action === 'board-section-update').at(-1);
      ok(r && r.ok === true && r.boardId === 'board1' && r.id === 'sect1' && r.name === 'Spring', 'board-section-update renames + echoes the section');
    } finally {
      global.fetch = realFetch;
    }
  }

  // ===== (6) MOCK-MODE (subprocess): board-list returns the canned boards + current
  //        reads the workspace's OWN PINTEREST_BOARD_ID (spec 29 review MINOR-4) =====
  const listM = runPin(['board-list', '--json']);
  const listRow = row(listM, 'board-list');
  ok(listM.ok === true && listRow?.ok === true, 'mock board-list envelope + row resolve ok:true');
  ok(Array.isArray(listRow.boards) && listRow.boards.length > 0, 'mock board-list returns a non-empty boards[]');
  ok(listRow.boards.every((b) => typeof b.id === 'string' && typeof b.name === 'string' && 'privacy' in b && 'pinCount' in b), 'every mock board carries { id, name, privacy, pinCount }');
  // WS/.env carries PINTEREST_BOARD_ID=board1 (written in test 1, still on disk) -
  // mock board-list must echo it back, NOT a hardcoded first-board id, so a
  // "Set as destination" write (config_set -> .env) is reflected in mock/demo mode.
  ok(listRow.current === 'board1', 'mock board-list current reads the workspace PINTEREST_BOARD_ID, not a hardcoded first board');

  {
    // ... falling back to the first canned board only when nothing is configured.
    const envFile = path.join(WS, '.env');
    const original = fs.readFileSync(envFile, 'utf8');
    fs.writeFileSync(envFile, original.replace(/^PINTEREST_BOARD_ID=.*$/m, ''));
    try {
      const listFallback = row(runPin(['board-list', '--json']), 'board-list');
      ok(listFallback.current === listRow.boards[0].id, 'mock board-list falls back to the first canned board when PINTEREST_BOARD_ID is unset');
    } finally {
      fs.writeFileSync(envFile, original);
    }
  }

  // ===== (7) MOCK-MODE: board-create / board-section-create fabricate ids =====
  const createdM = runPin(['board-create', '--name', 'Launch Series', '--json']);
  const createdRow = row(createdM, 'board-create');
  ok(createdRow?.ok === true && typeof createdRow.id === 'string' && createdRow.id, 'mock board-create returns { ok:true, id }');
  ok(createdRow.name === 'Launch Series', 'mock board-create echoes back the requested name');

  const sectionM = runPin(['board-section-create', '--board', listRow.boards[0].id, '--name', 'Q3', '--json']);
  const sectionRow = row(sectionM, 'board-section-create');
  ok(sectionRow?.ok === true && sectionRow.boardId === listRow.boards[0].id && typeof sectionRow.id === 'string', 'mock board-section-create nests under the requested board');

  const updatedM = runPin(['board-update', '--id', listRow.boards[0].id, '--name', 'Renamed A', '--json']);
  const updatedRow = row(updatedM, 'board-update');
  ok(updatedRow?.ok === true && updatedRow.id === listRow.boards[0].id && updatedRow.name === 'Renamed A', 'mock board-update renames + echoes');

  const sectionUpdatedM = runPin(['board-section-update', '--board', listRow.boards[0].id, '--section', sectionRow.id, '--name', 'Q4', '--json']);
  const sectionUpdatedRow = row(sectionUpdatedM, 'board-section-update');
  ok(sectionUpdatedRow?.ok === true && sectionUpdatedRow.id === sectionRow.id && sectionUpdatedRow.name === 'Q4', 'mock board-section-update renames + echoes');

  // ===== (8) P9: an ungranted token degrades every WRITE verb to needs_scope
  // (top envelope stays ok:true); board-list is UNAFFECTED (boards:read, not write) =====
  const ungrantedEnv = { PENDPOST_MOCK_UNGRANTED: 'pinterest' };
  const listU = runPin(['board-list', '--json'], ungrantedEnv);
  ok(row(listU, 'board-list')?.ok === true, 'board-list is NOT gated by boards:write (the read still works)');

  const createU = runPin(['board-create', '--name', 'X', '--json'], ungrantedEnv);
  ok(createU.ok === true, 'ungranted board-create: top envelope stays ok:true');
  ok(row(createU, 'board-create')?.ok === false && row(createU, 'board-create').error === 'needs_scope' && row(createU, 'board-create').scope === 'boards:write', 'ungranted board-create ROW degrades to needs_scope:boards:write (P9)');

  const updateU = runPin(['board-update', '--id', 'b1', '--name', 'X', '--json'], ungrantedEnv);
  ok(row(updateU, 'board-update')?.ok === false && row(updateU, 'board-update').error === 'needs_scope', 'ungranted board-update ROW degrades to needs_scope (P9)');

  const sectionCreateU = runPin(['board-section-create', '--board', 'b1', '--name', 'X', '--json'], ungrantedEnv);
  ok(row(sectionCreateU, 'board-section-create')?.ok === false && row(sectionCreateU, 'board-section-create').error === 'needs_scope', 'ungranted board-section-create ROW degrades to needs_scope (P9)');

  const sectionUpdateU = runPin(['board-section-update', '--board', 'b1', '--section', 's1', '--name', 'X', '--json'], ungrantedEnv);
  ok(row(sectionUpdateU, 'board-section-update')?.ok === false && row(sectionUpdateU, 'board-section-update').error === 'needs_scope', 'ungranted board-section-update ROW degrades to needs_scope (P9)');

  // ===== (9) LIB FACE (lib/writes.mjs, mock-mode subprocess) =====
  {
    const {
      listPinterestBoards, createPinterestBoard, updatePinterestBoard, createPinterestBoardSection, updatePinterestBoardSection,
    } = await import('../lib/writes.mjs');

    const libList = await listPinterestBoards({});
    ok(libList.ok === true && Array.isArray(libList.boards) && libList.boards.length > 0, 'lib listPinterestBoards resolves ok:true with a non-empty boards[]');
    ok(typeof libList.current === 'string', 'lib listPinterestBoards echoes current');

    const libCreated = await createPinterestBoard({ name: 'Lib Board', actor: 'agent:test' });
    ok(libCreated.ok === true && typeof libCreated.id === 'string', 'lib createPinterestBoard resolves { ok:true, id }');

    const libUpdated = await updatePinterestBoard({ boardId: libCreated.id, name: 'Lib Board Renamed', actor: 'agent:test' });
    ok(libUpdated.ok === true && libUpdated.id === libCreated.id, 'lib updatePinterestBoard resolves { ok:true, id }');

    const libSection = await createPinterestBoardSection({ boardId: libCreated.id, name: 'Lib Section', actor: 'agent:test' });
    ok(libSection.ok === true && libSection.boardId === libCreated.id && typeof libSection.id === 'string', 'lib createPinterestBoardSection nests under boardId');

    const libSectionUpdated = await updatePinterestBoardSection({ boardId: libCreated.id, sectionId: libSection.id, name: 'Lib Section 2', actor: 'agent:test' });
    ok(libSectionUpdated.ok === true && libSectionUpdated.id === libSection.id, 'lib updatePinterestBoardSection resolves { ok:true, id }');

    // requireActor guard - mirrors every other writes.mjs fn (no engine call at
    // all; errorBody's return carries no `ok` field, same as editPublished's/
    // profileUpdate's requireActor test assertions - `ok !== true`, not `=== false`).
    const noActor = await createPinterestBoard({ name: 'No Actor' });
    ok(noActor.ok !== true && noActor.code === 'invalid_input', 'lib createPinterestBoard rejects a missing actor before spawning the engine');

    // needs_scope maps to the stable not_configured ERROR_CODE + carries the finer error.
    process.env.PENDPOST_MOCK_UNGRANTED = 'pinterest';
    try {
      const libCreateU = await createPinterestBoard({ name: 'Blocked', actor: 'agent:test' });
      ok(libCreateU.ok !== true && libCreateU.code === 'not_configured' && libCreateU.needsScope === true && libCreateU.scope === 'boards:write', 'lib createPinterestBoard maps needs_scope -> not_configured + needsScope + scope');
    } finally {
      delete process.env.PENDPOST_MOCK_UNGRANTED;
    }
  }

  // ===== (10) LIB FACE: a row-LESS crash envelope resolves ok:false engine_failure
  // (never a false-empty ok:true boards:[]), mirrors youtube-playlists.test.mjs (6) =====
  {
    const fakeEngine = path.join(WS, 'crash-engine.mjs');
    fs.writeFileSync(fakeEngine, "process.stdout.write(JSON.stringify({ ok:false, error:'token refresh failed: invalid_grant', results: [] }) + '\\n');\n");
    process.env.PENDPOST_PINTEREST_ENGINE = fakeEngine;
    try {
      const { listPinterestBoards } = await import('../lib/writes.mjs');
      const crashed = await listPinterestBoards({});
      ok(crashed.ok === false && crashed.code === 'engine_failure', 'a row-less crash envelope resolves ok:false engine_failure (not a false-empty ok:true)');
    } finally {
      delete process.env.PENDPOST_PINTEREST_ENGINE;
    }
  }

  assert.ok(failures === 0, `${failures} assertion(s) failed`);
  console.log(`[pinterest-boards] OK - board-list/create/update + section-create/update verbs, LIVE endpoint/method/error-classification, mock-mode fabrication, P9 needs_scope degrade, lib-face normalization (${pass} assertions).`);
} catch (err) {
  console.error(`[pinterest-boards] FAIL - ${err.message}`);
  process.exitCode = 1;
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
