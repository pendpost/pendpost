// approval-blockers.test.js - the pure rules behind the Freigaben error UX (2026-11-06): what a
// bulk approve sends and leaves out, the short cause words, the cause grouping of the run summary
// (never a post id) and the copy-paste agent brief.
import { describe, it, expect } from 'vitest';
import { makeT } from '../i18n.js';
import {
  hardBlockersOf, approveSplit, skipCauses, skipLine, shortCause, fullCause, offPlatformOf,
  agentCanTry, fixBrief, SHORT_MAX,
} from '../approvalBlockers.js';

const en = makeT('en');
const de = makeT('de-CH');

const fbOff = { platform: 'facebook', code: 'validate.fbDisabled', params: { platform: 'facebook' }, fix: 'edit', text: 'facebook publishing is disabled by platform policy (instagram unaffected) - enable via config.platforms.facebook=true on a healthy Page' };
const xLong = { platform: 'x', code: 'validate.xTooLong', params: {}, fix: 'edit', text: 'text is 412 chars - X caps at 280' };
const tgSetup = { platform: 'telegram', code: 'validate.telegramChannelMissing', params: {}, fix: 'setup', text: 'no channel' };

const verdict = {
  ok: true,
  platforms: {
    instagram: { ready: true, problems: [], warnings: ['a warning'] },
    facebook: { ready: false, needsSetup: false, problems: [fbOff.text], problemCodes: [{ code: fbOff.code, params: fbOff.params, fix: 'edit' }] },
    linkedin: { ready: false, needsSetup: true, problems: ['not connected'], problemCodes: [{ code: 'validate.laneNotConnected', params: {}, fix: 'setup' }] },
  },
};

describe('hardBlockersOf', () => {
  it('takes every problem on a set-up lane, never a warning and never a lane that needs setup', () => {
    expect(hardBlockersOf(verdict)).toEqual([fbOff]);
  });
  it('a missing or failed verdict has no blockers (fails open)', () => {
    expect(hardBlockersOf(null)).toEqual([]);
    expect(hardBlockersOf({ ok: false })).toEqual([]);
  });
});

describe('approveSplit: bulk approve leaves out hard-blocked and offline posts before the press', () => {
  const a = { id: 'a' };
  const b = { id: 'b' };
  const c = { id: 'c' };
  const d = { id: 'd' };
  const blockersOf = (p) => (p.id === 'b' ? [fbOff] : p.id === 'd' ? [xLong] : []);
  const offlineLanesOf = (p) => (p.id === 'c' || p.id === 'd' ? ['linkedin'] : []);
  it('sends only the posts with no blocker and every lane connected', () => {
    const split = approveSplit([a, b, c, d], { blockersOf, offlineLanesOf });
    expect(split.send.map((p) => p.id)).toEqual(['a']);
    expect(split.blocked.map((x) => x.post.id)).toEqual(['b', 'd']);
    expect(split.offline.map((x) => x.post.id)).toEqual(['c']);
  });
});

describe('skipCauses / skipLine: grouped by cause, never a post id', () => {
  const blocked = [1, 2, 3, 4].map((i) => ({ post: { id: `r21${i}-fb-launch` }, blockers: [fbOff] }));
  const offline = Array.from({ length: 15 }, (_, i) => ({ post: { id: `till-${i}` }, lanes: ['linkedin'] }));
  it('one chip per cause, most posts first, with the short words', () => {
    const causes = skipCauses({ blocked, offline }, de);
    expect(causes.map((c) => [c.kind, c.platform, c.count])).toEqual([['offline', 'linkedin', 15], ['off', 'facebook', 4]]);
    expect(causes[1].label).toBe('Facebook ist in diesem Projekt aus');
    expect(causes[0].label).toBe('LinkedIn nicht verbunden');
    expect(JSON.stringify(causes)).not.toMatch(/r21\d-fb-launch|till-\d/);
  });
  it('a server refusal groups by its plain reason', () => {
    const causes = skipCauses({ failed: [{ post: { id: 'p1' }, text: 'Speicher voll' }, { post: { id: 'p2' }, text: 'Speicher voll' }, { post: { id: 'p3' }, text: null }] }, en);
    expect(causes.map((c) => [c.kind, c.label, c.count])).toEqual([['failed', 'Speicher voll', 2], ['failed', 'Approval failed', 1]]);
  });
  it('the line before the press names the causes, not the posts', () => {
    const line = skipLine(skipCauses({ blocked, offline }, de), 19, de);
    expect(line).toBe('19 werden nicht freigegeben: LinkedIn nicht verbunden, Facebook ist in diesem Projekt aus');
    expect(skipLine([], 0, de)).toBeNull();
  });
});

