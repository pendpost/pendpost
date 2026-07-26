import { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '../lib/i18n.js';
import {
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
  applySidebarWidth,
  getSidebarWidth,
  setSidebarWidth,
} from '../lib/format.js';

// Keyboard step: one notch of the 8-pt scale, so an arrow-key resize lands on the
// same grid a drag can land on.
const STEP = 16;

// The drag handle between the sidebar rail and <main>. It lives INSIDE the shell's
// existing gap-4, so it costs the layout no width of its own.
//
// Two things are deliberate here:
//   - Width lives in the --sidebar-w custom property, not React state. The whole app
//     renders from one App.jsx tree, so putting a pointermove in state would re-render
//     everything every frame. The drag writes the var directly and touches state once,
//     on pointerup, purely to keep aria-valuenow honest.
//   - Below lg the rail is an off-canvas drawer with a fixed width, so the handle is
//     hidden in CSS (`hidden lg:flex`). A display:none element cannot receive pointer
//     events, so that one class is the whole narrow-screen story.
export default function SidebarResizer() {
  const t = useT();
  const [width, setWidth] = useState(getSidebarWidth);
  const [dragging, setDragging] = useState(false);
  const drag = useRef(null);

  // Commit a width: var first (so the paint is immediate), then persist, then state.
  const commit = useCallback((px) => {
    const applied = applySidebarWidth(px);
    setSidebarWidth(applied);
    setWidth(applied);
  }, []);

  const onPointerDown = useCallback((e) => {
    if (e.button !== 0) return;
    drag.current = { startX: e.clientX, startWidth: getSidebarWidth() };
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
  }, []);

  const onPointerMove = useCallback((e) => {
    if (!drag.current) return;
    // Live, unpersisted: write straight to the var so the rail tracks the pointer.
    applySidebarWidth(drag.current.startWidth + (e.clientX - drag.current.startX));
  }, []);

  const endDrag = useCallback((e) => {
    if (!drag.current) return;
    const next = drag.current.startWidth + (e.clientX - drag.current.startX);
    drag.current = null;
    setDragging(false);
    commit(next);
  }, [commit]);

  const onKeyDown = useCallback((e) => {
    if (e.key === 'ArrowLeft') { e.preventDefault(); commit(getSidebarWidth() - STEP); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); commit(getSidebarWidth() + STEP); }
    else if (e.key === 'Home') { e.preventDefault(); commit(SIDEBAR_WIDTH_DEFAULT); }
  }, [commit]);

  // While dragging, the col-resize cursor and the text-selection block have to apply
  // to the whole document, not just the handle - the pointer routinely leaves it.
  // The cleanup runs on unmount too, so an unmount mid-drag cannot strand either.
  useEffect(() => {
    if (!dragging) return undefined;
    const { style } = document.body;
    const prevCursor = style.cursor;
    const prevSelect = style.userSelect;
    style.cursor = 'col-resize';
    style.userSelect = 'none';
    return () => { style.cursor = prevCursor; style.userSelect = prevSelect; };
  }, [dragging]);

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={t('sidebar.resize')}
      aria-valuenow={width}
      aria-valuemin={SIDEBAR_WIDTH_MIN}
      aria-valuemax={SIDEBAR_WIDTH_MAX}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={() => commit(SIDEBAR_WIDTH_DEFAULT)}
      onKeyDown={onKeyDown}
      className="group -mx-2 hidden w-2 shrink-0 cursor-col-resize touch-none select-none items-center justify-center rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-brand lg:flex"
    >
      {/* A short centered grip rather than a full-height rule: a hairline in this gap
          is invisible against the aurora background, and a full-height line competes
          with the glass panels on either side. The grip is unmistakably a handle and
          quieter at the same time. Only its colour and width move - the 8px track it
          sits in is fixed, so nothing in the layout shifts. */}
      <div
        className={`h-10 w-1 rounded-full transition-[width,background-color] duration-150 motion-reduce:transition-none group-hover:w-1.5 group-hover:bg-brand group-focus-visible:w-1.5 group-focus-visible:bg-brand ${dragging ? 'w-1.5 bg-brand' : 'bg-zinc-400/60 dark:bg-white/25'}`}
      />
    </div>
  );
}
