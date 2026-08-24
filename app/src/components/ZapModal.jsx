import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Zap, AlertCircle, CheckCircle2, ShieldAlert } from 'lucide-react';
import { sendZap } from '../lib/api.js';
import { Modal, INNER_SURFACE, EYEBROW, PLATFORM_META, DISABLED_PRIMARY, FIELD } from './ui.jsx';
import { useT } from '../lib/i18n.js';

// Nostr zaps (spec 20, the MONEY path). A lightweight modal opened from the ⋯ menu
// on a POSTED nostr note: enter an amount (sats) + an optional comment, submit, and
// the send_zap write spends REAL sats via NWC. Confirm is INTRINSIC to the submit
// (the human clicking Send IS the confirmation). Degrades honestly (P9): no NWC
// wallet -> the "connect a Lightning wallet" hint, never a dead-end error. On success
// it invalidates ['plans'] + ['insights'] so the next sweep shows the sats increment.

export default function ZapModal({ campaign, postId, onClose }) {
  const t = useT();
  const queryClient = useQueryClient();
  const [amount, setAmount] = useState('21');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null); // { sats } once a zap lands
  const [notConfigured, setNotConfigured] = useState(false);
  const [error, setError] = useState(null);

  const sats = Number(amount);
  const valid = Number.isInteger(sats) && sats > 0;
  const meta = PLATFORM_META.nostr;
  const ZapIcon = meta?.Icon || Zap;

  const onSubmit = async (e) => {
    e.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    setNotConfigured(false);
    setResult(null);
    try {
      // A single send - the engine pays once, never retries (no double-charge).
      const res = await sendZap(campaign, postId, { amount: sats, comment: comment.trim() || undefined });
      setResult({ sats: res?.sats ?? sats });
      queryClient.invalidateQueries({ queryKey: ['plans'] });
      queryClient.invalidateQueries({ queryKey: ['insights'] });
    } catch (err) {
      if (err?.code === 'not_configured') setNotConfigured(true);
      else setError(err?.message || t('zap.error'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} label={t('postDetail.action.sendZap')} width="max-w-sm">
      <h2 className="flex items-center gap-2 text-sm font-bold text-zinc-800 dark:text-zinc-100">
        <ZapIcon size={15} className={meta?.color} aria-hidden="true" />
        {t('postDetail.action.sendZap')}
      </h2>

      {result ? (
        <p role="status" className="flex items-center gap-1.5 rounded-xl px-3 py-2.5 text-sm text-emerald-600 dark:text-emerald-300">
          <CheckCircle2 size={14} aria-hidden="true" /> {t('zap.success', { sats: result.sats })}
        </p>
      ) : notConfigured ? (
        <div className={`space-y-1 rounded-xl px-3 py-2.5 text-xs ${INNER_SURFACE}`}>
          <p className="flex items-center gap-1.5 font-bold text-amber-700 dark:text-amber-300">
            <ShieldAlert size={13} aria-hidden="true" /> {t('zap.notConfigured')}
          </p>
        </div>
      ) : (
        <form onSubmit={onSubmit} className="space-y-3">
          <div className="space-y-1">
            <label htmlFor="zap-amount" className={EYEBROW}>{t('zap.modal.amount')}</label>
            <input
              id="zap-amount"
              type="number"
              min="1"
              step="1"
              inputMode="numeric"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className={`${FIELD} w-24`}
            />
          </div>
          <div className="space-y-1">
            <label htmlFor="zap-comment" className={EYEBROW}>{t('zap.modal.comment')}</label>
            <input
              id="zap-comment"
              type="text"
              maxLength={280}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              className={`${FIELD} w-full`}
            />
          </div>
          {error ? (
            <p role="alert" className="flex items-center gap-1.5 text-[11px] text-red-600 dark:text-red-300">
              <AlertCircle size={11} aria-hidden="true" /> {error}
            </p>
          ) : null}
          <button
            type="submit"
            disabled={!valid || busy}
            className={`inline-flex w-full items-center justify-center gap-1.5 rounded-xl bg-brand px-2.5 py-2 text-xs font-bold text-white transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand ${DISABLED_PRIMARY}`}
          >
            <Zap size={13} aria-hidden="true" /> {busy ? t('postDetail.action.saveLoading') : t('zap.modal.submit')}
          </button>
        </form>
      )}
    </Modal>
  );
}
