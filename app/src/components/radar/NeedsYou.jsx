// NeedsYou - the "Needs you" strip above the Radar feed (spec 50 S3 + S4, P5a).
//
// The whole promise of "Respond for me" is that the owner stops doing the routine work and is
// left with three questions a week. This strip is where those three questions live, so its
// design bar is the opposite of a dashboard's: it must be EMPTY most days, and when it is not,
// each row must be resolvable in one tap or one line without leaving the page.
//
// Consequences, each deliberate:
//   - Nothing renders at all when there is nothing open (S3 "empty: strip not rendered"). No
//     "All clear" card: a permanent widget saying zero would train the owner to stop looking.
//   - Five rows collapsed, "and N more" expands IN PLACE (row 8e3). Never a page, never a modal.
//   - One primary per row, chosen by kind, top-right; every secondary (Skip, Edit, Copy draft)
//     lives in the overflow to its left, exactly as the signal rows below do.
//   - The reason line is ONE line, and which line it is depends on the kind. That line is the
//     row's whole justification for existing, so it is never behind a hover or a disclosure.
//   - A resolved row collapses to one confirmation line for five seconds and then leaves, so
//     the owner sees their action land instead of a row vanishing under their finger.
//   - A send error KEEPS what they typed. Losing an answer to a failed request would be the
//     one unforgivable bug on this surface.
import { useState, useMemo, useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Check, Copy, Loader2, RefreshCw, Send, SkipForward, Pencil, ExternalLink, Radio } from 'lucide-react';
import { useEngageAsks, useActiveClient, engageAnswer, engageConfirmAsk, engageDismiss, engageProbe, radarMarkCopyPosted, errText } from '../../lib/api.js';
import { INNER_SURFACE, Skeleton } from '../ui.jsx';
import { BTN_PRIMARY, BTN_QUIET, PILL_BASE, PILL_TONES, TAP_TARGET } from '../ui/recipes.js';
import { FIELD, FIELD_MULTILINE } from '../ui/tokens.js';
import { Tip } from '../ui/Tooltip.jsx';
import { SOURCE_META, RowMenu, sourceLabel } from './RadarFeed.jsx';

// Collapsed height of the strip, in rows (row 8e3: never more than five without asking).
const VISIBLE = 5;
// How long a resolved row stays on screen before it leaves (S4 "for 5s, then leaves").
const RESOLVED_MS = 5000;

// The ONE line that says why this row needs a human, per kind. Everything else on the row is
// context; this is the ask itself, which is why it is plain visible text and never a tooltip.
//
// The two LANE asks borrow the ledger's own lines, key for key (autonomy.engage.lane.notLoggedIn /
// .wrongAccount). They used to say strictly less here - "Not logged in on Quora" against the
// ledger's "Not logged in · Log in to Quora in Chrome, then [Check again]" - so the surface that
// interrupts you named the problem while the surface you had to go looking for named the fix.
// Both now end on the same "then", and the row's own primary IS the Check again they point at.
function reasonFor(ask, t, clientName) {
  const platform = sourceLabel(t, ask.lane);
  if (ask.kind === 'question') return t('radar.ask.reason.question', { question: ask.question });
  if (ask.kind === 'confirm') return t('radar.ask.reason.confirm', { reason: ask.reasonLine });
  if (ask.kind === 'handoff') return t('radar.ask.reason.handoff', { platform, reason: ask.reasonLine });
  if (ask.kind === 'login') return t('autonomy.engage.lane.notLoggedIn', { platform });
  return t('autonomy.engage.lane.wrongAccount', { other: ask.reasonLine || '?', platform, client: clientName });
}

// The agent's words, shown to a human. The label sits on its OWN line rather than inline: the
// canon forbids recolouring one word inside a line of copy, and a label that has to be told
// apart from the sentence it introduces has already failed. Same anatomy as the feed's
// "Suggested reply" block one screen below, so the two surfaces read as one product.
function TextBlock({ label, text }) {
  return (
    <div className="rounded-lg bg-brand/5 px-2.5 py-2 ring-1 ring-brand/15 dark:bg-brand/10">
      <p className="text-[11px] font-bold text-brand dark:text-brand-light">{label}</p>
      <p className="mt-0.5 whitespace-pre-wrap text-xs text-zinc-700 dark:text-zinc-200">{text}</p>
    </div>
  );
}

