import { describe, it, expect } from 'vitest';
import en from '../../locales/en.json';
import deCH from '../../locales/de-CH.json';
import { attentionSummary, matchesFilters, STATUS_FILTERS } from '../format.js';
import { groupIssues } from '../postIssue.js';
import { systemRows, needsYouCount } from '../needsYou.js';

// Studio fix flow, package C: ONE count everywhere. The header badge, the "Needs you" tray
// title and the needs-you filter all count the same set: every post that needs the owner
// (blocked + waiting on you, lib/postIssue.js) plus the system rows the tray shows
// (scheduler off, a halted lane, a manifest or config error, a stuck post no fix covers).
// Before, the badge skipped Blocked posts entirely, so a post that could never go out until
// a lane was connected was invisible in the count.

const setup = { platforms: [
  { platform: 'telegram', status: 'incomplete' },
  { platform: 'linkedin', status: 'connected', validation: { state: 'live' } },
] };
const blocked = { id: 'b1', campaign: 'c', platforms: ['telegram'], approval: 'approved', derivedState: 'waiting-due', scheduledAt: '2099-01-01T10:00:00Z' };
const needsYou = { id: 'n1', campaign: 'c', platforms: ['linkedin'], approval: 'approved', derivedState: 'publish-failed', lastFailure: { lane: 'linkedin', recovery: 'reconnect', terminal: true } };
const calm = { id: 'k1', campaign: 'c', platforms: ['linkedin'], approval: 'approved', derivedState: 'waiting-due', scheduledAt: '2099-01-01T10:00:00Z' };
const overdue = { id: 'o1', campaign: 'c', platforms: ['linkedin'], approval: 'approved', derivedState: 'overdue' };

describe('attentionSummary: one count = blocked + needs-you posts + system rows', () => {
  it('counts a Blocked post (it was skipped before)', () => {
    expect(attentionSummary([blocked, calm], { setup })).toEqual({ kind: 'needs-you', count: 1 });
  });

  it('adds blocked, needs-you and system rows into one number', () => {
    expect(attentionSummary([blocked, needsYou, calm], { setup, system: 2 })).toEqual({ kind: 'needs-you', count: 4 });
  });

  it('system rows alone light the badge', () => {
    expect(attentionSummary([calm], { setup, system: 1 })).toEqual({ kind: 'needs-you', count: 1 });
  });

  it('a per-post setup function judges each project with its own setup', () => {
    const other = { ...blocked, id: 'b2', clientId: 'other' };
    const setupFor = (p) => (p.clientId === 'other' ? null : setup);
    expect(attentionSummary([blocked, other], { setup: setupFor })).toEqual({ kind: 'needs-you', count: 1 });
  });

  it('with nothing needing the owner, plain late posts still read overdue', () => {
    expect(attentionSummary([overdue, calm], { setup })).toEqual({ kind: 'overdue', count: 1 });
    expect(attentionSummary([calm], { setup })).toBeNull();
  });

  it('equals the tray: every grouped post plus every system row', () => {
    const posts = [blocked, needsYou, calm, overdue];
    const groups = groupIssues(posts, setup);
    const rows = [{ key: 'scheduler', type: 'scheduler' }];
    expect(needsYouCount(groups, rows)).toBe(3);
    expect(attentionSummary(posts, { setup, system: rows.length }).count).toBe(needsYouCount(groups, rows));
  });
});

describe('the needs-you status filter', () => {
  it('is offered first, labelled in both packs', () => {
    expect(STATUS_FILTERS[0].key).toBe('needs-you');
    for (const pack of [en, deCH]) expect(pack.strings['status.needs-you']).toBeTruthy();
  });

  it('matches blocked and needs-you posts, never a calm or merely overdue one', () => {
    const f = (p) => matchesFilters(p, [], [], ['needs-you'], setup);
    expect(f(blocked)).toBe(true);
    expect(f(needsYou)).toBe(true);
    expect(f(calm)).toBe(false);
    expect(f(overdue)).toBe(false);
  });

  it('every post the badge counts is in the list it opens', () => {
    for (const p of [blocked, needsYou]) expect(matchesFilters(p, [], [], ['needs-you'], setup)).toBe(true);
  });
});

