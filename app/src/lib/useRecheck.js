// The ONE contract every "Check again" / "Erneut prüfen" button keeps: a click always shows
// that it ran. Two things make that true even when the answer is fast and unchanged:
//
//   1. The busy state lasts at least MIN_BUSY_MS, so a 30 ms local answer still shows its
//      spinner long enough to be seen (a check that flickers reads as a check that did nothing).
//   2. When a check returns the SAME outcome as the one before (the same error sentence, the
//      same "not yet"), `again` carries a dated line ("Checked again at 14:02, no change.") so
//      the identical result is visibly a NEW result, not the old one left on screen.
//
// `run(fn)` awaits fn, holds the busy state for the rest of the minimum, then resolves fn's
// value (or rethrows its error). fn's return value is the OUTCOME the caller renders: null
// for success, or anything with a stable identity (a string, or an object with a `key` or a
// `text`). Only a non-null outcome equal to the previous one counts as a repeat.
//
// `recheckTiming.minBusyMs` is the minimum in one place; the test setup sets it to 0 so the
// suites that do not care about it stay fast, and the tests that do set it back.
import { useEffect, useRef, useState } from 'react';
import { useT } from './i18n.js';
import { fmtTime } from './format.js';

export const MIN_BUSY_MS = 600;
export const recheckTiming = { minBusyMs: MIN_BUSY_MS };

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// Resolve fn's result no sooner than the minimum busy time after the call started.
export async function withMinBusy(fn) {
  const started = Date.now();
  try {
    return await fn();
  } finally {
    const left = recheckTiming.minBusyMs - (Date.now() - started);
    if (left > 0) await sleep(left);
  }
}

const keyOf = (outcome) => {
  if (outcome == null) return null;
  if (typeof outcome === 'string') return outcome;
  if (typeof outcome.key === 'string') return outcome.key;
  if (typeof outcome.text === 'string') return outcome.text;
  try { return JSON.stringify(outcome); } catch { return null; }
};

export default function useRecheck() {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [again, setAgain] = useState('');
  const last = useRef(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const run = async (fn) => {
    setBusy(true);
    try {
      const outcome = await withMinBusy(fn);
      const key = keyOf(outcome);
      const repeated = key !== null && key === last.current;
      last.current = key;
      if (alive.current) setAgain(repeated ? t('recheck.again', { time: fmtTime(new Date()) }) : '');
      return outcome;
    } catch (err) {
      last.current = null;
      if (alive.current) setAgain('');
      throw err;
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  return { busy, again, run };
}
