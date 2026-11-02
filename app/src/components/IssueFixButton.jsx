// IssueFixButton - the single place a post's fix runs (studio fix flow, contract section A).
//
// Every post that is Blocked or Waiting on you carries ONE fix (lib/postIssue.js), and this
// button runs it where the owner already is: the post detail card today, the planner row and
// the "Needs you" tray next. It never sends the owner on a hunt:
//   - connect / reconnect on a key-based lane (the in-place reconnect lanes plus bluesky):
//     the existing Setup ConnectPanel opens in a modal right here. That panel IS the human
//     credential ceremony (/api/connect has no MCP twin); no agent ever handles the secret.
//     On success the lane is rechecked (a passing recheck releases the parked posts) and the
//     modal closes.
//   - connect / reconnect on an OAuth lane: Setup opens on that lane with its reconnect
//     already started (onNavigate('setup', lane, { action: 'reconnect' })).
//   - edit: "Fix with agent" when the post's problem is content and an agent is connected
//     (the agent edits, the post comes back for approval); "Open in editor" otherwise, and
//     always as the second way.
//   - resume / cloud / manual / discard: the PostDetail banner's existing actions.
// In all-projects mode the ceremony targets issue.clientId, never silently the active project.
// A failure says its reason inline, beside the same button (never a toast-only error).
import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Bot, CheckCheck, ClipboardCopy, Cloud as CloudIcon, Loader2, Pencil, PlugZap, Trash2 } from 'lucide-react';
import { usePendpostHealth, agentFixPost, resumeLane, recheckHealth, markPosted, deletePost } from '../lib/api.js';
import { CONNECT_FIELDS, IN_PLACE_RECONNECT_LANES, ConnectPanel } from './ConnectPanel.jsx';
import { Modal, CloseButton } from './ui.jsx';
import { Button } from './ui/Button.jsx';
import ActionButton from './ui/ActionButton.jsx';
import ActionError from './ui/ActionError.jsx';
import { TAP_TARGET } from './ui/recipes.js';
import { useConfirm, usePrompt } from './ui/confirm.jsx';
import { useAgentFixes, fixFor } from '../lib/agentFix.js';
import { useT } from '../lib/i18n.js';
import { humanizeAction, laneLabel } from '../lib/failureCopy.js';
import { effectiveLaneText } from '../lib/format.js';

// The lanes whose credential is a key the owner pastes: their connect runs in a modal right
// here. Everything else is a browser OAuth consent and runs on its Setup card.
export function inPlaceConnectLane(lane) {
  return (IN_PLACE_RECONNECT_LANES.has(lane) || lane === 'bluesky') && Boolean(CONNECT_FIELDS[lane]);
}

// Is the owner's agent connected for this project? The same fact the Setup "Your agent" card
// reads (lib/setup.mjs agentSetup): a credential for a provider pendpost can run, and no
// failed probe on record.
export function agentAvailable(setup) {
  const a = setup?.agent;
  return Boolean(a?.connected) && a?.validation?.state !== 'failed';
}

// The button's visible words for an issue (C's tray uses this too). Short, lane-free: the
// card title or the tray row already names the lane, and the accessible name adds it.
// `agent`: whether the agent is available, so a content issue reads "Fix with agent".
export function fixLabel(issue, t, { agent = false } = {}) {
  switch (issue?.fix?.type) {
    case 'connect': return t('issue.fix.connect');
    case 'reconnect': return t('issue.fix.reconnect');
    case 'edit': return agent && issue.fix.agent ? t('issue.fix.agent') : t('issue.fix.edit');
    case 'resume': return t('issue.fix.resume');
    case 'cloud': return t('issue.fix.cloud');
    case 'manual': return t('issue.fix.manual');
    case 'discard': return t('issue.fix.discard');
    default: return '';
  }
}

// The accessible name: the visible words plus the lane where the lane is the point.
function fixAriaLabel(issue, t, opts) {
  const lane = laneLabel(issue?.fix?.lane);
  if (issue?.fix?.type === 'connect') return t('issue.fix.connectLane', { lane });
  if (issue?.fix?.type === 'reconnect') return t('issue.fix.reconnectLane', { lane });
  return fixLabel(issue, t, opts);
}

