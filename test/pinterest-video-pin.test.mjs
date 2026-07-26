#!/usr/bin/env node
// test/pinterest-video-pin.test.mjs - spec 17 (Pinterest native video pin +
// board-section targeting). The live engine's cmdPublishDue branches on
// post.type==='video': it registers a v5 media asset, uploads the bytes to the
// returned S3 url, polls until Pinterest reports the media processed, then
// creates the pin with media_source.source_type='video_id' (still requiring the
// public imageUrl as the REQUIRED cover_image_url) - never falling back to a
// plain image pin once a post is typed video. Mock-first (Pattern P9): the
// credential-free mock-driver mirrors the live engine's branch decision + the
// media_missing/unsupported/needs_scope fail-closed degrades, so a test asserts -
// with no network - exactly what the live engine would do. The LIVE section
// drives the real cmdPublishDue with a stubbed global.fetch (no network) to prove
// the actual four-step v5 sequence fires in order.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-pin-video-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans', 'pin-camp'), { recursive: true });

const { runMockCommand } = await import('../lib/drivers/mock-driver.mjs');
// Guarded entrypoints (no main() on import) - the live publish path (driven below
// with a stubbed global.fetch) is importable without running the CLI.
const { cmdPublishDue, RUN } = await import('../scripts/pinterest-social.mjs');

const planPath = path.join(WS, 'data', 'plans', 'pin-camp', 'post-plan.json');
const approved = { approval: 'approved', status: 'planned', executionMode: 'fully-scheduled', scheduledAt: '2020-01-01T00:00:00Z' };
function mkPlan(posts) { fs.writeFileSync(planPath, JSON.stringify({ campaign: 'pin-camp', posts }, null, 2)); }
async function publish(post) {
  mkPlan([post]);
  return runMockCommand({ platform: 'pinterest', command: 'publish-due', planPath, only: post.id });
}
const rowOf = (out) => out.results.find((r) => r.action === 'publish');

