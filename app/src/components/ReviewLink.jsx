// Client review link operator UI (spec 48 R10, W5). Three operator-facing pieces
// live here so all review-link chrome sits in one module the Clients page, the
// Freigaben queue and PostDetail all import from:
//
//   InviteReviewerDialog (V5) - name in, the ONE-TIME full link out. Default export.
//   ReviewSection        (V4) - reviewers list + revoke + the two review toggles +
//                               the optional contact field with its gentle nudge.
//   ReviewStatusChip     (V6) - the awaiting/signed sign-off chip for a post card.
//
// The reviewer PAGE itself (V1/V2/V3) is a separate bundle owned by another agent;
// nothing here renders it. Every string routes through t() (copy guard).
import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { UserPlus, Copy, Check, Ban, Clock, ShieldCheck, Loader2, Send, Info } from 'lucide-react';
import { useReviewers, createReviewer, revokeReviewer, useConfig, saveConfig } from '../lib/api.js';
import { useT } from '../lib/i18n.js';
import { INNER_SURFACE, EYEBROW } from './ui.jsx';
import { Modal, CloseButton } from './ui.jsx';
import { ToggleRow } from './ui/Switch.jsx';
import { Select } from './ui/Select.jsx';
import Input from './ui/Input.jsx';
import { useConfirm } from './ui/confirm.jsx';

const BTN = 'rounded-xl px-3 py-2 text-sm font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-60';
const BTN_BRAND = `${BTN} bg-brand text-white dark:bg-brand-light dark:text-zinc-900`;
const BTN_GHOST = `${BTN} text-zinc-600 hover:bg-zinc-200/60 dark:text-zinc-300 dark:hover:bg-zinc-700/60`;

// The default review config, read from posting.review or filled in. A per-client
// object under config.posting so it rides the SAME config_set path every other
// posting key uses (no bespoke store).
const DEFAULT_REVIEW = { required: false, hosted: false, contact: null };
function readReview(configData) {
  const r = configData?.posting?.review;
  return { ...DEFAULT_REVIEW, ...(r && typeof r === 'object' ? r : {}) };
}

// Compose the full one-time link. The mint response carries the token exactly once;
// the twins MAY also return a fully-composed reviewUrl (recommended, since only the
// server knows the real PENDPOST_REVIEW_HOST/PORT). Fall back to the documented
// loopback default so the operator always has SOMETHING to copy. Built in JS (not
// JSX) so the URL never reaches a screen as an un-translated literal.
function reviewLinkFrom(res) {
  if (res?.reviewUrl) return res.reviewUrl;
  if (res?.link) return res.link;
  return `http://127.0.0.1:8091/review/${res?.token || ''}`;
}

