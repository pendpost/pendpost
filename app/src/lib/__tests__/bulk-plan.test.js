// bulk-plan.test.js - what each planner List bulk action may touch, and the words it leaves
// (planner bulk, package P). Pure rules, no React.
import { describe, it, expect, vi } from 'vitest';
import { makeT } from '../i18n.js';
import {
  bulkPlan, moveTarget, nameList, shortName, deleteToastText, doneToastText, whyText, notDoneLine, willNotLine,
  retimedOnApprove, restoreAll, restoreToast, restoreReasonKey, runAgentFixQueued, isPublishedPost,
} from '../bulkPlan.js';

const t = makeT('en');
const de = makeT('de-CH');
const nameOf = (p) => p.title || p.id;

const base = { campaign: 'c', platforms: ['linkedin'], executionMode: 'fully-scheduled', scheduledAt: '2099-03-10T09:30:00Z' };
const draft = { ...base, id: 'd1', title: 'Draft', approval: 'pending', derivedState: 'draft' };
const scheduled = { ...base, id: 's1', title: 'Scheduled', approval: 'approved', derivedState: 'waiting-due' };
const published = { ...base, id: 'p1', title: 'Launch', approval: 'approved', derivedState: 'posted', status: 'posted' };
const parked = { ...base, id: 'k1', title: 'Parked', approval: 'approved', derivedState: 'parked', executionMode: 'parked' };
const offline = { ...base, id: 'o1', title: 'Telegram teaser', platforms: ['telegram'], approval: 'pending', derivedState: 'draft' };
const undated = { ...base, id: 'u1', title: 'No time', scheduledAt: null, approval: 'pending', derivedState: 'draft' };
const setup = { platforms: [{ platform: 'telegram', status: 'incomplete' }, { platform: 'linkedin', status: 'connected' }] };

describe('bulkPlan', () => {
  const plan = bulkPlan([draft, scheduled, published, parked, offline, undated], {
    setupFor: () => setup,
    canAgentFix: (p) => p.id === 'd1',
  });
  const ids = (list) => list.map((p) => p.id);

  it('delete leaves a published post out (S1e) and takes the rest', () => {
    expect(ids(plan.keptPublished)).toEqual(['p1']);
    expect(ids(plan.deletable)).toEqual(['d1', 's1', 'k1', 'o1', 'u1']);
    expect(isPublishedPost({ id: 'x', ids: { xPostId: '1' } })).toBe(true);
  });

  it('approve takes what is not approved yet and leaves out a post on a not-connected lane (S2e), naming the lane', () => {
    expect(ids(plan.approvable)).toEqual(['d1', 'u1']);
    expect(ids(plan.offline)).toEqual(['o1']);
    expect(plan.offlineLanes).toEqual(['telegram']);
  });

  it('approve names every other post it leaves out: already approved or published (round 3, item 5)', () => {
    expect(plan.approveSkipped.map((s) => [s.post.id, s.reason])).toEqual([['s1', 'approved'], ['p1', 'published'], ['k1', 'approved']]);
    // Every selected post lands in exactly one approve bucket.
    expect(plan.approvable.length + plan.offline.length + plan.approveSkipped.length).toBe(6);
  });

  it('move takes every unpublished post with a time and says why it leaves the rest', () => {
    expect(ids(plan.movable)).toEqual(['d1', 's1', 'k1', 'o1']);
    expect(plan.unmovable.map((u) => [u.post.id, u.reason])).toEqual([['p1', 'published'], ['u1', 'noTime']]);
  });

  it('park takes a scheduled post, resume a parked one', () => {
    expect(ids(plan.parkable)).toEqual(['d1', 's1', 'o1', 'u1']);
    expect(ids(plan.resumable)).toEqual(['k1']);
  });

  it('agent takes only what the agent can fix; the rest is named as skipped (S5e)', () => {
    expect(ids(plan.agentFixable)).toEqual(['d1']);
    expect(plan.agentSkipped).toHaveLength(5);
  });
});

