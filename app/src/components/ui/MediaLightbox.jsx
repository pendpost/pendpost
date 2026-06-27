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
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { useT } from '../../lib/i18n.js';
import { MediaPlayer } from './MediaPlayer.jsx';
import { Tip } from './Tooltip.jsx';

export function MediaLightbox({ kind, src, poster, startAt = 0, onClose }) {
  const t = useT();
  const panelRef = useRef(null);
  const restoreRef = useRef(null);
  const fsRef = useRef(null); // the viewer's own <video>, read on close to hand the playhead back

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
      </div>
    </div>,
    document.body,
  );
}
