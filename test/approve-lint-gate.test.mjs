#!/usr/bin/env node
// test/approve-lint-gate.test.mjs - issue #40: brand-lint runs when a post is APPROVED,
// not only at publish. Owner decision 2026-10-28: refuse, with no override. Proves:
//   1. a caption with a brand-lint ERROR is refused at approval with lint_blocked and
//      findings [{platform, rule, match, hint}], and the post stays a draft;
//   2. force:true does NOT bypass it (force covers the pre-flight and media gates only);
//   3. per-lane EFFECTIVE text: an X override (xCaption) that fails while the shared
//      caption is clean is refused, naming x and not the clean lane;
//   4. warnings never block: they ride the success body as lintWarnings;
//   5. /api (HTTP 409) and MCP approve_post return the same code and findings (parity);
//   6. the reviewer link (ingestDecision + the review listener) refuses the same way,
//      as a 409 the page turns into its own sentence (the i18n string exists in both packs);
//   7. auto-approve (a machine caller) does not crash on the refusal: the post stays a
//      draft and an auto-approve-refused row with reason lint is logged;
//   8. captionLintFindings is the one verdict: the scheduler's lintBlock and setApproval
//      agree on the same post.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';

let pass = 0;
let failures = 0;
function ok(cond, msg) {
  if (cond) { pass += 1; console.log(`  ok - ${msg}`); } else { failures += 1; console.error(`  FAIL - ${msg}`); }
}

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-approve-lint-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data'), { recursive: true });

// 'https://' is a bare scheme: the broken-link rule (severity error). 'leverage' is
// ai-vocab (severity warn).
const DIRTY = 'big news today, read more https:// soon';
const WARN = 'we leverage our craft to make this clip';
const CLEAN = 'hello world, a plain and tidy caption';
const when = () => new Date(Date.now() + 86400_000).toISOString();

async function rpc(handleMcp, msg) {
  const req = Readable.from([Buffer.from(JSON.stringify(msg), 'utf8')]);
  req.method = 'POST';
  req.headers = { 'content-type': 'application/json' };
  const chunks = [];
  const res = new Writable({ write(chunk, _enc, cb) { chunks.push(Buffer.from(chunk)); cb(); } });
  res.writeHead = () => {};
  await handleMcp(req, res);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : null;
}
let nextId = 100;
async function mcpCall(handleMcp, name, args) {
  const reply = await rpc(handleMcp, { jsonrpc: '2.0', id: (nextId += 1), method: 'tools/call', params: { name, arguments: args } });
  const result = reply && reply.result;
  const payload = result && result.content && result.content[0] ? JSON.parse(result.content[0].text) : null;
  return { isError: Boolean(result && result.isError), payload };
}
function mockReq(body, method = 'POST') {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  req.method = method;
  req.headers = { 'content-type': 'application/json', host: '127.0.0.1' };
  req.socket = { remoteAddress: '127.0.0.1' };
  return req;
}
function mockRes() {
  return { statusCode: 0, body: null, headers: {}, setHeader() {}, writeHead(s) { this.statusCode = s; }, end(b) { this.body = b; } };
}