describe('moveTarget', () => {
  const now = Date.parse('2099-01-01T00:00:00Z');
  it('shifts by N days on the local wall clock', () => {
    const from = new Date(2099, 2, 10, 9, 30);
    const r = moveTarget(from.toISOString(), { days: 2 }, now);
    const to = new Date(r.iso);
    expect([to.getFullYear(), to.getMonth(), to.getDate(), to.getHours(), to.getMinutes()]).toEqual([2099, 2, 12, 9, 30]);
  });

  it('puts the post on a date and keeps its own time', () => {
    const from = new Date(2099, 2, 10, 17, 5);
    const to = new Date(moveTarget(from.toISOString(), { date: '2099-04-01' }, now).iso);
    expect([to.getMonth(), to.getDate(), to.getHours(), to.getMinutes()]).toEqual([3, 1, 17, 5]);
  });

  it('skips a post without a time, one that would land in the past, and a no-op', () => {
    expect(moveTarget(null, { days: 1 }, now)).toEqual({ skip: 'noTime' });
    expect(moveTarget('2099-01-02T10:00:00Z', { days: -5 }, now)).toEqual({ skip: 'past' });
    expect(moveTarget('2099-01-02T10:00:00Z', { days: 0 }, now)).toEqual({ skip: 'same' });
  });
});

describe('the words a run leaves', () => {
  it('names at most three posts, then "and N more"', () => {
    const posts = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id }));
    expect(nameList(posts.slice(0, 3), nameOf, t)).toBe('a, b, c');
    expect(nameList(posts, nameOf, t)).toBe('a, b, c and 2 more');
    expect(nameList(posts, nameOf, de)).toBe('a, b, c und 2 weitere');
  });

  it('cuts a long title for a toast', () => {
    expect(shortName('x'.repeat(60))).toHaveLength(40);
    expect(shortName('Short')).toBe('Short');
  });

  it('every run toasts in one pattern: "4 Beiträge gelöscht", "3 Beiträge verschoben", "1 Beitrag geparkt"', () => {
    expect(deleteToastText({ deleted: [draft, scheduled, parked, undated] }, nameOf, de)).toBe('4 Beiträge gelöscht');
    expect(doneToastText(3, de('listBulk.label.moved'), de)).toBe('3 Beiträge verschoben');
    expect(doneToastText(1, de('listBulk.label.parked'), de)).toBe('1 Beitrag geparkt');
    expect(doneToastText(2, t('approvals.bulk.labelApproved'), t)).toBe('2 posts approved');
  });

  it('after a run ONE line names what did not happen and why (S1e, S6)', () => {
    expect(notDoneLine(de('listBulk.label.deleted'), [{ post: published, reason: 'published' }], nameOf, de))
      .toBe('1 nicht gelöscht: Launch ist veröffentlicht');
    expect(notDoneLine(de('approvals.bulk.labelApproved'), [
      { post: offline, reason: 'offline', lanes: ['telegram'] },
      { post: draft, reason: 'failed', text: 'Zeitüberschreitung' },
    ], nameOf, de)).toBe('2 nicht freigegeben: Telegram nicht verbunden; Draft (Zeitüberschreitung)');
    expect(notDoneLine('x', [], nameOf, de)).toBe(null);
    expect(whyText([{ post: undated, reason: 'noTime' }, { post: { ...undated, id: 'u2', title: 'Other' }, reason: 'noTime' }], nameOf, de))
      .toBe('No time, Other haben keine Zeit');
  });

  it('before the press the line says how many a press leaves out, and the cause (no names)', () => {
    expect(willNotLine(de('approvals.bulk.labelApproved'), [1, 2, 3].map((i) => ({ post: { ...offline, id: `o${i}` }, reason: 'offline', lanes: ['linkedin'] })), de))
      .toBe('3 werden nicht freigegeben: LinkedIn nicht verbunden');
    expect(willNotLine(de('listBulk.label.deleted'), [{ post: published, reason: 'published' }], de)).toBe('1 wird nicht gelöscht: veröffentlicht');
    expect(willNotLine('x', [], de)).toBe(null);
  });

  it('a Radar reply past its draft time is retimed on approve, and the bar knows it', () => {
    const now = Date.parse('2099-03-10T12:00:00Z');
    expect(retimedOnApprove({ ...draft, radarReplyTo: { url: 'u' }, scheduledAt: '2099-03-10T11:00:00Z' }, now)).toBe(true);
    expect(retimedOnApprove({ ...draft, radarReplyTo: { url: 'u' }, scheduledAt: '2099-03-10T13:00:00Z' }, now)).toBe(false);
    expect(retimedOnApprove({ ...draft, scheduledAt: '2099-03-10T11:00:00Z' }, now)).toBe(false);
  });

  it('a delete the engine could not trash is named as one that cannot be undone', () => {
    expect(deleteToastText({ deleted: [draft, scheduled], permanent: [scheduled] }, nameOf, de))
      .toBe('2 Beiträge gelöscht. Lässt sich nicht rückgängig machen: Scheduled');
  });

});