describe('systemRows: what the tray shows beside the post groups', () => {
  const health = (blockerCodes, extra = {}) => ({ ready: false, blockerCodes, ...extra });

  it('maps scheduler off, a halted lane, manifest and config errors and a Meta action block', () => {
    const rows = systemRows(health([
      { code: 'blocker.schedulerOff' },
      { code: 'blocker.laneBlocked', params: { platform: 'x', reason: 'credits' } },
      { code: 'blocker.manifest', params: { error: 'bad json' } },
      { code: 'blocker.config', params: { error: 'EACCES' } },
      { code: 'blocker.lane.blocked', params: { label: 'Meta' } },
    ]));
    expect(rows.map((r) => r.type)).toEqual(['scheduler', 'resume', 'manifest', 'config', 'actionBlock']);
    expect(rows[1].lane).toBe('x');
  });

  it('never repeats a lane-wide halt the post groups already resume', () => {
    const halted = { id: 'h1', campaign: 'c', platforms: ['x'], approval: 'approved', derivedState: 'publish-failed', lastFailure: { lane: 'x', halted: true, terminal: true } };
    const groups = groupIssues([halted], setup);
    const rows = systemRows(health([{ code: 'blocker.laneBlocked', params: { platform: 'x' } }]), { groups });
    expect(rows).toEqual([]);
  });

  it('not-connected lanes stay on Setup: they are never a tray row', () => {
    const rows = systemRows(health([
      { code: 'blocker.lane.notConnected', params: { label: 'Telegram' } },
      { code: 'blocker.lane.unproven', params: { label: 'X' } },
      { code: 'blocker.lane.failed', params: { label: 'LinkedIn' } },
    ]));
    expect(rows).toEqual([]);
  });

  it('a stuck post shows only when no post fix covers it and pendpost is not still retrying', () => {
    const codes = [
      { code: 'blocker.overdueUnpublished', params: { campaign: 'c', postId: 'n1', reason: 'x' } },
      { code: 'blocker.overdueUnpublished', params: { campaign: 'c', postId: 'r1', reason: 'x' } },
      { code: 'blocker.overdueUnpublished', params: { campaign: 'c', postId: 's1', reason: 'cloud fire failed' } },
    ];
    const retrying = { id: 'r1', campaign: 'c', platforms: ['linkedin'], approval: 'approved', derivedState: 'publish-failed', lastFailure: { terminal: false } };
    const silent = { id: 's1', campaign: 'c', platforms: ['linkedin'], approval: 'approved', derivedState: 'overdue' };
    const rows = systemRows(health(codes), { posts: [needsYou, retrying, silent], setupFor: () => setup });
    expect(rows.map((r) => r.key)).toEqual(['post:c/s1']);
    expect(rows[0].post).toBe(silent);
  });

  it('no health, no rows', () => {
    expect(systemRows(null)).toEqual([]);
  });
});

// Polish 2026-11-01: a cloud that needs a look is a system row (first: it holds up every
// always-on project at once), so it counts in the one number on the badge and the tray.
describe('systemRows: the cloud row', () => {
  const cloud = (over = {}) => ({ count: 2, names: ['Acme Studio', 'Northwind'], health: 'amber', reason: 'cloud_unreachable', ...over });

  it('amber with a recheckable reason: one cloud row, first, naming the affected projects', () => {
    const rows = systemRows({ ready: false, blockerCodes: [{ code: 'blocker.schedulerOff' }] }, { cloud: cloud() });
    expect(rows.map((r) => r.key)).toEqual(['cloud', 'scheduler']);
    expect(rows[0]).toMatchObject({ type: 'cloud', health: 'amber', reason: 'cloud_unreachable', names: ['Acme Studio', 'Northwind'] });
  });

  it('shows even before pendpost-health has loaded', () => {
    expect(systemRows(null, { cloud: cloud({ health: 'red', reason: 'worker_stale' }) }).map((r) => r.key)).toEqual(['cloud']);
  });

  it('counts in the one number (badge and tray alike)', () => {
    const groups = groupIssues([blocked, needsYou], setup);
    const rows = systemRows({ ready: true, blockerCodes: [] }, { groups, cloud: cloud() });
    expect(needsYouCount(groups, rows)).toBe(3);
    expect(attentionSummary([blocked, needsYou], { setup, system: rows.length })).toEqual({ kind: 'needs-you', count: 3 });
  });

  it('no row when the cloud is fine, when no project in view runs on it, or when a recheck cannot clear it', () => {
    expect(systemRows(null, { cloud: cloud({ health: 'green', reason: 'all_confirmed' }) })).toEqual([]);
    expect(systemRows(null, { cloud: cloud({ health: 'yellow', reason: 'push_pending' }) })).toEqual([]);
    expect(systemRows(null, { cloud: cloud({ count: 0 }) })).toEqual([]);
    expect(systemRows(null, { cloud: cloud({ health: 'red', reason: 'cloud_failures' }) })).toEqual([]);
    expect(systemRows(null, { cloud: cloud({ reason: 'push_stuck' }) })).toEqual([]);
  });
});
