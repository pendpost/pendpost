import { useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { runPublishDue, useActiveClient } from '../lib/api.js';
import { useT } from '../lib/i18n.js';
import ActionButton from './ui/ActionButton.jsx';
import { useConfirm } from './ui/confirm.jsx';

// B4 — the Activity "Check now" publish (publish_due_run). This fired with NO
// confirmation today, yet it is a real publish path: it publishes every approved,
// due post for the ACTIVE client right now, with no undo. So we raise an in-app
// confirm that NAMES the target client by displayName BEFORE any network call, and
// only confirm:true proceeds to runPublishDue() (fail-closed: cancel publishes
// nothing). This strengthens - never weakens - the human-approval gate; it does
// not double-prompt the server's separate needs_confirm escalation (runPublishDue
// already posts confirm:true; the confirm here is the up-front human gate).
export default function ActivityCheckNow() {
  const t = useT();
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const { activeClient } = useActiveClient();
  const name = activeClient?.displayName;

  const onAction = async () => {
    const ok = await confirm({
      title: name ? t('activity.checkNow.confirm.title', { client: name }) : t('activity.checkNow.confirm.titleNoClient'),
      body: name ? t('activity.checkNow.confirm.body', { client: name }) : t('activity.checkNow.confirm.bodyNoClient'),
      confirmLabel: t('activity.checkNow.confirm.confirmLabel'),
      danger: true,
    });
    if (!ok) throw { canceled: true }; // fail-closed: cancel => no publish
    await runPublishDue();
    queryClient.invalidateQueries({ queryKey: ['activity'] });
    queryClient.invalidateQueries({ queryKey: ['plans'] });
  };

  return (
    <ActionButton
      icon={RefreshCw}
      labels={{
        idle: t('activity.checkNow.idle'),
        loading: t('activity.checkNow.loading'),
        success: t('activity.checkNow.success'),
        error: t('activity.checkNow.error'),
      }}
      onAction={onAction}
    />
  );
}
