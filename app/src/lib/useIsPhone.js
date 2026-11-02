// useIsPhone - true below md (768px), the width where the planner's tray folds and the List's
// bulk bar floats at the bottom of the screen (planner bulk round 2). Reads matchMedia and follows
// it live; false where there is no matchMedia (a test DOM), so tests see the desktop layout.
import { useEffect, useState } from 'react';

const QUERY = '(max-width: 767px)';

export function useIsPhone() {
  const [phone, setPhone] = useState(() => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(QUERY).matches);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    const mq = window.matchMedia(QUERY);
    const on = () => setPhone(mq.matches);
    on();
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, []);
  return phone;
}
