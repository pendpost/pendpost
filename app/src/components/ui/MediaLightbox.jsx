// Full-viewport viewer for a post's media. A video reuses MediaPlayer in
// fullscreen mode (same auto-hiding controls, just larger); a still image renders
// at full size. Portaled to <body> so its `fixed inset-0` always resolves against
// the viewport, and it sits at z-[80] - above the SlideOver (z-40) it opens from.
//
// Escape: handled on the focused panel's own onKeyDown with stopPropagation, NOT
// via useSlideOver. useSlideOver attaches a DOCUMENT-level Escape listener, and
// stopPropagation between two document listeners doesn't stop the other - so
// reusing it would close BOTH this viewer and the post-detail SlideOver beneath.
// Catching Escape on the inner panel stops it bubbling to that document listener.
// Album mode (spec 05): `count`/`index`/`onIndex` are OPTIONAL, so every
// single-source caller renders byte-identically and none had to change. The viewer
// stays STATELESS about which slide is showing - the caller owns the index and just
// hands down a new `src` - so there is exactly one source of truth for the position
// and no chance of the inline pager and the viewer disagreeing.
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X, ChevronLeft, ChevronRight } from 'lucide-react';
import { useT } from '../../lib/i18n.js';
import { MediaPlayer } from './MediaPlayer.jsx';
import { Tip } from './Tooltip.jsx';

// Edge control shared by both arrows: 44px (WCAG 2.5.5) and vertically centred at the
// viewport edge, the conventional gallery position.
const STEP_BTN = 'absolute top-1/2 grid h-11 w-11 -translate-y-1/2 place-items-center rounded-full bg-black/55 text-white backdrop-blur transition hover:bg-black/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70';

export function MediaLightbox({ kind, src, poster, startAt = 0, count = 1, index = 0, onIndex, onClose }) {
  const t = useT();
  const panelRef = useRef(null);
  const restoreRef = useRef(null);
  const fsRef = useRef(null); // the viewer's own <video>, read on close to hand the playhead back
  // Album mode needs BOTH a real count and a handler: a caller that passes neither
  // gets the exact pre-album behaviour, including no arrow-key capture.
  const isAlbum = count > 1 && typeof onIndex === 'function';
  // Wrap at both ends rather than disabling the arrows. A reviewer checking every
  // slide is never stuck on the last one, and it removes a whole disabled state from
  // the control instead of adding one.
  const step = (delta) => onIndex((index + delta + count) % count);

  useEffect(() => {
    restoreRef.current = document.activeElement;
    panelRef.current?.focus();
    return () => restoreRef.current?.focus?.();
  }, []);

  // Close handing the inline player the viewer's current playhead (video only).
  const close = () => onClose(fsRef.current?.currentTime);

  const onKeyDown = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
      return;
    }
    // Same stopPropagation reason as Escape above: without it the arrow key also
    // reaches the SlideOver beneath, whose own key handling would act on it.
    if (isAlbum && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
      e.stopPropagation();
      e.preventDefault();
      step(e.key === 'ArrowRight' ? 1 : -1);
      return;
    }
    if (e.key === 'Tab') {
      // Minimal trap: keep Tab within the viewer (it covers the whole screen).
      const nodes = panelRef.current?.querySelectorAll('button, [href], input, [tabindex]:not([tabindex="-1"])');
      const list = nodes ? Array.from(nodes).filter((n) => n.offsetParent !== null) : [];
      if (!list.length) return;
      const first = list[0];
      const last = list[list.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-[80] grid place-items-center p-4" role="dialog" aria-modal="true" aria-label={t('ui.player.fullscreenLabel')}>
      <button type="button" aria-label={t('ui.action.close')} onClick={close} className="absolute inset-0 bg-black/90 backdrop-blur-sm" />
      <div ref={panelRef} tabIndex={-1} onKeyDown={onKeyDown} className="relative outline-none">
        {kind === 'image' ? (
          <>
            <img src={src} alt="" className="max-h-[92vh] max-w-[94vw] rounded-xl object-contain" />
            <Tip label={t('ui.player.exit')}>
              <button
                type="button"
                onClick={close}
                aria-label={t('ui.player.exit')}
                className="absolute right-2 top-2 grid h-8 w-8 place-items-center rounded-full bg-black/55 text-white backdrop-blur transition hover:bg-black/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
              >
                <X size={16} aria-hidden="true" />
              </button>
            </Tip>
          </>
        ) : (
          <MediaPlayer fullscreen src={src} poster={poster} startAt={startAt} videoRef={fsRef} onClose={close} />
        )}
        {/* Album stepper: outside the kind branch so a video album gets it too. The
            position is a real visible readout AND an aria-live announcement, because
            "which slide am I on" is the one fact a screen reader cannot infer from an
            unlabelled image. */}
        {isAlbum ? (
          <>
            <Tip label={t('ui.carousel.prev')}>
              <button type="button" onClick={() => step(-1)} aria-label={t('ui.carousel.prev')} className={`${STEP_BTN} left-2`}>
                <ChevronLeft size={20} aria-hidden="true" />
              </button>
            </Tip>
            <Tip label={t('ui.carousel.next')}>
              <button type="button" onClick={() => step(1)} aria-label={t('ui.carousel.next')} className={`${STEP_BTN} right-2`}>
                <ChevronRight size={20} aria-hidden="true" />
              </button>
            </Tip>
            <p aria-live="polite" className="absolute left-2 top-2 rounded-full bg-black/55 px-2 py-0.5 text-[11px] font-bold tabular-nums text-white backdrop-blur">
              {t('ui.carousel.position', { i: index + 1, n: count })}
            </p>
          </>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