describe('shortCause: at most 60 characters, the full sentence stays for the tooltip', () => {
  it('uses the short key when there is one', () => {
    expect(shortCause(de, fbOff)).toBe('Facebook ist in diesem Projekt aus');
    expect(shortCause(en, xLong)).toBe('Text too long for X');
    expect(shortCause(de, { platform: 'instagram', code: 'validate.captionTooLong', params: {} })).toBe('Text zu lang für Instagram');
    expect(shortCause(de, { platform: 'instagram', code: 'validate.mediaMissing', params: {} })).toBe('Mediendatei fehlt');
    expect(shortCause(de, { platform: 'x', code: 'validate.brandLint', params: { rule: 'banned-phrase' } })).toBe('Verstösst gegen eine Markenregel');
    expect(shortCause(de, { platform: 'linkedin', code: 'validate.laneNotConnected', params: {} })).toBe('LinkedIn nicht verbunden');
  });
  it('falls back to the full sentence, cut at 60 characters', () => {
    const b = { platform: 'mastodon', code: null, params: {}, text: 'note text is 501 chars - Mastodon caps at 500 (set a shorter mastodonCaption)' };
    const s = shortCause(en, b);
    expect(s.length).toBeLessThanOrEqual(SHORT_MAX);
    expect(s.endsWith('…')).toBe(true);
    expect(fullCause(en, b)).toBe(b.text);
  });
  it('the full sentence is the localized one', () => {
    expect(fullCause(de, fbOff)).toMatch(/^Das Veröffentlichen auf Facebook ist in diesem Projekt ausgeschaltet/);
  });
});

describe('offPlatformOf / agentCanTry', () => {
  it('names the turned-off platform', () => {
    expect(offPlatformOf(fbOff)).toBe('facebook');
    expect(offPlatformOf(xLong)).toBeNull();
  });
  it('the agent may try anything but a connection-only post', () => {
    const igFb = { platforms: ['instagram', 'facebook'] };
    expect(agentCanTry([fbOff], igFb)).toBe(true);
    expect(agentCanTry([tgSetup], igFb)).toBe(false);
    expect(agentCanTry([tgSetup, xLong], igFb)).toBe(true);
    expect(agentCanTry([], igFb)).toBe(false);
  });
  it('a turned-off platform that is the post\'s ONLY platform is not the agent\'s (it may not empty platforms)', () => {
    expect(agentCanTry([fbOff], { platforms: ['facebook'] })).toBe(false);
    expect(agentCanTry([fbOff, xLong], { platforms: ['facebook', 'x'] })).toBe(true);
    // Without the post, a turned-off platform is never assumed fixable.
    expect(agentCanTry([fbOff])).toBe(false);
  });
});

describe('fixBrief: a self-contained prompt for any agent session', () => {
  const post = { id: 'r211-fb-launch', campaign: 'launch-2026-11', clientId: 'acme', platforms: ['instagram', 'facebook'] };
  const brief = fixBrief({ post, blockers: [fbOff, xLong, tgSetup], offlineLanes: ['linkedin'] });
  it('carries the project, campaign, post, platforms and each problem with its code', () => {
    expect(brief).toMatch(/project \(clientId\): "acme"/);
    expect(brief).toMatch(/campaign: "launch-2026-11"/);
    expect(brief).toMatch(/postId: "r211-fb-launch"/);
    expect(brief).toMatch(/platforms: instagram, facebook/);
    expect(brief).toMatch(/\[facebook\] Facebook is turned off for this project.*\(validate\.fbDisabled\)/);
    expect(brief).toMatch(/\[x\] text is 412 chars - X caps at 280 \(validate\.xTooLong\)/);
  });
  it('names the MCP tools, keeps approval with the owner and connections out of scope', () => {
    for (const tool of ['plan_get', 'platform_validate', 'plan_update_post']) expect(brief).toContain(tool);
    expect(brief).toMatch(/Do NOT call approve_post/);
    expect(brief).toMatch(/NOT YOURS TO FIX[\s\S]*\[telegram\][\s\S]*\[linkedin\] LinkedIn is not connected/);
    expect(brief).toMatch(/clientId: "acme"/);
  });
  it('tells the agent to remove the turned-off platform, never to turn the setting on', () => {
    expect(brief).toMatch(/never turn the project setting on/);
    expect(brief).toMatch(/fields \{ platforms: \["instagram"\] \}/);
    expect(brief).not.toMatch(/config\.platforms\.facebook=true/);
  });
  it('a post with Facebook only is told to change nothing', () => {
    expect(fixBrief({ post: { ...post, platforms: ['facebook'] }, blockers: [fbOff] })).toMatch(/only platform, so change nothing/);
  });
  it('has no em or en dash', () => {
    expect(brief).not.toMatch(/[\u2013\u2014]/);
  });
});

describe('fbDisabled says where the post still goes (params.variant)', () => {
  it('Facebook only: nothing would publish, no Instagram', () => {
    const b = { ...fbOff, params: { platform: 'facebook', variant: 'only' } };
    expect(fullCause(de, b)).toBe('Das Veröffentlichen auf Facebook ist in diesem Projekt ausgeschaltet, deshalb ginge dieser Beitrag nirgends hin. Schalte Facebook für dieses Projekt ein.');
    expect(fullCause(en, b)).not.toMatch(/instagram/i);
  });
  it('other platforms without Instagram: no Instagram either', () => {
    expect(fullCause(de, { ...fbOff, params: { platform: 'facebook', variant: 'others' } })).not.toMatch(/instagram/i);
  });
  it('with Instagram: the Instagram sentence', () => {
    expect(fullCause(en, fbOff)).toMatch(/only reach Instagram/);
  });
});