// The agent-fix route's refusals (lib/agent-fix.mjs startAgentFix), each a plain sentence.
const AGENT_REFUSALS = {
  agent_busy: 'issue.agent.busy',
  agent_unavailable: 'issue.agent.unavailable',
  not_fixable: 'issue.agent.notFixable',
  in_flight: 'issue.agent.publishing',
};

const ICONS = { connect: PlugZap, reconnect: PlugZap, edit: Pencil, resume: PlugZap, cloud: CloudIcon, manual: ClipboardCopy, discard: Trash2 };

// The connect modal: the Setup ConnectPanel, scoped to the post's project. Escape closes THIS
// modal only (a capture listener stops it before the post detail's own Escape closes that).
function ConnectModal({ lane, clientId, onClose, onConnected }) {
  const t = useT();
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  const name = laneLabel(lane);
  const def = CONNECT_FIELDS[lane];
  return (
    <Modal onClose={onClose} label={t('issue.connect.title', { lane: name })} width="max-w-md">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h2 className="text-base font-bold tracking-tight">{t('issue.connect.title', { lane: name })}</h2>
          <p className="text-xs text-zinc-600 dark:text-zinc-300">
            {lane === 'bluesky' ? t('issue.connect.blueskyHint') : t('issue.connect.hint')}
          </p>
        </div>
        <CloseButton onClose={onClose} label={t('issue.connect.close')} />
      </div>
      <ConnectPanel
        platform={lane}
        fields={def.fields}
        interactive={def.interactive}
        submitLabel={t('issue.fix.connect')}
        autoFocus
        clientId={clientId}
        onConnected={onConnected}
      />
    </Modal>
  );
}