try {
  // ---- (1) MOCK: image pin (non-video) still publishes unchanged (regression) --
  {
    const post = { id: 'img', platforms: ['pinterest'], type: 'reel', title: 'Pic', imageUrl: 'https://cdn.example.com/pic.jpg', ...approved };
    const row = rowOf(await publish(post));
    ok(row && row.ok === true, 'a non-video pinterest post still publishes as an image pin');
    ok(!row.media, 'the image-pin row carries no media_source echo (untyped video)');
  }

  // ---- (2) MOCK: video pin with render + cover -> ok:true, media echoes video_id ----
  {
    const post = { id: 'vid', platforms: ['pinterest'], type: 'video', title: 'Clip', path: 'clip.mp4', imageUrl: 'https://cdn.example.com/cover.jpg', pinBoardSection: 'sec123', ...approved };
    const row = rowOf(await publish(post));
    ok(row && row.ok === true, 'a type=video post with a local render + cover publishes');
    ok(row.media && row.media.sourceType === 'video_id', 'the publish row echoes media_source.source_type=video_id');
    ok(row.boardSectionId === 'sec123', 'pinBoardSection rides the publish row as board_section_id');
  }

  // ---- (3) MOCK: video pin, no cover imageUrl -> structured ok:false (unsupported) ----
  {
    const post = { id: 'vidnocover', platforms: ['pinterest'], type: 'video', title: 'No cover', path: 'clip.mp4', ...approved };
    const row = rowOf(await publish(post));
    ok(row && row.ok === false && row.errorCode === 'unsupported', 'a video pin with no cover imageUrl is a structured ok:false skip (never a silent image fallback)');
    ok(JSON.parse(fs.readFileSync(planPath, 'utf8')).posts[0].status !== 'posted', 'the no-cover video pin never converges to posted');
  }

  // ---- (4) MOCK: video pin, no local render -> structured ok:false (media_missing) ----
  {
    const post = { id: 'vidnorender', platforms: ['pinterest'], type: 'video', title: 'No bytes', imageUrl: 'https://cdn.example.com/cover.jpg', ...approved };
    const row = rowOf(await publish(post));
    ok(row && row.ok === false && row.errorCode === 'media_missing', 'a type=video post with no local render is a structured ok:false skip');
    ok(!(row.media && row.media.sourceType === 'video_id'), 'the missing-render video pin NEVER falls back to a video-pin publish');
  }

  // ---- (5) MOCK: media:write-absent token -> needs_scope degrade (P9) ------------
  {
    process.env.PENDPOST_MOCK_UNGRANTED = 'pinterest';
    try {
      const post = { id: 'vidscope', platforms: ['pinterest'], type: 'video', title: 'Scoped', path: 'clip.mp4', imageUrl: 'https://cdn.example.com/cover.jpg', ...approved };
      const row = rowOf(await publish(post));
      ok(row && row.ok === false && row.error === 'needs_scope' && row.scope === 'media:write', 'a media:write-absent token degrades to the exact needs_scope shape - never a throw');
    } finally {
      delete process.env.PENDPOST_MOCK_UNGRANTED;
    }
  }

  // ---- (6) LIVE: the real register->upload->poll->create sequence, in order ------
  {
    fs.writeFileSync(path.join(WS, '.env'), [
      'PINTEREST_ACCESS_TOKEN=tok',
      `PINTEREST_TOKEN_EXPIRES_AT=${Date.now() + 3600_000}`,
      'PINTEREST_BOARD_ID=board1',
    ].join('\n'));
    fs.writeFileSync(path.join(WS, 'clip.mp4'), 'MP4BYTES');
    process.env.PINTEREST_MEDIA_POLL_TRIES = '3';
    process.env.PINTEREST_MEDIA_POLL_DELAY_MS = '0';
    const realFetch = global.fetch;
    const jsonRes = (status, body) => Promise.resolve({ ok: status >= 200 && status < 300, status, text: () => Promise.resolve(JSON.stringify(body)) });
    // Router keyed on the real v5 pathnames, so register (POST /v5/media) and poll
    // (GET /v5/media/<id>) can never be confused despite sharing a path prefix.
    function install({ pollStatuses = ['succeeded'], registerStatus = 200, uploadOk = true, pinStatus = 200 } = {}) {
      const calls = [];
      let pollIdx = 0;
      global.fetch = (url, init = {}) => {
        const u = String(url);
        const method = (init.method || 'GET').toUpperCase();
        calls.push({ u, method });
        if (u.includes('s3.example.com')) {
          return Promise.resolve({ ok: uploadOk, status: uploadOk ? 204 : 500, text: () => Promise.resolve('') });
        }
        const pathname = new URL(u).pathname;
        if (method === 'POST' && pathname === '/v5/media') {
          if (registerStatus !== 200) return jsonRes(registerStatus, { message: 'forbidden' });
          return jsonRes(200, { media_id: 'm1', upload_url: 'https://s3.example.com/upload', upload_parameters: { key: 'k1', policy: 'p1' } });
        }
        if (method === 'GET' && pathname.startsWith('/v5/media/')) {
          const status = pollStatuses[Math.min(pollIdx, pollStatuses.length - 1)];
          pollIdx += 1;
          return jsonRes(200, { status });
        }
        if (method === 'POST' && pathname === '/v5/pins') {
          if (pinStatus !== 200) return jsonRes(pinStatus, { message: 'error' });
          return jsonRes(200, { id: 'pin_live_1' });
        }
        return jsonRes(404, {});
      };
      return calls;
    }
    const diskPost = () => JSON.parse(fs.readFileSync(planPath, 'utf8')).posts[0];
    try {
      mkPlan([{ id: 'vlive', platforms: ['pinterest'], type: 'video', title: 'Live clip', path: path.join(WS, 'clip.mp4'), imageUrl: 'https://cdn.example.com/cover.jpg', pinBoardSection: 'secABC', ...approved }]);
      const calls = install();
      await cmdPublishDue({ plan: planPath, only: 'vlive' });
      const order = calls.map((c) => `${c.method} ${new URL(c.u).pathname}`);
      ok(order.indexOf('POST /v5/media') !== -1, 'step 1: POST /v5/media (register) fires');
      ok(calls.some((c) => c.method === 'POST' && c.u.includes('s3.example.com')), 'step 2: the multipart S3 upload fires');
      ok(order.indexOf('GET /v5/media/m1') !== -1, 'step 3: GET /v5/media/<id> (poll) fires');
      ok(order.indexOf('POST /v5/pins') !== -1, 'step 4: POST /v5/pins (create) fires');
      const registerIdx = order.indexOf('POST /v5/media');
      const pollIdx = order.indexOf('GET /v5/media/m1');
      const createIdx = order.indexOf('POST /v5/pins');
      const uploadIdx = calls.findIndex((c) => c.u.includes('s3.example.com'));
      ok(registerIdx < uploadIdx && uploadIdx < pollIdx && pollIdx < createIdx, 'the four steps fire IN ORDER: register -> upload -> poll -> create');
      const dp = diskPost();
      ok(dp.status === 'posted' && dp.pinId === 'pin_live_1', 'the video pin publishes and stamps pinId');
      ok(dp.attempts.at(-1).ok === true, 'the attempt log records an ok publish (NOT engine_failure)');
    } finally {
      global.fetch = realFetch;
    }

    // (6b) status:'failed' -> media_failed, never posted.
    {
      mkPlan([{ id: 'vfail', platforms: ['pinterest'], type: 'video', title: 'Fails', path: path.join(WS, 'clip.mp4'), imageUrl: 'https://cdn.example.com/cover.jpg', ...approved }]);
      install({ pollStatuses: ['failed'] });
      await cmdPublishDue({ plan: planPath, only: 'vfail' });
      const dp = diskPost();
      ok(dp.status !== 'posted', 'a media processing status:"failed" never converges to posted');
      const row = RUN.results.filter((r) => r.postId === 'vfail' && r.action === 'publish').at(-1);
      ok(row && row.ok === false && row.errorCode === 'media_failed', 'status:"failed" surfaces as a structured ok:false media_failed row');
      global.fetch = realFetch;
    }

    // (6c) a 403 on register -> needs_scope (media:write), never a throw.
    {
      mkPlan([{ id: 'vscope403', platforms: ['pinterest'], type: 'video', title: 'Scope', path: path.join(WS, 'clip.mp4'), imageUrl: 'https://cdn.example.com/cover.jpg', ...approved }]);
      install({ registerStatus: 403 });
      await cmdPublishDue({ plan: planPath, only: 'vscope403' });
      const dp = diskPost();
      ok(dp.status !== 'posted', 'a register 403 never converges to posted');
      const row = RUN.results.filter((r) => r.postId === 'vscope403' && r.action === 'publish').at(-1);
      ok(row && row.ok === false && row.error === 'needs_scope' && row.scope === 'media:write', 'a live 403 on register degrades to needs_scope(media:write), never a throw');
      global.fetch = realFetch;
    }

    // (6c2) a 403 on POLL (not register) -> engine_failure, NEVER needs_scope
    // (spec 17 review NIT-4): media:write already succeeded at register, so a
    // later 403 mid-poll is not a scope problem - only a REGISTER 403 is.
    {
      mkPlan([{ id: 'vpoll403', platforms: ['pinterest'], type: 'video', title: 'Poll403', path: path.join(WS, 'clip.mp4'), imageUrl: 'https://cdn.example.com/cover.jpg', ...approved }]);
      global.fetch = (url, init = {}) => {
        const u = String(url);
        const method = (init.method || 'GET').toUpperCase();
        if (u.includes('s3.example.com')) return Promise.resolve({ ok: true, status: 204, text: () => Promise.resolve('') });
        const pathname = new URL(u).pathname;
        if (method === 'POST' && pathname === '/v5/media') {
          return jsonRes(200, { media_id: 'm2', upload_url: 'https://s3.example.com/upload', upload_parameters: { key: 'k1', policy: 'p1' } });
        }
        if (method === 'GET' && pathname.startsWith('/v5/media/')) return jsonRes(403, { message: 'forbidden' });
        return jsonRes(404, {});
      };
      await cmdPublishDue({ plan: planPath, only: 'vpoll403' });
      const dp = diskPost();
      ok(dp.status !== 'posted', 'a poll-step 403 never converges to posted');
      const row = RUN.results.filter((r) => r.postId === 'vpoll403' && r.action === 'publish').at(-1);
      ok(row && row.ok === false && row.errorCode === 'engine_failure', 'a poll-step 403 classifies as engine_failure (NOT needs_scope - register already proved media:write)');
      ok(row.error !== 'needs_scope', 'a poll-step 403 is never misread as a scope problem');
      global.fetch = realFetch;
    }

    // (6d) an image pin ALSO carries board_section_id when pinBoardSection is set
    // (unchanged image-pin path + the new board-section passthrough, spec 17 §4).
    {
      mkPlan([{ id: 'imglive', platforms: ['pinterest'], type: 'reel', title: 'Img live', imageUrl: 'https://cdn.example.com/pic.jpg', pinBoardSection: 'secXYZ', ...approved }]);
      let pinBody = null;
      global.fetch = (url, init = {}) => {
        const u = String(url);
        const pathname = new URL(u).pathname;
        if ((init.method || 'GET').toUpperCase() === 'POST' && pathname === '/v5/pins') {
          pinBody = JSON.parse(init.body);
          return jsonRes(200, { id: 'pin_img_1' });
        }
        return jsonRes(404, {});
      };
      await cmdPublishDue({ plan: planPath, only: 'imglive' });
      ok(pinBody && pinBody.media_source.source_type === 'image_url', 'the image-pin path is unchanged (source_type=image_url)');
      ok(pinBody && pinBody.board_section_id === 'secXYZ', 'board_section_id rides the image-pin body too');
      global.fetch = realFetch;
    }
    delete process.env.PINTEREST_MEDIA_POLL_TRIES;
    delete process.env.PINTEREST_MEDIA_POLL_DELAY_MS;
  }

  console.log(`\n${pass} checks passed`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