// One ask. The row owns its own text, its own busy flag and its own error, because a failure on
// one row must never blank another one's half-typed answer.
function AskRow({ ask, resolvedLine, onResolved, clientName, t }) {
  const queryClient = useQueryClient();
  const [answer, setAnswer] = useState('');
  const [text, setText] = useState(ask.finalText || ask.draft || '');
  const [url, setUrl] = useState('');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(false);

  const meta = SOURCE_META[ask.lane] || { Icon: Radio, color: '' };
  const Glyph = meta.Icon;
  const platform = sourceLabel(t, ask.lane);
  const sig = ask.signal || null;

  // The resolved state: one line, no controls. It replaces the row in place rather than
  // removing it, so the owner's eye lands on the confirmation where the row was.
  if (resolvedLine) {
    return (
      <li className="flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs text-emerald-700 ring-1 ring-emerald-500/25 dark:text-emerald-300">
        <Check size={13} aria-hidden="true" />
        <span>{resolvedLine}</span>
      </li>
    );
  }

  // Every primary funnels through here: one busy flag, one error slot, one refresh of the two
  // reads a resolution changes (the strip itself, and the feed row the ask belongs to).
  const run = async (fn, { resolveWith = null, errorKey = 'radar.ask.error.send' } = {}) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fn();
      queryClient.invalidateQueries({ queryKey: ['engage-asks'] });
      queryClient.invalidateQueries({ queryKey: ['radar'] });
      queryClient.invalidateQueries({ queryKey: ['engage'] });
      const line = typeof resolveWith === 'function' ? resolveWith(res) : resolveWith;
      // `false` means "this row is done, but say nothing about it": the refetch removes it and
      // whatever replaced it speaks for itself.
      onResolved(ask, line === false ? null : line, line !== false);
    } catch (err) {
      // The typed text is NOT cleared: it lives in this component's state and the row stays
      // mounted, so Retry means "send the same words again", not "type it all again".
      setError(t(errorKey, { reason: errText(err, t, 'radar.error.save'), platform }));
      setBusy(false);
    }
  };

  // DEVIATION from S4, recorded: the spec's confirmation reads "Sent · posting at 14:20", but
  // none of these verbs can name a time - the row is queued, and the PACER decides its slot on
  // a later tick. So the line says "Sent" and stops there rather than inventing a clock.
  const sentLine = () => t('radar.ask.resolved.now');

  // Exactly one primary, resolved by kind (canon #4). Disabled states are real states here:
  // Send is dead until there is an answer to send, and that is the whole gate on it.
  const primary = (() => {
    if (ask.kind === 'question') {
      return {
        label: t('radar.ask.send'),
        Icon: Send,
        disabled: !answer.trim(),
        // A sensitive answer does NOT post: it comes back as a fresh confirm ask carrying its
        // own reason line. That new row IS the feedback, so this one leaves without claiming
        // it was sent - a "Sent" line over a reply that is still being held would be a lie.
        onClick: () => run(() => engageAnswer(ask.id, answer.trim()), {
          resolveWith: (res) => (res && res.confirm ? false : sentLine()),
        }),
      };
    }
    if (ask.kind === 'confirm') {
      return {
        label: t('radar.ask.post'),
        Icon: Send,
        disabled: !text.trim(),
        onClick: () => run(() => engageConfirmAsk(ask.id, text.trim() === (ask.finalText || '') ? null : text.trim()), { resolveWith: sentLine() }),
      };
    }
    if (ask.kind === 'handoff') {
      return {
        label: t('radar.ask.posted'),
        Icon: Check,
        disabled: !sig,
        onClick: () => run(() => radarMarkCopyPosted(sig.source, sig.externalId, url.trim() || undefined), { resolveWith: sentLine() }),
      };
    }
    // login / switchAccount: the ONE control is another look at the platform. It resolves the
    // row only when the check passes - a check that failed again says so and leaves the row.
    return {
      label: t('radar.ask.checkAgain'),
      Icon: RefreshCw,
      disabled: false,
      onClick: async () => {
        setBusy(true);
        setError(null);
        try {
          const res = await engageProbe(ask.lane);
          queryClient.invalidateQueries({ queryKey: ['engage-asks'] });
          queryClient.invalidateQueries({ queryKey: ['engage'] });
          if (res && res.usable) onResolved(ask, sentLine());
          else { setError(t('radar.ask.error.check', { platform })); setBusy(false); }
        } catch (err) {
          setError(t('radar.ask.error.send', { reason: errText(err, t, 'radar.error.save'), platform }));
          setBusy(false);
        }
      },
    };
  })();

  const PrimaryIcon = primary.Icon;
  const copyDraft = async () => {
    try { await navigator.clipboard.writeText(ask.draft || ask.finalText || ''); } catch { /* copy blocked - the text is on screen either way */ }
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  };
  const menuItems = [
    ...(['question', 'confirm'].includes(ask.kind)
      // DEVIATION from S4, recorded: for a `confirm` this edits the text that will be posted,
      // which is what the spec describes. A `question` has no server field for an edited
      // draft (engage_answer takes the ANSWER, and the agent writes the reply from it), so
      // here Edit opens the answer box as a multi-line editor instead of inventing a control
      // whose edit would be silently discarded.
      ? [{ key: 'edit', label: t('radar.ask.edit'), Icon: Pencil, onClick: () => setEditing((v) => !v) }]
      : []),
    ...(ask.kind === 'handoff'
      ? [{ key: 'copy', label: copied ? t('radar.ask.copied') : t('radar.ask.copy'), Icon: Copy, onClick: copyDraft }]
      : []),
    { key: 'skip', label: t('radar.ask.skip'), Icon: SkipForward, onClick: () => run(() => engageDismiss(ask.id), { resolveWith: t('radar.ask.skip') }) },
  ];

  return (
    <li className="rounded-xl p-3 ring-1 ring-zinc-900/5 transition hover:bg-zinc-900/[0.02] dark:ring-white/10 dark:hover:bg-white/[0.03]">
      <div className="flex items-start gap-2">
        <Glyph size={15} className={`mt-0.5 shrink-0 ${meta.color}`} aria-hidden="true" />
        <div className="min-w-0 flex-1 space-y-1.5">
          {/* WHO and WHERE, then the thread itself as the link out - the same three facts a
              signal row leads with, so the strip and the feed read as one surface. */}
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs">
            <span className="font-semibold text-zinc-700 dark:text-zinc-200">{sig?.author || platform}</span>
            {sig?.community ? <span className="text-zinc-500 dark:text-zinc-400">· {sig.community}</span> : null}
            {ask.urgent ? (
              <span className={`${PILL_BASE} ${PILL_TONES.attention}`}>
                <AlertTriangle size={11} aria-hidden="true" />{t('radar.ask.urgent')}
              </span>
            ) : null}
          </div>
          {sig?.text ? (
            sig.url ? (
              <a href={sig.url} target="_blank" rel="noreferrer" className={`flex items-start gap-1 text-xs text-zinc-600 underline-offset-2 hover:underline dark:text-zinc-300 ${TAP_TARGET}`}>
                <span className="line-clamp-2">{sig.text}</span>
                <ExternalLink size={11} className="mt-0.5 shrink-0" aria-hidden="true" />
                <span className="sr-only">{t('radar.ask.openThread')}</span>
              </a>
            ) : <p className="line-clamp-2 text-xs text-zinc-600 dark:text-zinc-300">{sig.text}</p>
          ) : null}
          {/* The draft, when there is one to look at. A confirm shows it as the editable text
              instead, below, because for a confirm the draft IS the decision. */}
          {ask.draft && ask.kind !== 'confirm' ? <TextBlock label={t('radar.ask.draft')} text={ask.draft} /> : null}
          {/* THE one line that says why this needs a human. */}
          <p className="text-xs font-semibold text-zinc-700 dark:text-zinc-200">{reasonFor(ask, t, clientName)}</p>

          {ask.kind === 'question' ? (
            <label className="block space-y-1">
              <span className="text-[11px] text-zinc-600 dark:text-zinc-400">{t('radar.ask.answer.label')}</span>
              {editing ? (
                <textarea rows={3} value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder={t('radar.ask.answer.placeholder')} className={`${FIELD_MULTILINE} w-full`} />
              ) : (
                <input type="text" value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder={t('radar.ask.answer.placeholder')} className={`${FIELD} w-full`} />
              )}
            </label>
          ) : null}

          {ask.kind === 'confirm' ? (
            editing ? (
              <label className="block space-y-1">
                <span className="text-[11px] text-zinc-600 dark:text-zinc-400">{t('radar.ask.text.label')}</span>
                <textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} className={`${FIELD_MULTILINE} w-full`} />
              </label>
            ) : (
              <TextBlock label={t('radar.ask.text.label')} text={text} />
            )
          ) : null}

          {ask.kind === 'handoff' ? (
            <label className="block space-y-1">
              <span className="text-[11px] text-zinc-600 dark:text-zinc-400">{t('radar.copyPosted.linkLabel')}</span>
              <input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder={t('radar.copyPosted.linkPlaceholder')} className={`${FIELD} w-full`} />
            </label>
          ) : null}

          {error ? (
            <p role="alert" className="flex flex-wrap items-center gap-1.5 text-xs text-red-600 dark:text-red-400">
              <span>{error}</span>
              <button type="button" onClick={primary.onClick} className={`font-bold underline underline-offset-2 ${TAP_TARGET}`}>{t('radar.ask.error.retry')}</button>
            </p>
          ) : null}
        </div>
        {/* The overflow sits to the LEFT of the primary (S4), so the one thing this row is for
            is the last thing the eye and the tab order reach. */}
        <div className="flex shrink-0 items-center gap-1">
          <RowMenu showDismiss={false} extraItems={menuItems} t={t} />
          <Tip label={primary.label}>
            <button type="button" onClick={primary.onClick} disabled={busy || primary.disabled} className={`${BTN_PRIMARY} ${TAP_TARGET}`}>
              {busy ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <PrimaryIcon size={13} aria-hidden="true" />}
              {busy ? t('radar.ask.sending') : primary.label}
            </button>
          </Tip>
        </div>
      </div>
    </li>
  );
}