describe('undo (restore)', () => {
  it('puts every post back and says so', async () => {
    const restore = vi.fn(() => Promise.resolve({ ok: true }));
    const outcome = await restoreAll([draft, scheduled], restore);
    expect(restore).toHaveBeenCalledTimes(2);
    expect(restoreToast(outcome, nameOf, de)).toEqual({ kind: 'success', text: '2 Beiträge wiederhergestellt' });
  });

  it('names the posts that came back parked (their slot passed in the trash)', async () => {
    const restore = vi.fn((p) => Promise.resolve({ ok: true, parked: p.id === 's1' }));
    const outcome = await restoreAll([draft, scheduled], restore);
    expect(outcome.parked.map((p) => p.id)).toEqual(['s1']);
    expect(restoreToast(outcome, nameOf, de).text).toBe('2 Beiträge wiederhergestellt. Wieder da, parkiert: Scheduled');
  });

  it('names a post that is no longer in the trash', async () => {
    const gone = Object.assign(new Error('not in trash'), { code: 'not_in_trash' });
    const outcome = await restoreAll([draft], () => Promise.reject(gone));
    expect(restoreToast(outcome, nameOf, de).text.text).toBe('Nicht wiederhergestellt: Draft (nicht mehr im Papierkorb)');
  });

  it('keeps going past a refusal and names the post whose id was reused (S1x conflict)', async () => {
    const conflict = Object.assign(new Error('an id now exists'), { code: 'conflict' });
    const restore = vi.fn((p) => (p.id === 'd1' ? Promise.reject(conflict) : Promise.resolve({ ok: true })));
    const outcome = await restoreAll([draft, scheduled], restore);
    expect(outcome.ok).toBe(1);
    const toast = restoreToast(outcome, nameOf, t);
    expect(toast.kind).toBe('error');
    expect(toast.text.text).toBe('Not restored: Draft (a new post took its place)');
    expect(toast.text.raw).toBe('d1: an id now exists');
  });

  it('maps the engine codes to plain reasons', () => {
    expect(restoreReasonKey({ code: 'not_in_trash' })).toBe('listBulk.restore.gone');
    expect(restoreReasonKey({ code: 'whatever' })).toBe(null);
  });
});

describe('runAgentFixQueued (one fix at a time)', () => {
  it('waits while the agent is busy, then waits for this post\'s job to settle', async () => {
    const busy = Object.assign(new Error('busy'), { code: 'agent_busy' });
    const start = vi.fn()
      .mockRejectedValueOnce(busy)
      .mockResolvedValueOnce({ ok: true, state: 'running' });
    const polls = [
      { running: true, fixes: [{ campaign: 'c', postId: 'd1', state: 'running' }] },
      { running: false, fixes: [{ campaign: 'c', postId: 'd1', state: 'done' }] },
    ];
    const list = vi.fn(() => Promise.resolve(polls.shift()));
    const jobFor = (data, p) => data.fixes.find((f) => f.postId === p.id) || null;
    const sleep = vi.fn(() => Promise.resolve());
    const job = await runAgentFixQueued(draft, { start, list, jobFor, sleep });
    expect(start).toHaveBeenCalledTimes(2);
    expect(list).toHaveBeenCalledTimes(2);
    // one wait while busy, one between the two polls
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(job.state).toBe('done');
  });

  it('a refusal other than busy fails the post at once', async () => {
    const start = vi.fn().mockRejectedValue(Object.assign(new Error('nope'), { code: 'not_fixable' }));
    await expect(runAgentFixQueued(draft, { start, list: vi.fn(), jobFor: () => null, sleep: () => Promise.resolve() })).rejects.toThrow('nope');
  });
});