export default function IssueFixButton({
  issue, post, onNavigate, onEdit, size = 'md', variant = 'solid', className = '',
  // Optional: the post detail hands over its own flows for these three (richer confirms,
  // optimistic delete). Without them the button runs a self-contained version.
  onDiscard = null, onHandOff = null, onMarkPosted = null, handedOff: handedOffProp = null,
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const prompt = usePrompt();
  const { data: health } = usePendpostHealth(true);
  const [connectOpen, setConnectOpen] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState(null); // { text, raw }
  const [note, setNote] = useState(null); // a calm status line after a started agent fix
  const [handedOffLocal, setHandedOffLocal] = useState(false);
  // The agent fix job for this post (package D, GET /api/agent-fix): while it runs the button
  // reads "Agent working..." for everyone who opens the post, not only the tab that started it.
  const fixWatch = issue?.fix?.type === 'edit' && Boolean(issue?.fix?.agent);
  const { data: fixData } = useAgentFixes({ clientId: issue?.clientId ?? post?.clientId ?? null, enabled: fixWatch });
  if (!issue?.fix?.type) return null;

  const type = issue.fix.type;
  const lane = issue.fix.lane;
  const clientId = issue.clientId ?? post?.clientId ?? null;
  const scope = clientId ? [clientId] : [];
  const agent = type === 'edit' && issue.fix.agent && agentAvailable(health?.setup);
  const label = fixLabel(issue, t, { agent });
  const aria = fixAriaLabel(issue, t, { agent });
  const Icon = agent ? Bot : ICONS[type] || PlugZap;
  // 'solid' is the house filled control (the subtle fill the failure banner always used), so
  // the fix never competes with the dialog's one teal primary; 'ghost' for a dense list row.
  const btnVariant = variant === 'ghost' ? 'ghost' : 'subtle';
  const btnCls = `${TAP_TARGET} ${className}`;
  const handedOff = handedOffProp ?? handedOffLocal;
  // Only a job newer than the failure speaks for this post; an old one is history.
  const lastJob = fixWatch ? fixFor(fixData, post?.campaign, post?.id, clientId) : null;
  const job = lastJob && (Date.parse(lastJob.at || '') || 0) >= (Date.parse(post?.lastFailure?.at || '') || 0) ? lastJob : null;
  const jobRunning = job?.state === 'running';
  const jobLine = !job || jobRunning ? null
    : job.state === 'done' ? { tone: 'ok', text: t('issue.agent.done') }
      : { tone: 'err', text: t(job.state === 'nothing' ? 'issue.agent.nothing' : 'issue.agent.jobFailed'), raw: job.summary || null };

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['plans'] });
    queryClient.invalidateQueries({ queryKey: ['pendpost-health'] });
    queryClient.invalidateQueries({ queryKey: ['accounts'] });
  };
  const fail = (err, fallbackKey = 'issue.error.generic') => {
    if (err?.canceled === true) return;
    setError(humanizeAction(err, t, { fallbackKey }));
  };

  // The connect ceremony reported 'connected': recheck the lane once more (for a probed lane
  // a passing forced recheck releases the parked posts; bluesky's connect already released
  // them), refresh what the Studio shows, close the modal.
  const onConnected = async () => {
    setConnectOpen(false);
    if (lane !== 'bluesky') {
      try { await recheckHealth(lane, ...scope); } catch { /* the plans refresh still shows the truth */ }
    }
    refresh();
  };

  const run = async (fn) => {
    setError(null);
    setNote(null);
    setWorking(true);
    try {
      await fn();
    } finally {
      setWorking(false);
    }
  };

  const onClick = () => {
    setError(null);
    if (type === 'connect' || type === 'reconnect') {
      if (inPlaceConnectLane(lane)) { setConnectOpen(true); return; }
      if (typeof onNavigate === 'function') onNavigate('setup', lane, { action: 'reconnect' });
      return;
    }
    if (type === 'cloud') { if (typeof onNavigate === 'function') onNavigate('cloud'); return; }
    if (type === 'edit') {
      if (!agent) { if (typeof onEdit === 'function') onEdit(post); return; }
      run(async () => {
        try {
          await agentFixPost(post.campaign, post.id, ...scope);
          setNote(t('issue.agent.started'));
          queryClient.invalidateQueries({ queryKey: ['plans'] });
          queryClient.invalidateQueries({ queryKey: ['agentFix'] });
        } catch (err) {
          // Each refusal the route returns gets its own plain sentence; the engine's English
          // line rides the "?" only. The button stays, so the owner can try again.
          const key = AGENT_REFUSALS[err?.code] || (/HTTP 409\b/.test(String(err?.message || '')) ? AGENT_REFUSALS.agent_busy : null);
          if (key) setError({ text: t(key), raw: err?.message || null });
          else fail(err, 'issue.agent.failed');
        }
      });
    }
  };

  // ---- resume: the lane-wide resume (X 402 credits). The re-fire may hit the same 402, so
  // a still-depleted answer is said inline, never flashed as success.
  if (type === 'resume') {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <ActionButton
          variant="subtle"
          size={size}
          icon={PlugZap}
          className={btnCls}
          labels={{ idle: label, loading: t('issue.fix.resuming'), success: t('issue.fix.resumed'), error: label }}
          quietError
          onAction={async () => {
            setError(null);
            try {
              const r = await resumeLane(lane);
              refresh();
              queryClient.invalidateQueries({ queryKey: ['health'] });
              if (r?.stillDepleted) {
                setError({ text: t('postDetail.resume.stillDepleted'), raw: null });
                throw { canceled: true };
              }
            } catch (err) {
              fail(err);
              throw err;
            }
          }}
        />
        <ActionError error={error} className="w-full" />
      </div>
    );
  }

  // ---- manual: X refuses this through its API. Copy the text and open the thread, then
  // record it as posted. The post detail passes its own hand-off; otherwise this one.
  if (type === 'manual') {
    const handOff = onHandOff || (async () => {
      const text = effectiveLaneText(post, lane) || String(post?.caption || '').trim();
      if (text && navigator.clipboard) await navigator.clipboard.writeText(text);
      const target = post?.radarReplyTo?.url || post?.externalUrl || null;
      if (target) window.open(target, '_blank', 'noopener,noreferrer');
      setHandedOffLocal(true);
    });
    const mark = onMarkPosted || (async () => {
      const url = await prompt({ title: t('postDetail.markPosted.title'), body: t('postDetail.markPosted.body', { id: post.id }), placeholder: t('postDetail.markPosted.placeholder') });
      if (url === null) throw { canceled: true };
      const multi = (post.platforms?.length || 0) > 1;
      await markPosted(post.campaign, post.id, url.trim() || undefined, multi ? lane : undefined, ...scope);
      refresh();
    });
    return (
      <div className="flex flex-wrap items-center gap-2">
        {handedOff ? (
          <ActionButton key="manual-done" variant="manual" size={size} icon={CheckCheck} className={btnCls} labels={{ idle: t('postDetail.handOff.markIdle'), loading: t('postDetail.action.markLoading'), success: t('postDetail.action.markSuccess'), error: t('postDetail.error.generic') }} onAction={async () => { try { await mark(); } catch (err) { if (!onMarkPosted) fail(err); throw err; } }} />
        ) : (
          <ActionButton key="manual-copy" variant="manual" size={size} icon={ClipboardCopy} className={btnCls} labels={{ idle: label, loading: t('postDetail.handOff.copyLoading'), success: t('postDetail.handOff.copySuccess'), error: t('postDetail.error.generic') }} onAction={async () => { try { await handOff(); } catch (err) { if (!onHandOff) fail(err); throw err; } }} />
        )}
        <ActionError error={error} className="w-full" />
      </div>
    );
  }

  // ---- discard: the Radar reply's thread is gone; the draft has nowhere to go.
  if (type === 'discard') {
    const discard = onDiscard || (async () => {
      const ok = await confirm({ title: t('postDetail.delete.title'), body: t('postDetail.delete.body', { id: post.id }), confirmLabel: t('postDetail.delete.confirmLabel'), danger: true });
      if (!ok) throw { canceled: true };
      await deletePost(post.campaign, post.id, false, ...scope);
      refresh();
    });
    return (
      <div className="flex flex-wrap items-center gap-2">
        <ActionButton
          variant="danger"
          size={size}
          icon={Trash2}
          className={btnCls}
          labels={{ idle: label, loading: t('postDetail.failure.discardLoading'), success: t('postDetail.failure.discardSuccess'), error: t('postDetail.error.generic') }}
          onAction={async () => { try { await discard(); } catch (err) { if (!onDiscard) fail(err); throw err; } }}
        />
        <ActionError error={error} className="w-full" />
      </div>
    );
  }

  // ---- connect / reconnect / cloud / edit: one button, plus "Open in editor" as the second
  // way when the agent is the first.
  const busy = working || jobRunning;
  const disabled = busy || (type === 'cloud' && typeof onNavigate !== 'function')
    || ((type === 'connect' || type === 'reconnect') && !inPlaceConnectLane(lane) && typeof onNavigate !== 'function')
    || (type === 'edit' && !agent && typeof onEdit !== 'function');
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        size={size}
        variant={btnVariant}
        className={btnCls}
        onClick={onClick}
        disabled={disabled}
        aria-busy={busy || undefined}
        aria-label={busy ? undefined : aria}
      >
        {busy ? <Loader2 size={13} className="motion-safe:animate-spin" aria-hidden="true" /> : <Icon size={13} aria-hidden="true" />}
        {busy ? t('issue.agent.working') : label}
      </Button>
      {agent && typeof onEdit === 'function' ? (
        <Button size={size} variant="ghost" className={TAP_TARGET} onClick={() => onEdit(post)}>
          <Pencil size={13} aria-hidden="true" />
          {t('issue.fix.edit')}
        </Button>
      ) : null}
      {note && !job ? <p role="status" className="w-full text-[11px] text-zinc-600 dark:text-zinc-300">{note}</p> : null}
      {jobLine?.tone === 'ok' ? <p role="status" className="w-full text-[11px] text-zinc-600 dark:text-zinc-300">{jobLine.text}</p> : null}
      {jobLine?.tone === 'err' && !error ? <ActionError error={{ text: jobLine.text, raw: jobLine.raw }} className="w-full" /> : null}
      <ActionError error={error} className="w-full" />
      {connectOpen ? (
        <ConnectModal lane={lane} clientId={clientId} onClose={() => setConnectOpen(false)} onConnected={onConnected} />
      ) : null}
    </div>
  );
}