/**
 * The strip. Renders NOTHING when there is nothing open, which is the state it is designed to
 * spend most of its life in.
 */
export default function NeedsYou({ enabled = true, t }) {
  const { data, isLoading, isError, refetch } = useEngageAsks(enabled);
  const { activeClient } = useActiveClient();
  // The same name the ledger's wrong-account line uses, so "switch to the X account" names the
  // same X on both surfaces.
  const clientName = activeClient?.displayName || activeClient?.id || t('clientSwitcher.noClient');
  const [expanded, setExpanded] = useState(false);
  // id -> { ask, line }: a row the owner just resolved, kept on screen for five seconds so the
  // action visibly lands. Cleared by the timer, not by the refetch.
  const [resolved, setResolved] = useState({});
  const timers = useRef([]);
  useEffect(() => () => { timers.current.forEach(clearTimeout); }, []);

  const open = useMemo(() => (Array.isArray(data?.asks) ? data.asks.filter((a) => a && a.status === 'open') : []), [data]);
  const rows = useMemo(() => {
    const live = open.filter((a) => !resolved[a.id]);
    // A row the refetch has already dropped still shows its confirmation until its timer fires.
    const held = Object.values(resolved).map((r) => r.ask);
    return [...live, ...held];
  }, [open, resolved]);

  const onResolved = (ask, line, show = true) => {
    if (!show) return; // resolved, but the refetch is the only thing that should speak
    setResolved((prev) => ({ ...prev, [ask.id]: { ask, line: line || t('radar.ask.resolved.now') } }));
    const id = setTimeout(() => setResolved((prev) => {
      const next = { ...prev };
      delete next[ask.id];
      return next;
    }), RESOLVED_MS);
    timers.current.push(id);
  };

  if (!enabled) return null;
  if (isLoading) {
    return (
      <div className={`space-y-2 rounded-xl p-3 ${INNER_SURFACE}`}>
        <Skeleton className="h-4 w-32 rounded" />
        <Skeleton className="h-14 rounded-xl" />
        <Skeleton className="h-14 rounded-xl" />
        <Skeleton className="h-14 rounded-xl" />
      </div>
    );
  }
  if (isError) {
    return (
      <p role="alert" className="flex flex-wrap items-center gap-1.5 text-xs text-red-600 dark:text-red-400">
        <AlertTriangle size={12} aria-hidden="true" />
        <span>{t('radar.needsYou.error')}</span>
        <button type="button" onClick={() => refetch()} className={`font-bold underline underline-offset-2 ${TAP_TARGET}`}>{t('radar.needsYou.retry')}</button>
      </p>
    );
  }
  // S3: empty means the strip does not exist. No "all clear" card to learn to ignore.
  if (!rows.length) return null;

  const visible = expanded ? rows : rows.slice(0, VISIBLE);
  const hidden = rows.length - visible.length;
  return (
    <section aria-label={t('radar.needsYou.aria')} className={`space-y-2 rounded-xl p-3 ${INNER_SURFACE}`}>
      {/* No glyph: the three words say it. A clock would claim this is about time and an inbox
          would claim it is a queue - it is neither, it is the short list of things only a
          person can settle. */}
      <h3 className="text-sm font-bold">{t('radar.needsYou.title', { n: open.length })}</h3>
      <ol className="space-y-2">
        {visible.map((ask) => (
          <AskRow key={ask.id} ask={ask} resolvedLine={resolved[ask.id]?.line || null} onResolved={onResolved} clientName={clientName} t={t} />
        ))}
      </ol>
      {hidden > 0 ? (
        // In place, never a page (row 8e3). One control, and it says how many it is hiding.
        <button type="button" onClick={() => setExpanded(true)} aria-expanded={expanded} className={`${BTN_QUIET} ${TAP_TARGET}`}>
          {t('radar.needsYou.more', { n: hidden })}
        </button>
      ) : null}
    </section>
  );
}