const EXPIRY_CHOICES = ['none', '7', '30', '90'];
function expiresAtFor(choice) {
  if (choice === 'none') return undefined;
  const days = Number(choice);
  if (!Number.isFinite(days) || days <= 0) return undefined;
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

// A gentle, dismissible nudge shared by V4 and V5: encourage a contact email so a
// dead link can point the client back to the operator. NEVER a gate (O4).
function ContactNudge({ onDismiss }) {
  const t = useT();
  return (
    <div className="flex items-start gap-2 rounded-xl bg-brand/5 p-2.5 text-[11px] text-zinc-600 ring-1 ring-brand/15 dark:text-zinc-300">
      <Info size={13} className="mt-0.5 shrink-0 text-brand dark:text-brand-light" aria-hidden="true" />
      <p className="min-w-0 flex-1">{t('review.contact.nudge')}</p>
      {onDismiss ? (
        <button
          type="button"
          onClick={onDismiss}
          className="shrink-0 rounded font-bold text-brand underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-brand-light"
        >
          {t('review.contact.nudgeDismiss')}
        </button>
      ) : null}
    </div>
  );
}

// V5: the invite-reviewer dialog. Two phases in one dialog: FORM (name + optional
// advanced expiry) then LINK (the one-time full URL + copy + the "shown once" note).
// A failed create (e.g. duplicate name) NEVER destroys the typed name or the chosen
// expiry - the inline error sits on the field and Create stays enabled.
export default function InviteReviewerDialog({ clientId, clientName, hasContact = false, onClose, onCreated }) {
  const t = useT();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [expiry, setExpiry] = useState('none');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [minted, setMinted] = useState(null); // { link } once the link phase is reached
  const [copied, setCopied] = useState(false);
  const [nudgeDismissed, setNudgeDismissed] = useState(false);

  const submit = async (ev) => {
    ev.preventDefault();
    setError(null);
    if (!name.trim()) {
      setError(t('review.invite.error.nameRequired'));
      return;
    }
    setBusy(true);
    try {
      const res = await createReviewer(clientId, { name: name.trim(), expiresAt: expiresAtFor(expiry) });
      queryClient.invalidateQueries({ queryKey: ['reviewers', clientId] });
      setMinted({ link: reviewLinkFrom(res) });
      onCreated?.();
    } catch (err) {
      // Duplicate name is the common case: keep every typed value, name the reason
      // inline, leave Create enabled so renaming-in-place is the recovery (matrix row 2).
      const dup = err.code === 'duplicate' || err.error === 'duplicate_name';
      setError(dup ? t('review.invite.error.duplicate', { client: clientName }) : (err.message || t('review.invite.error.generic')));
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(minted.link);
      }
      setCopied(true);
    } catch {
      // Clipboard denied (permissions / insecure context): the link stays selectable
      // on screen, so the operator can still copy it by hand. No error flash.
    }
  };

  return (
    <Modal onClose={onClose} label={t('review.invite.title', { client: clientName })} width="max-w-md">
      <div className="flex items-center justify-between">
        <h3 className="font-display text-sm font-bold">{t('review.invite.title', { client: clientName })}</h3>
        <CloseButton onClose={onClose} label={t('ui.action.close')} />
      </div>

      {minted ? (
        // LINK phase: shown exactly once. Closing discards the full token forever.
        <div className="space-y-3">
          <p className="text-xs text-zinc-600 dark:text-zinc-300">{t('review.invite.linkIntro')}</p>
          <div className={`flex items-center gap-2 rounded-xl p-2.5 ${INNER_SURFACE}`}>
            <code className="min-w-0 flex-1 select-all break-all font-mono text-[11px] text-zinc-700 dark:text-zinc-200">{minted.link}</code>
            <button type="button" onClick={copy} className={`flex shrink-0 items-center gap-1.5 ${BTN_BRAND}`}>
              {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
              {copied ? t('review.invite.copied') : t('review.invite.copy')}
            </button>
          </div>
          <p role="alert" className="text-[11px] font-bold text-zinc-700 dark:text-zinc-200">{t('review.invite.onceOnly')}</p>
          <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{t('review.invite.reachability')}</p>
          {!hasContact && !nudgeDismissed ? <ContactNudge onDismiss={() => setNudgeDismissed(true)} /> : null}
          <div className="flex justify-end">
            <button type="button" onClick={onClose} className={BTN_GHOST}>{t('review.invite.done')}</button>
          </div>
        </div>
      ) : (
        // FORM phase.
        <form onSubmit={submit} className="space-y-3">
          <Input
            label={t('review.invite.nameLabel')}
            value={name}
            onChange={(e) => setName(e.target.value)}
            error={error}
            autoFocus
          />
          {/* Expiry is an OPTIONAL advanced field defaulting to no expiry (O3):
              revoke is the kill path; expiry is a belt-and-braces opt-in. */}
          <label className="block space-y-1">
            <span className={EYEBROW}>{t('review.invite.expiryLabel')}</span>
            <Select
              value={expiry}
              onChange={(e) => setExpiry(e.target.value)}
              className="rounded-xl border-0 bg-zinc-100 px-3 py-2 text-sm dark:bg-zinc-800"
            >
              {EXPIRY_CHOICES.map((c) => (
                <option key={c} value={c}>{t(`review.invite.expiry.${c}`)}</option>
              ))}
            </Select>
          </label>
          <div className="flex items-center gap-2">
            <button type="submit" disabled={busy} aria-busy={busy} className={BTN_BRAND}>
              {busy ? <Loader2 size={14} className="mr-1.5 inline animate-spin" aria-hidden="true" /> : null}
              {t('review.invite.create')}
            </button>
            <button type="button" onClick={onClose} className={BTN_GHOST}>{t('review.invite.cancel')}</button>
          </div>
        </form>
      )}
    </Modal>
  );
}

// One reviewer row: name, the 4-char token tail, a status word, and the row action
// (Revoke while active, Invite again once expired). Non-color status (word + glyph).
function ReviewerRow({ clientId, reviewer, onInviteAgain }) {
  const t = useT();
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const status = reviewer.revoked ? 'revoked' : reviewer.expired ? 'expired' : 'active';

  const revoke = async () => {
    const ok = await confirm({
      title: t('review.revoke.title', { name: reviewer.name }),
      body: t('review.revoke.body'),
      confirmLabel: t('review.revoke.confirm'),
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      await revokeReviewer(clientId, reviewer.id);
      queryClient.invalidateQueries({ queryKey: ['reviewers', clientId] });
    } catch (err) {
      setError(err.message || t('review.revoke.error'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className={`flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl p-2.5 ${INNER_SURFACE}`}>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-bold">{reviewer.name}</span>
        <span className="block font-mono text-[10px] text-zinc-500 dark:text-zinc-400">{t('review.list.tail', { tail: reviewer.tokenTail })}</span>
      </span>
      <span className="inline-flex items-center gap-1.5 text-[11px] font-bold text-zinc-600 dark:text-zinc-300">
        {status === 'active' ? <Check size={12} aria-hidden="true" /> : status === 'expired' ? <Clock size={12} aria-hidden="true" /> : <Ban size={12} aria-hidden="true" />}
        {t(`review.status.${status}`)}
      </span>
      {status === 'active' ? (
        <button
          type="button"
          onClick={revoke}
          disabled={busy}
          className="rounded-lg px-2 py-1 text-xs font-bold text-red-600 transition hover:bg-red-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 disabled:opacity-60 dark:text-red-300"
        >
          {busy ? <Loader2 size={13} className="inline animate-spin" aria-hidden="true" /> : t('review.list.revoke')}
        </button>
      ) : status === 'expired' ? (
        <button
          type="button"
          onClick={onInviteAgain}
          className="rounded-lg px-2 py-1 text-xs font-bold text-brand transition hover:bg-brand/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-brand-light"
        >
          {t('review.list.inviteAgain')}
        </button>
      ) : null}
      {error ? <p role="alert" className="basis-full text-[11px] text-red-600 dark:text-red-300">{error}</p> : null}
    </li>
  );
}

// V4: the per-client review section. Renders for ONE client (the active project on
// the Clients page): its reviewers, the Invite action, the two owner toggles
// (review.required, review.hosted), and the optional contact field with its nudge.
// review.hosted is honestly fail-closed: enabling it refuses server-side
// (review_hosted_unavailable) until the cloud receiver ships (O6), and the toggle
// snaps back with the reason on screen.
export function ReviewSection({ clientId, clientName }) {
  const t = useT();
  const queryClient = useQueryClient();
  const { data: reviewersData, isLoading } = useReviewers(clientId, Boolean(clientId));
  const { data: configData } = useConfig(Boolean(clientId));
  const review = useMemo(() => readReview(configData), [configData]);
  const configRev = configData?.rev;

  const [inviteOpen, setInviteOpen] = useState(false);
  const [toggleError, setToggleError] = useState(null);
  const [busyKey, setBusyKey] = useState(null);
  const [contactDraft, setContactDraft] = useState(null); // null = mirror saved value
  const [contactSaving, setContactSaving] = useState(false);
  const [contactNudgeDismissed, setContactNudgeDismissed] = useState(false);

  const reviewers = reviewersData?.reviewers || [];
  const contactValue = contactDraft === null ? (review.contact || '') : contactDraft;
  const contactDirty = contactDraft !== null && (contactDraft.trim() || '') !== (review.contact || '');

  // Persist one review sub-key through the SAME config_set path posting uses. The
  // full review object is sent so a shallow merge still yields a complete record.
  const writeReview = async (patch) => {
    const next = { ...review, ...patch };
    await saveConfig(configRev, { posting: { review: next } });
    queryClient.invalidateQueries({ queryKey: ['config'] });
  };

  const onToggleRequired = async (nextVal) => {
    setToggleError(null);
    setBusyKey('required');
    try {
      await writeReview({ required: nextVal });
    } catch (err) {
      setToggleError(err.message || t('review.toggle.error'));
    } finally {
      setBusyKey(null);
    }
  };

  const onToggleHosted = async (nextVal) => {
    setToggleError(null);
    // Turning hosted ON is refused until the cloud receiver exists; surface the
    // refusal honestly and leave the toggle off (fail-closed, O6).
    setBusyKey('hosted');
    try {
      await writeReview({ hosted: nextVal });
    } catch (err) {
      const unavailable = err.code === 'review_hosted_unavailable' || err.error === 'review_hosted_unavailable';
      setToggleError(unavailable ? t('review.hosted.unavailable') : (err.message || t('review.toggle.error')));
    } finally {
      setBusyKey(null);
    }
  };

  const saveContact = async () => {
    setContactSaving(true);
    setToggleError(null);
    try {
      await writeReview({ contact: contactDraft.trim() || null });
      setContactDraft(null);
    } catch (err) {
      setToggleError(err.message || t('review.toggle.error'));
    } finally {
      setContactSaving(false);
    }
  };

  const hasContact = Boolean(review.contact);

  return (
    <section className={`space-y-4 rounded-2xl p-4 ${INNER_SURFACE}`} aria-label={t('review.section.aria', { client: clientName })}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="font-display text-sm font-bold">{t('review.section.title')}</h3>
          <p className="mt-0.5 text-[11px] text-zinc-500 dark:text-zinc-400">{t('review.section.subtitle', { client: clientName })}</p>
        </div>
        <button type="button" onClick={() => setInviteOpen(true)} className={`flex items-center gap-1.5 ${BTN_BRAND}`}>
          <UserPlus size={15} aria-hidden="true" />
          {t('review.section.invite')}
        </button>
      </div>

      {isLoading ? (
        <p className="text-xs text-zinc-500 dark:text-zinc-400">{t('review.list.loading')}</p>
      ) : reviewers.length === 0 ? (
        <p className="text-xs text-zinc-500 dark:text-zinc-400">{t('review.list.empty')}</p>
      ) : (
        <ul className="space-y-2">
          {reviewers.map((r) => (
            <ReviewerRow key={r.id} clientId={clientId} reviewer={r} onInviteAgain={() => setInviteOpen(true)} />
          ))}
        </ul>
      )}

      {/* The two mode toggles sit BELOW the reviewers list they configure (config
          never leads content, canon C7). */}
      <div className="space-y-2.5 border-t border-zinc-200/70 pt-3 dark:border-zinc-700/70">
        <ToggleRow
          label={t('review.required.label')}
          tip={t('review.required.tip')}
          checked={Boolean(review.required)}
          onChange={onToggleRequired}
          disabled={busyKey === 'required'}
        />
        <ToggleRow
          label={t('review.hosted.label')}
          tip={t('review.hosted.tip')}
          checked={Boolean(review.hosted)}
          onChange={onToggleHosted}
          disabled={busyKey === 'hosted'}
        />
        {toggleError ? <p role="alert" className="text-[11px] font-bold text-red-600 dark:text-red-300">{toggleError}</p> : null}
      </div>

      {/* Optional contact (O4): powers the reviewer page's dead-link mailto. Gentle,
          never a gate. The nudge shows only while no contact is set. */}
      <div className="space-y-2 border-t border-zinc-200/70 pt-3 dark:border-zinc-700/70">
        <Input
          label={t('review.contact.label')}
          type="email"
          value={contactValue}
          onChange={(e) => setContactDraft(e.target.value)}
          hint={t('review.contact.hint')}
        />
        {contactDirty ? (
          <button type="button" onClick={saveContact} disabled={contactSaving} className={BTN_BRAND}>
            {contactSaving ? <Loader2 size={14} className="mr-1.5 inline animate-spin" aria-hidden="true" /> : null}
            {t('review.contact.save')}
          </button>
        ) : null}
        {!hasContact && !contactDirty && !contactNudgeDismissed ? (
          <ContactNudge onDismiss={() => setContactNudgeDismissed(true)} />
        ) : null}
      </div>

      {inviteOpen ? (
        <InviteReviewerDialog
          clientId={clientId}
          clientName={clientName}
          hasContact={hasContact}
          onClose={() => setInviteOpen(false)}
        />
      ) : null}
    </section>
  );
}

// V6: the sign-off status chip for a post card / detail. Two states:
//   awaiting - operator sent for sign-off, client has not signed (reviewPending).
//   signed   - the reviewer signed off (approvalBy reviewer:*, not pending).
// Never rendered as overdue-red: a reviewPending post is "awaiting", not late.
// Returns null when neither state applies, so callers can render it unconditionally.
export function ReviewStatusChip({ post }) {
  const t = useT();
  if (!post) return null;
  const signedByReviewer = typeof post.approvalBy === 'string' && post.approvalBy.startsWith('reviewer:');
  if (post.reviewPending) {
    const name = reviewerName(post.approvalBy) || reviewerName(post.reviewReviewer);
    const days = Number.isFinite(post.reviewWaitingDays) ? post.reviewWaitingDays : null;
    const label = name && days != null
      ? t('review.chip.awaitingNamedDays', { name, days })
      : name
        ? t('review.chip.awaitingNamed', { name })
        : t('review.chip.awaiting');
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-bold text-amber-700 ring-1 ring-amber-500/30 dark:text-amber-300">
        <Send size={11} className="shrink-0" aria-hidden="true" />
        <span className="truncate">{label}</span>
      </span>
    );
  }
  if (signedByReviewer && post.approval === 'approved') {
    const name = reviewerName(post.approvalBy);
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-bold text-emerald-700 ring-1 ring-emerald-500/30 dark:text-emerald-300">
        <ShieldCheck size={11} className="shrink-0" aria-hidden="true" />
        <span className="truncate">{name ? t('review.chip.signedNamed', { name }) : t('review.chip.signed')}</span>
      </span>
    );
  }
  return null;
}

// reviewer:<clientId>/<reviewerId> -> a readable last segment for the chip. Not a
// display name (the GUI does not have the roster joined here), but enough to name
// who acts next. Returns null for a non-reviewer actor.
function reviewerName(actor) {
  if (typeof actor !== 'string' || !actor.startsWith('reviewer:')) return null;
  const slug = actor.split('/').pop();
  return slug || null;
}
