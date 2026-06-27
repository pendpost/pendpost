// Shared reschedule-with-needs_confirm flow (extracted from App#moveToDay so it
// is defined once): post a new scheduledAt, escalate native handoffs (FB
// scheduled post / YouTube publishAt) to a confirm, then refresh the plan.
import { useQueryClient } from '@tanstack/react-query';
import { reschedulePost } from './api.js';
import { useConfirm } from '../components/ui/confirm.jsx';
import { useT } from './i18n.js';

export function useReschedule() {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const t = useT();
  return async (post, iso) => {
    try {
      await reschedulePost(post.campaign, post.id, iso);
    } catch (err) {
      if (err.code === 'needs_confirm') {
        // Native handoff (FB scheduled post / YouTube publishAt): the platform
        // object is deleted and re-created, so escalate to an explicit confirm.
        const ok = await confirm({
          title: t('postDetail.confirm.title'),
          body: err.message || t('reschedule.confirm.body'),
          confirmLabel: t('postDetail.confirm.continue'),
          danger: true,
        });
        // On decline: snap the calling ActionButton back to idle with no error flash.
        if (!ok) throw { canceled: true };
        await reschedulePost(post.campaign, post.id, iso, true);
      } else {
        // Surface the failure in-app (the callers here are fire-and-forget
        // drag-drop / picker handlers, not ActionButtons) instead of window.alert.
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
