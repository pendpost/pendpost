// A custom video player with auto-hiding controls. It replaces the native
// `<video controls>` so two things the browser chrome can't do become possible:
//  1) the controls (and the cursor) fade after a short idle and reveal on hover,
//     so a paused frame can be studied with nothing painted over it (the core ask);
//  2) an optional `expand` affordance hands the clip off to a full-viewport viewer.
// The underlying element is still a plain `<video>` - we only swap the chrome - so
// buffering/seek/playsInline stay the browser's job, and PostDetail's cover-frame
// scrubber keeps working off the SAME forwarded `videoRef`.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Maximize2, Pause, Play, Volume2, VolumeX, X } from 'lucide-react';
import { useT } from '../../lib/i18n.js';
import { cn } from './cn.js';
import { Tip } from './Tooltip.jsx';

const HIDE_MS = 2500; // idle before controls + cursor fade
const FRAME = 1 / 30; // one ~30fps frame; arrow keys step by this for inspection

function fmtTime(s) {
  const n = Number.isFinite(s) && s > 0 ? s : 0;
  const m = Math.floor(n / 60);
  const sec = Math.floor(n % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}

export function MediaPlayer({ src, poster, aspect = '', videoRef, fullscreen = false, startAt = 0, onExpand, onClose }) {
  const t = useT();
  const innerRef = useRef(null);
  const hideTimer = useRef(null);
  const seekRef = useRef(null); // the <input>, painted directly so the fill is smooth
  const timeRef = useRef(null); // the "0:00 / 0:00" readout, painted directly too
  const rafRef = useRef(0);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);

  // Paint the playhead straight onto the DOM - the input's value, its gradient
  // fill, and the time text - bypassing React state so it can update per animation
  // frame without re-rendering (the old timeupdate-driven state stepped ~1/sec).
  const paint = useCallback(() => {
    const v = innerRef.current;
    if (!v) return;
    const d = Number.isFinite(v.duration) ? v.duration : 0;
    const c = v.currentTime || 0;
    const pct = d > 0 ? (c / d) * 100 : 0;
    const seek = seekRef.current;
    if (seek) {
      seek.max = String(d || 0);
      seek.value = String(c);
      seek.style.background = `linear-gradient(to right, rgba(255,255,255,0.95) ${pct}%, rgba(255,255,255,0.22) ${pct}%)`;
      seek.setAttribute('aria-valuetext', `${fmtTime(c)} / ${fmtTime(d)}`);
    }
    if (timeRef.current) timeRef.current.textContent = `${fmtTime(c)} / ${fmtTime(d)}`;
  }, []);

  // Mirror the forwarded ref onto our own (the cover-frame scrubber in PostDetail
  // listens on this exact element); supports both callback and object refs.
  const setVideo = useCallback(
    (node) => {
      innerRef.current = node;
      if (typeof videoRef === 'function') videoRef(node);
      else if (videoRef) videoRef.current = node;
    },
    [videoRef],
  );

  // Reflect coarse element state into React (play/pause icon, mute icon). The fine
  // playhead is painted via paint() / rAF, not React state, so it stays smooth.
  useEffect(() => {
    const v = innerRef.current;
    if (!v) return undefined;
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onVol = () => setMuted(v.muted);
    onVol();
    setPlaying(!v.paused);
    paint();
    v.addEventListener('play', onPlay);
    v.addEventListener('pause', onPause);
    v.addEventListener('timeupdate', paint); // keeps paused scrubbing + seeks in sync
    v.addEventListener('seeked', paint);
    v.addEventListener('durationchange', paint);
    v.addEventListener('loadedmetadata', paint);
    v.addEventListener('volumechange', onVol);
    return () => {
      v.removeEventListener('play', onPlay);
      v.removeEventListener('pause', onPause);
      v.removeEventListener('timeupdate', paint);
      v.removeEventListener('seeked', paint);
      v.removeEventListener('durationchange', paint);
      v.removeEventListener('loadedmetadata', paint);
      v.removeEventListener('volumechange', onVol);
    };
  }, [src, paint]);

  // While playing, repaint the playhead every animation frame for a continuous
  // fill; stop the loop when paused so a held frame costs nothing.
  useEffect(() => {
    if (!playing) {
      paint();
      return undefined;
    }
    const tick = () => {
      paint();
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [playing, paint]);

  // Fullscreen handoff: resume where the inline player was (never restart at 0:00).
  useEffect(() => {
    const v = innerRef.current;
    if (!v || !startAt) return undefined;
    const seek = () => {
      try {
        v.currentTime = startAt;
      } catch {
        /* element not ready - the loadedmetadata path covers it */
      }
    };
    if (v.readyState >= 1) {
      seek();
      return undefined;
    }
    v.addEventListener('loadedmetadata', seek, { once: true });
    return () => v.removeEventListener('loadedmetadata', seek);
  }, [startAt]);

  const reveal = useCallback(() => {
    setControlsVisible(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setControlsVisible(false), HIDE_MS);
  }, []);
  const hideNow = useCallback(() => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    setControlsVisible(false);
  }, []);

  // Reveal on mount so the controls are discoverable, then let the idle timer run.
  useEffect(() => {
    reveal();
    return () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, [reveal]);

  const togglePlay = useCallback(() => {
    const v = innerRef.current;
    if (!v) return;
    if (v.paused) v.play().catch(() => {});
    else v.pause();
  }, []);
  const step = useCallback(
    (dir) => {
      const v = innerRef.current;
      if (!v) return;
      v.pause();
      const max = Number.isFinite(v.duration) ? v.duration : Infinity;
      v.currentTime = Math.max(0, Math.min(max, v.currentTime + dir * FRAME));
      paint();
    },
    [paint],
  );
  const toggleMute = useCallback(() => {
    const v = innerRef.current;
    if (v) v.muted = !v.muted;
  }, []);

  const onKeyDown = (e) => {
    // Space/k play-pause, arrows frame-step, m mute. stopPropagation keeps these
    // off the underlying SlideOver/lightbox; Escape is left to bubble so the
    // lightbox can close.
    if (e.key === ' ' || e.key === 'k') {
      e.preventDefault();
      e.stopPropagation();
      togglePlay();
      reveal();
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      e.stopPropagation();
      step(-1);
      reveal();
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      e.stopPropagation();
      step(1);
      reveal();
    } else if (e.key === 'm') {
      e.stopPropagation();
      toggleMute();
      reveal();
    }
  };

  const onScrub = (e) => {
    const v = innerRef.current;
    if (v) v.currentTime = Number(e.target.value);
    paint();
    reveal();
  };

  const BTN = 'grid h-6 w-6 shrink-0 place-items-center rounded-full text-white/85 transition hover:bg-white/15 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60';

  return (
    <div
      className={cn('group relative overflow-hidden rounded-xl', fullscreen && 'flex max-h-[92vh] max-w-[94vw]', !controlsVisible && 'cursor-none')}
      onPointerMove={(e) => {
        if (e.pointerType !== 'touch') reveal();
      }}
      onMouseLeave={hideNow}
      onKeyDown={onKeyDown}
      tabIndex={0}
      role="group"
      aria-label={t('ui.player.label')}
    >
      <video
        ref={setVideo}
        src={src}
        poster={poster || undefined}
        playsInline
        preload="metadata"
        // No cover JPEG: nudge to 0.1s so the first frame paints instead of a blank
        // black box. The ===0 guard fires once and won't fight the cover scrubber.
        onLoadedMetadata={poster ? undefined : (e) => { if (e.currentTarget.currentTime === 0) e.currentTarget.currentTime = 0.1; }}
        className={cn('bg-black/80 object-contain', fullscreen ? 'max-h-[92vh] max-w-[94vw]' : cn('w-full rounded-xl ring-1 ring-zinc-900/10 dark:ring-white/10', aspect))}
      />

      {/* Mouse/touch convenience: a tap anywhere toggles play and reveals the bar.
          Keyboard users use Space or the bar's button, so this stays out of the tab
          order and the a11y tree. Pointer-events fall through to it only when the
          bar is hidden. */}
      <button
        type="button"
        aria-hidden="true"
        tabIndex={-1}
        onClick={() => {
          togglePlay();
          reveal();
        }}
        className="absolute inset-0 cursor-default"
      />

      {/* Centered play glyph while paused (mirrors the Assets card affordance). */}
      {!playing ? (
        <span className="pointer-events-none absolute inset-0 grid place-items-center">
          <span className="grid h-12 w-12 place-items-center rounded-full bg-black/45 text-white backdrop-blur">
            <Play size={22} aria-hidden="true" />
          </span>
        </span>
      ) : null}

      {/* Auto-hiding control bar: a hairline seek line above one compact control
          row. Hovering it cancels the idle timer; leaving it reschedules the fade. */}
      <div
        className={cn(
          'absolute inset-x-0 bottom-0 flex flex-col gap-1.5 bg-gradient-to-t from-black/55 via-black/25 to-transparent px-2.5 pb-2 pt-6 transition-opacity duration-200 motion-reduce:transition-none',
          controlsVisible ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
        onPointerEnter={() => {
          if (hideTimer.current) clearTimeout(hideTimer.current);
          setControlsVisible(true);
        }}
        onPointerLeave={() => reveal()}
      >
        <input ref={seekRef} type="range" min={0} max={0} step="any" defaultValue={0} onChange={onScrub} aria-label={t('ui.player.seek')} className="pp-seek w-full" />
        <div className="flex items-center gap-1.5">
          <Tip label={playing ? t('ui.player.pause') : t('ui.player.play')}>
            <button type="button" onClick={togglePlay} aria-label={playing ? t('ui.player.pause') : t('ui.player.play')} className={BTN}>
              {playing ? <Pause size={14} aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}
            </button>
          </Tip>
          <span ref={timeRef} className="shrink-0 tabular-nums text-[10px] font-medium text-white/75">
            0:00 / 0:00
          </span>
          <span className="flex-1" />
          <Tip label={muted ? t('ui.player.unmute') : t('ui.player.mute')}>
            <button type="button" onClick={toggleMute} aria-label={muted ? t('ui.player.unmute') : t('ui.player.mute')} className={BTN}>
              {muted ? <VolumeX size={14} aria-hidden="true" /> : <Volume2 size={14} aria-hidden="true" />}
            </button>
          </Tip>
          {onExpand ? (
            <Tip label={t('ui.player.expand')}>
              <button type="button" onClick={onExpand} aria-label={t('ui.player.expand')} className={BTN}>
                <Maximize2 size={14} aria-hidden="true" />
              </button>
            </Tip>
          ) : null}
          {fullscreen && onClose ? (
            <Tip label={t('ui.player.exit')}>
              <button type="button" onClick={onClose} aria-label={t('ui.player.exit')} className={BTN}>
                <X size={14} aria-hidden="true" />
              </button>
            </Tip>
          ) : null}
        </div>
      </div>
    </div>
  );
}