try {
  const { initMultiClient } = await import('../lib/multi-client.mjs');
  const { createClient, setActiveClient } = await import('../lib/clients.mjs');
  const w = await import('../lib/writes.mjs');
  const { loadManifest } = await import('../lib/plans.mjs');
  const { activeRoot } = await import('../lib/context.mjs');
  const { captionLintFindings } = await import('../lib/lint.mjs');
  initMultiClient();
  createClient({ id: 'acme', displayName: 'Acme Co', actor: 'owner' });
  setActiveClient({ id: 'acme', actor: 'owner' });
  await w.createCampaign({ id: 'c1', note: 'c1', timezone: 'UTC', actor: 'owner' });
  const mk = (id, extra) => w.createPost({ campaign: 'c1', post: { id, type: 'text', platforms: ['x', 'mastodon'], scheduledAt: when(), ...extra }, actor: 'agent:claude' });
  await mk('dirty', { caption: DIRTY });
  await mk('xover', { caption: CLEAN, xCaption: DIRTY });
  await mk('warn', { caption: WARN });
  await mk('clean', { caption: CLEAN });
  await mk('api', { caption: DIRTY });
  await mk('mcp', { caption: DIRTY });
  await mk('apiwarn', { caption: WARN });
  await mk('mcpwarn', { caption: WARN });
  await mk('rev', { caption: DIRTY });
  await mk('check', { caption: DIRTY });
  await mk('postedx', { caption: CLEAN, xCaption: DIRTY });

  const raw = (id) => {
    const entry = loadManifest().plans.find((p) => p.id === 'c1');
    return JSON.parse(fs.readFileSync(path.resolve(activeRoot(), entry.path), 'utf8')).posts.find((p) => p.id === id);
  };

  // ===== (1) refusal + findings, post untouched =====
  const r1 = await w.approvePost({ campaign: 'c1', postId: 'dirty', actor: 'owner' });
  ok(r1.ok !== true && r1.code === 'lint_blocked', `a brand-lint error refuses the approval with lint_blocked (got ${JSON.stringify(r1).slice(0, 300)})`);
  const f = (r1.findings || [])[0] || {};
  ok(Array.isArray(r1.findings) && r1.findings.length >= 2 && ['platform', 'rule', 'match', 'hint'].every((k) => typeof f[k] === 'string'),
    'findings carry {platform, rule, match, hint} for every failing lane');
  ok(r1.findings.every((x) => x.rule === 'broken-link') && new Set(r1.findings.map((x) => x.platform)).size === 2, 'findings name the rule on both targeted platforms');
  ok(/x \(broken-link\)/.test(r1.message) && /mastodon \(broken-link\)/.test(r1.message), 'the message names the platforms and the rule');
  ok(/edit/i.test(r1.message) && /remove/i.test(r1.message) && /approve again/i.test(r1.message), 'the message gives both fixes (edit the caption or remove the platform)');
  ok(!/—/.test(r1.message), 'the message has no em dash');
  ok((raw('dirty').approval || 'draft') === 'draft' && !raw('dirty').approvedContentHash, 'the refused post stays a draft with no approval stamp');

  // ===== (2) force does not bypass =====
  const r2 = await w.approvePost({ campaign: 'c1', postId: 'dirty', actor: 'owner', force: true });
  ok(r2.code === 'lint_blocked', 'force:true does NOT bypass the brand-lint gate');
  ok((raw('dirty').approval || 'draft') === 'draft', 'still a draft after a forced attempt');

  // ===== (3) effective per-lane text =====
  const r3 = await w.approvePost({ campaign: 'c1', postId: 'xover', actor: 'owner' });
  ok(r3.code === 'lint_blocked' && r3.findings.length && r3.findings.every((x) => x.platform === 'x'),
    `an X override that fails while the shared caption is clean is refused on x only (got ${JSON.stringify(r3.findings)})`);

  // ===== (4) warnings pass through =====
  const r4 = await w.approvePost({ campaign: 'c1', postId: 'warn', actor: 'owner' });
  ok(r4.ok === true && Array.isArray(r4.lintWarnings) && r4.lintWarnings.length >= 1 && r4.lintWarnings[0].rule === 'ai-vocab' && r4.lintWarnings[0].platform,
    `warnings never block and ride the success body as lintWarnings (got ${JSON.stringify(r4).slice(0, 300)})`);
  ok(raw('warn').approval === 'approved', 'the warned post is approved');
  const r5 = await w.approvePost({ campaign: 'c1', postId: 'clean', actor: 'owner' });
  ok(r5.ok === true && !('lintWarnings' in r5), 'a clean post carries no lintWarnings key');
  const rj = await w.rejectPost({ campaign: 'c1', postId: 'dirty', actor: 'owner', note: 'no' });
  ok(rj.ok === true, 'a reject is never lint-gated');

  // ===== (5) /api and MCP parity =====
  const { handleApi } = await import('../lib/api.mjs');
  const { handleMcp } = await import('../lib/mcp.mjs');
  await rpc(handleMcp, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  const apiRes = mockRes();
  await handleApi(mockReq({ actor: 'owner', force: true }), apiRes, new URL('http://127.0.0.1/api/plans/c1/posts/api/approve'));
  const apiBody = JSON.parse(apiRes.body);
  ok(apiRes.statusCode === 409 && apiBody.code === 'lint_blocked' && Array.isArray(apiBody.findings) && apiBody.findings.length,
    `/api approve: HTTP 409 lint_blocked with findings, force ignored (got ${apiRes.statusCode} ${apiRes.body && apiRes.body.slice(0, 200)})`);
  const m = await mcpCall(handleMcp, 'approve_post', { campaign: 'c1', postId: 'mcp', actor: 'owner', force: true });
  ok(m.isError && m.payload && m.payload.code === 'lint_blocked', `MCP approve_post: lint_blocked, force ignored (got ${JSON.stringify(m).slice(0, 200)})`);
  ok(JSON.stringify(m.payload.findings) === JSON.stringify(apiBody.findings), `MCP and /api return identical findings (parity) (mcp ${JSON.stringify(m.payload)} api ${JSON.stringify(apiBody)})`);
  const apiWarnRes = mockRes();
  await handleApi(mockReq({ actor: 'owner' }), apiWarnRes, new URL('http://127.0.0.1/api/plans/c1/posts/apiwarn/approve'));
  const apiWarn = JSON.parse(apiWarnRes.body);
  const mWarn = await mcpCall(handleMcp, 'approve_post', { campaign: 'c1', postId: 'mcpwarn', actor: 'owner' });
  ok(apiWarnRes.statusCode === 200 && apiWarn.ok === true && apiWarn.lintWarnings?.length >= 1, '/api approve: warnings ride the 200 body as lintWarnings');
  ok(!mWarn.isError && mWarn.payload.ok === true && JSON.stringify(mWarn.payload.lintWarnings) === JSON.stringify(apiWarn.lintWarnings), 'MCP approve_post returns the same lintWarnings as /api');

  // ===== (6) reviewer link =====
  const { createReviewer, verifyToken } = await import('../lib/reviewers.mjs');
  const { ingestDecision } = await import('../lib/review-ingest.mjs');
  const { postContentHash } = await import('../lib/plans.mjs');
  const mint = createReviewer({ clientId: 'acme', name: 'Martina', actor: 'owner' });
  const auth = verifyToken(mint.token);
  const rv = await ingestDecision({ clientId: 'acme', reviewer: auth.reviewer, body: { campaign: 'c1', postId: 'rev', verdict: 'approved', contentHash: postContentHash(raw('rev')) } });
  ok(rv.code === 'lint_blocked' && Array.isArray(rv.findings), `a reviewer approve is refused the same way (got ${JSON.stringify(rv).slice(0, 200)})`);
  ok((raw('rev').approval || 'draft') === 'draft', 'the reviewer-refused post stays pending');
  const { handleRequest } = await import('../lib/review-server.mjs');
  const revRes = mockRes();
  const revReq = mockReq({ campaign: 'c1', postId: 'rev', verdict: 'approved', contentHash: postContentHash(raw('rev')) });
  revReq.url = `/review/${mint.token}/decision`;
  await handleRequest(revReq, revRes);
  const revBody = JSON.parse(revRes.body);
  ok(revRes.statusCode === 409 && revBody.code === 'lint_blocked', `the review listener answers 409 lint_blocked (got ${revRes.statusCode} ${revRes.body && revRes.body.slice(0, 160)})`);
  // Critic E: an external reviewer gets the affected platforms only, never the owner's
  // rules.json text (rule ids, matched text, hints).
  ok(JSON.stringify(revBody.platforms) === JSON.stringify(['x', 'mastodon']), `the reviewer body names the affected platforms (got ${JSON.stringify(revBody.platforms)})`);
  ok(!('findings' in revBody) && !/broken-link|https:\/\/|malformed/.test(revRes.body), `the reviewer body carries no rule, match or hint text (got ${revRes.body})`);

  // ===== critic B: Check shows the lint error up front, approval stays the authority =====
  const pvCheck = await w.platformValidate({ campaign: 'c1', postId: 'check' });
  for (const lane of ['x', 'mastodon']) {
    const v = pvCheck.platforms[lane];
    const i = (v.problemCodes || []).findIndex((c) => c && c.code === 'validate.brandLint');
    ok(i !== -1 && v.problemCodes[i].params.rule === 'broken-link' && v.problemCodes[i].params.platform && /brand-lint/.test(v.problems[i]),
      `Check lists the brand-lint error on ${lane} with code validate.brandLint {rule, platform} (got ${JSON.stringify(v)})`);
  }
  const rCheck = await w.approvePost({ campaign: 'c1', postId: 'check', actor: 'owner', force: true });
  ok(rCheck.code === 'lint_blocked', `approval still refuses with lint_blocked, not not_ready, even with force (got ${rCheck.code})`);

  // ===== critic C: a lane that already published is not linted =====
  {
    const entry = loadManifest().plans.find((p) => p.id === 'c1');
    const planAbs = path.resolve(activeRoot(), entry.path);
    const plan = JSON.parse(fs.readFileSync(planAbs, 'utf8'));
    plan.posts.find((p) => p.id === 'postedx').xPostId = '1850000000000000000';
    fs.writeFileSync(planAbs, JSON.stringify(plan, null, 2));
  }
  const pvPosted = await w.platformValidate({ campaign: 'c1', postId: 'postedx' });
  ok(!(pvPosted.platforms.x.problemCodes || []).some((c) => c && c.code === 'validate.brandLint'), 'Check does not lint the X text once X has published');
  const rPosted = await w.approvePost({ campaign: 'c1', postId: 'postedx', actor: 'owner' });
  ok(rPosted.ok === true, `approval ignores a lint error on a lane that already published (got ${JSON.stringify(rPosted).slice(0, 200)})`);
  const { STRINGS } = await import('../lib/i18n.mjs');
  ok(/\{platforms\}/.test(STRINGS.en['review.error.lintBlocked'] || '') && /\{platforms\}/.test(STRINGS['de-CH']?.['review.error.lintBlocked'] || ''),
    'the reviewer page has a human sentence for lint_blocked in en and de-CH');
  const pageSrc = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'app', 'src', 'review', 'main.js'), 'utf8');
  ok(/'lint_blocked'/.test(pageSrc) && /review\.error\.lintBlocked/.test(pageSrc), 'the reviewer page maps lint_blocked to its own sentence, not the network error');
  ok(/body\.platforms/.test(pageSrc) && !/body\.findings/.test(pageSrc), 'the reviewer page builds its sentence from the platform list (critic E)');

  // ===== (7) auto-approve does not crash on the refusal =====
  const { getConfig, setConfig } = await import('../lib/config.mjs');
  const cfg = setConfig({ ifRev: getConfig().rev, actor: 'owner', set: { posting: { autoApprove: { enabled: true, platforms: ['x', 'mastodon'], requireLintClean: false } } } });
  ok(cfg.ok !== false && !cfg.code, `auto-approve policy enabled without its own lint check (got ${JSON.stringify(cfg).slice(0, 160)})`);
  const auto = await mk('auto', { caption: DIRTY });
  ok(auto.ok === true && auto.autoApproved === false, `createPost survives the refusal and reports autoApproved:false (got ${JSON.stringify(auto).slice(0, 200)})`);
  ok((raw('auto').approval || 'draft') === 'draft', 'the auto-approve candidate with a lint error stays a draft');
  const { getActivity } = await import('../lib/scheduler.mjs');
  ok(getActivity(50).some((a) => a.action === 'auto-approve-refused' && a.postId === 'auto' && a.reason === 'lint'), 'an auto-approve-refused row with reason lint is logged');
  const autoClean = await mk('autoclean', { caption: CLEAN });
  ok(autoClean.ok === true && autoClean.autoApproved === true, 'a clean caption still auto-approves');

  // ===== (8) one verdict for both gates =====
  const both = captionLintFindings({ caption: CLEAN, xCaption: DIRTY }, ['x', 'mastodon']);
  ok(both.errors.length >= 1 && both.errors.every((e) => e.platform === 'x'), 'captionLintFindings lints the effective per-lane text');
  const schedSrc = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'lib', 'scheduler.mjs'), 'utf8');
  ok(/captionLintFindings\(post, lanePlatforms\(lane, post\)\)/.test(schedSrc), 'the scheduler publish fence (lintBlock) uses the same captionLintFindings');
} catch (e) {
  failures += 1;
  console.error('FAIL -', e.stack || e.message);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${failures} failed.`);
process.exit(failures ? 1 : 0);
