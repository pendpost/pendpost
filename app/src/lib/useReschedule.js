// Shared reschedule-with-needs_confirm flow (extracted from App#moveToDay so it
// is defined once): post a new scheduledAt, escalate native handoffs (FB
// scheduled post / YouTube publishAt) to a confirm, then refresh the plan.
import { useQueryClient } from '@tanstack/react-query';
import { reschedulePost } from './api.js';
import { useConfirm } from '../components/ui/confirm.jsx';
import { useT } from './i18n.js';

// Immutably move one post to a new scheduledAt inside the nested plans cache
// ({ campaigns: [{ posts: [...] }] }). Returns the plans object unchanged if the
// post is missing (or plans not loaded yet), so an optimistic write is a no-op
// rather than a crash. Only the matching campaign/post is re-created, so React
// re-renders just the affected day columns.
export function patchPlanSchedule(plans, campaign, id, iso) {
  if (!plans?.campaigns) return plans;
  return {
    ...plans,
    campaigns: plans.campaigns.map((c) =>
      c.id !== campaign
        ? c
        : { ...c, posts: (c.posts || []).map((p) => (p.id === id ? { ...p, scheduledAt: iso } : p)) },
    ),
  };
}

// Immutably drop one post from the same nested plans cache - the optimistic
// half of the one-motion delete (PostDetail#onDelete): the post disappears the
// moment the owner confirms, and only a server refusal brings it back.
export function patchPlanRemove(plans, campaign, id) {
  if (!plans?.campaigns) return plans;
  return {
    ...plans,
    campaigns: plans.campaigns.map((c) =>
      c.id !== campaign ? c : { ...c, posts: (c.posts || []).filter((p) => p.id !== id) },
    ),
  };
}

export function useReschedule() {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const t = useT();
  return async (post, iso) => {
    // Optimistic: move the card to its new day now, so a drag/picker edit lands
    // instantly instead of waiting for the ['plans'] refetch. `prev` is the
    // rollback snapshot; the finally-invalidate reconciles with server truth.
    const prev = queryClient.getQueryData(['plans']);
    queryClient.setQueryData(['plans'], (old) => patchPlanSchedule(old, post.campaign, post.id, iso));
    // Issue 6: a card in all-clients mode carries clientId (App.jsx's merge
    // stamp, threaded here from the drag payload / the card's own post object) -
    // pass it so the write lands on ITS client, not whatever is active. Absent in
    // single-client mode, so the call keeps its original arity there.
    try {
      await (post.clientId ? reschedulePost(post.campaign, post.id, iso, false, post.clientId) : reschedulePost(post.campaign, post.id, iso));
    } catch (err) {
      if (err.code === 'needs_confirm') {
        // Native handoff (FB scheduled post / YouTube publishAt): the platform
        // object is deleted and re-created, so escalate to an explicit confirm.
        // Keep the optimistic move on screen while the dialog is open so the
        // card does not snap back and then jump forward again on confirm.
        const ok = await confirm({
          title: t('postDetail.confirm.title'),
          body: err.message || t('reschedule.confirm.body'),
          confirmLabel: t('postDetail.confirm.continue'),
          danger: true,
        });
        if (!ok) {
          // On decline: roll back to the original day and snap the calling
          // ActionButton back to idle with no error flash.
          queryClient.setQueryData(['plans'], prev);
          throw { canceled: true };
        }
        await (post.clientId ? reschedulePost(post.campaign, post.id, iso, true, post.clientId) : reschedulePost(post.campaign, post.id, iso, true));
      } else {
        // Genuine failure: roll the card back to where it was, then surface the
        // failure in-app (the callers here are fire-and-forget drag-drop / picker
        // handlers, not ActionButtons) instead of window.alert.
        queryClient.setQueryData(['plans'], prev);
        await confirm({
          title: t('reschedule.failed.title'),
          body: err.message || t('reschedule.failed.body'),
          confirmLabel: t('reschedule.failed.confirmLabel'),
          cancelLabel: t('app.action.close'),
        });
      }
    } finally {
      queryClient.invalidateQueries({ queryKey: ['plans'] });
    }
  };
}
