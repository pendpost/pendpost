import { Pencil, CheckCircle, XCircle, PauseCircle, ShieldCheck, Trash2, Send, RefreshCw, PlugZap } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useConfirm, usePrompt } from '../components/ui/confirm.jsx';
import { showToast } from '../components/AppToast.jsx';
import { useT } from './i18n.js';
import { approvePost, rejectPost, verifyPost, deletePost, unschedulePost, runPublishDue, reschedulePost, resumeLane } from './api.js';
import { patchPlanRemove } from './useReschedule.js';
import { canApprovePost, canRejectPost, canParkPost, canVerifyPost, canPublishNowPost, isHeldRetry, postHasPublishEvidence } from './postActions.js';
import { publishRunOutcome } from './format.js';

// The overview's post-action set - the SAME actions PostDetail offers, made reachable
// from a card/row's three-dots menu (ui/RowMenu) so an operator can act without opening
// the detail drawer (the owner's "take actions right on the overview"). It returns a flat
// descriptor list the RowMenu renders; a caller that shows some actions inline (Freigaben's
// Approve/Reject) filters those keys out of what it hands the menu.
//
// Availability is decided by the SHARED gate predicates (lib/postActions.js), the same
// ones PostDetail uses, so the row and the drawer can never disagree on what a post can do.
// The handlers here are the ROW-context twins of PostDetail's: no drawer to close, so they
// refresh the list and surface failures as a toast (mirroring PostDetail.onDelete and the
// existing usePark/useReschedule sibling hooks) instead of an in-drawer banner. `clientId`
// (all-projects mode) threads onto every write, exactly as usePark does.
//
// Publish-now / try-again and resume-lane are offered here too (parity with the drawer,
// one design language): the same shared gates decide them (canPublishNowPost, and a
// lane-halt for resume), and the handlers mirror PostDetail.onPublishNow +
// PlannerRunNowDialog.runOne (clear a hold with a same-time reschedule first, run the
// per-post publish-due, then branch on publishRunOutcome) and PostDetail's lane-resume
// (honest stillDepleted toast). Failures surface as a toast instead of an in-drawer banner.
//
// Deliberately NOT here: mark-posted and the lane-specific deep actions (playlist, zap,
// pin, discord event, edit-published) - those need the detail context and stay in the
// drawer, one click away via the row itself. `onEdit` (open the Composer) is offered only
// when the caller passes it.
export function usePostActions(post, { onEdit } = {}) {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const prompt = usePrompt();
  const t = useT();
  const clientId = post?.clientId; // set only by the all-projects merge (App.jsx)
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['plans'] });

  const approve = async () => {
    try {
      await approvePost(post.campaign, post.id, undefined, clientId);
    } catch (err) {
      showToast({ kind: 'error', text: err?.message || t('postDetail.error.generic') });
    } finally {
      refresh();
    }
  };

  const reject = async () => {
    const note = await prompt({
      title: t('postDetail.reject.title'),
      body: t('postDetail.reject.body'),
      placeholder: t('postDetail.reject.placeholder'),
      multiline: true,
      rememberKey: 'approvals.reject',
    });
    if (note === null) return; // cancelled
    try {
      await rejectPost(post.campaign, post.id, note.trim() || undefined, clientId);
    } catch (err) {
      showToast({ kind: 'error', text: err?.message || t('postDetail.error.generic') });
    } finally {
      refresh();
    }
  };

  // Park mirrors Planner's former usePark: escalate a native-object cancel to an explicit
  // confirm, else surface the failure. Consolidated here so the row and the (removed) local
  // hook share one implementation.
  const park = async () => {
    try {
      await (clientId ? unschedulePost(post.campaign, post.id, false, clientId) : unschedulePost(post.campaign, post.id));
    } catch (err) {
      if (err?.code === 'needs_confirm') {
        const ok = await confirm({
          title: t('postDetail.confirm.title'),
          body: err.message || t('postDetail.action.parkTip'),
          confirmLabel: t('postDetail.confirm.continue'),
          danger: true,
        });
        if (!ok) { refresh(); return; }
        await (clientId ? unschedulePost(post.campaign, post.id, true, clientId) : unschedulePost(post.campaign, post.id, true));
      } else {
        showToast({ kind: 'error', text: err?.message || t('reschedule.failed.body') });
      }
    } finally {
      refresh();
    }
  };

  const verify = async () => {
    try {
      await verifyPost(post.campaign, post.id);
    } catch (err) {
      showToast({ kind: 'error', text: err?.message || t('postDetail.error.generic') });
    } finally {
      refresh();
    }
  };

  // Delete: the same "delete always works" motion as PostDetail.onDelete - evidence folds
  // the force decision into ONE confirm, then the row leaves the ['plans'] cache
  // optimistically and the server answer lands as a toast (success quietly, failure with the
  // reason and the row rolled back). After the Part-A YouTube fix an already-gone native
  // object no longer strands the row here either.
  const del = async () => {
    const hasEvidence = postHasPublishEvidence(post);
    const ok = await confirm({
      title: t('postDetail.delete.title'),
      body: hasEvidence ? t('postDetail.delete.forceBody', { id: post.id }) : t('postDetail.delete.body', { id: post.id }),
      confirmLabel: hasEvidence ? t('postDetail.delete.forceLabel') : t('postDetail.delete.confirmLabel'),
      danger: true,
      rememberKey: hasEvidence ? undefined : 'postDetail.delete',
    });
    if (!ok) return;
    const prev = queryClient.getQueryData(['plans']);
    queryClient.setQueryData(['plans'], (old) => patchPlanRemove(old, post.campaign, post.id));
    try {
      await deletePost(post.campaign, post.id, hasEvidence, clientId);
      showToast({ kind: 'success', text: t('postDetail.delete.toastSuccess') });
    } catch (err) {
      queryClient.setQueryData(['plans'], prev);
      const detail = err?.message || t('postDetail.error.generic');
      showToast({
        kind: 'error',
        text: err?.code === 'engine_failure'
          ? t('postDetail.delete.toastError.cancelFailed', { detail })
          : t('postDetail.delete.toastError', { message: detail }),
      });
    } finally {
      refresh();
    }
  };

  // Publish-now / try-again: the ROW twin of PostDetail.onPublishNow. An irreversible
  // publish, so it confirms up front (same copy as the drawer), then - for a HELD post -
  // clears the hold with a same-time reschedule (the engine's documented retry verb) before
  // running the per-post publish-due, and reads the per-lane truth via publishRunOutcome so
  // it reports WHY nothing fired instead of flashing a false success.
  const publishNowAllowed = canPublishNowPost(post, { offlineLanes: [] });
  const heldRetry = isHeldRetry(post, publishNowAllowed);
  const publishNow = async () => {
    const ok = await confirm({
      title: t(heldRetry ? 'postDetail.tryAgain.title' : 'postDetail.publishNow.title'),
      body: t(heldRetry ? 'postDetail.tryAgain.body' : 'postDetail.publishNow.body', { id: post.id }),
      confirmLabel: t(heldRetry ? 'postDetail.tryAgain.confirmLabel' : 'postDetail.publishNow.confirmLabel'),
      danger: true,
    });
    if (!ok) return;
    try {
      if (heldRetry) {
        // Clear the hold FIRST, or the run below fires zero lanes (lanesOwed skips a held
        // post). needs_confirm escalates like every other native-object mutation.
        try {
          await reschedulePost(post.campaign, post.id, post.scheduledAt, false, clientId);
        } catch (err) {
          if (err?.code !== 'needs_confirm') throw err;
          const ok2 = await confirm({
            title: t('postDetail.confirm.title'),
            body: err.message || t('postDetail.action.parkTip'),
            confirmLabel: t('postDetail.confirm.continue'),
            danger: true,
          });
          if (!ok2) return;
          await reschedulePost(post.campaign, post.id, post.scheduledAt, true, clientId);
        }
      }
      const res = await runPublishDue({ campaign: post.campaign, postId: post.id, clientId });
      const { rows, fired, held, halted, reason } = publishRunOutcome(res, post.id);
      if (fired) {
        showToast({ kind: 'success', text: t('postActions.publishNow.toastSuccess') });
      } else if (held) {
        // The cloud owns this lane inside its handoff grace: nothing failed, it just cannot
        // fire locally yet.
        showToast({ kind: 'error', text: t('postDetail.publishNow.cloudHeld') });
      } else if (halted && !reason) {
        // Lane paused by an account-level breaker (X 402 credits) and dropped before
        // dispatch - point at the resume control instead of blaming the scheduler.
        showToast({ kind: 'error', text: t('postDetail.publishNow.laneHalted') });
      } else if (reason) {
        showToast({ kind: 'error', text: t('postDetail.publishNow.failedReason', { reason }) });
      } else if (rows.length) {
        showToast({ kind: 'error', text: t('postDetail.publishNow.laneFailed', { lane: rows[0].lane }) });
      } else {
        showToast({ kind: 'error', text: t(heldRetry ? 'postDetail.publishNow.nothingRanHeld' : 'postDetail.publishNow.nothingRan') });
      }
    } catch (err) {
      showToast({ kind: 'error', text: err?.message || t('postDetail.error.generic') });
    } finally {
      refresh();
    }
  };

  // Resume a lane an account-level breaker halted (X 402 credits): clears the block,
  // re-fires the lane's parked posts as a credit recheck, and tells the truth if credits
  // are still out (stillDepleted) instead of flashing a false "resumed". Mirrors the
  // drawer's lane-resume, including its plans + health refresh.
  const resume = async () => {
    try {
      const r = await resumeLane(post?.lastFailure?.lane);
      showToast(r?.stillDepleted
        ? { kind: 'error', text: t('postDetail.resume.stillDepleted') }
        : { kind: 'success', text: t('postActions.resume.toastSuccess') });
    } catch (err) {
      showToast({ kind: 'error', text: err?.message || t('postDetail.error.generic') });
    } finally {
      queryClient.invalidateQueries({ queryKey: ['plans'] });
      queryClient.invalidateQueries({ queryKey: ['health'] });
      queryClient.invalidateQueries({ queryKey: ['pendpost-health'] });
    }
  };

  // Ordered for the menu: open, approve, reject, park, verify, publish-now, resume, then
  // the destructive delete last (RowMenu renders `danger` red). Falsy entries are dropped
  // by RowMenu, so gating is just a boolean per row.
  const items = [
    onEdit && { key: 'edit', label: t('postDetail.action.openEditor'), Icon: Pencil, run: () => onEdit(post) },
    canApprovePost(post) && { key: 'approve', label: t('approvals.action.approve'), Icon: CheckCircle, run: approve },
    canRejectPost(post) && { key: 'reject', label: t('approvals.action.reject'), Icon: XCircle, run: reject },
    canParkPost(post) && { key: 'park', label: t('postDetail.action.parkIdle'), Icon: PauseCircle, run: park },
    // ux-audit dim-1 G3/R1a parity: a verify-FAILED post's menu carries the same
    // "Re-check" recovery verb PostDetail and Published use for that state - the
    // read-back said not-live, so the honest verb is to read again, not "Verify".
    canVerifyPost(post) && { key: 'verify', label: t(post?.derivedState === 'verify-failed' ? 'postDetail.action.recheckIdle' : 'postDetail.action.verifyIdle'), Icon: ShieldCheck, run: verify },
    // A held-retry reads "Erneut versuchen" (RefreshCw); a plain overdue/failed post reads
    // "Jetzt veröffentlichen" (Send) - the same label + icon split the drawer uses.
    publishNowAllowed && { key: 'publish-now', label: t(heldRetry ? 'postDetail.action.tryAgainIdle' : 'postDetail.action.publishNowIdle'), Icon: heldRetry ? RefreshCw : Send, run: publishNow },
    // A lane-halt (canPublishNowPost deliberately excludes it) gets the resume verb instead,
    // named for the platform ("Veröffentlichung fortsetzen"), not the internal word "Lane".
    Boolean(post?.lastFailure?.halted) && { key: 'resume-lane', label: t('readiness.resumeLane'), Icon: PlugZap, run: resume },
    { key: 'delete', label: t('postDetail.action.deleteMenu'), Icon: Trash2, danger: true, run: del },
  ].filter(Boolean);

  return { items };
}
