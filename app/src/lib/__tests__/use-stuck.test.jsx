// use-stuck.test.jsx - lib/useStuck.js: a sticky strip is "stuck" only while pinned at its top,
// so its opaque fill never shows as a band in the flow. jsdom has no layout, so the rects are
// modelled here: a scroller at top 16, three day sections of 300px, each with a 28px heading
// sticky at 36px. A JUMP scroll (one scroll event, no intermediate positions) must mark exactly
// the heading whose section spans the sticky line.
import { render, act } from '@testing-library/react';
import { useRef } from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useStuck, stuckFrom } from '../useStuck.js';

const rect = (top, height, width = 300) => ({ top, bottom: top + height, height, width, left: 0, right: width, x: 0, y: top });

describe('stuckFrom', () => {
  it('pinned at the sticky line (to the half pixel): stuck', () => {
    expect(stuckFrom(rect(52, 28), 52)).toBe(true);
    expect(stuckFrom(rect(52.4, 28), 52)).toBe(true);
  });
  it('in the flow below the line: not stuck', () => {
    expect(stuckFrom(rect(240, 28), 52)).toBe(false);
  });
  it('pushed up by the end of its section but still on screen: stuck, it still covers rows', () => {
    expect(stuckFrom(rect(30, 28), 52, 16)).toBe(true);
  });
  it('scrolled fully off the top of the root: not stuck', () => {
    expect(stuckFrom(rect(-128, 28), 52, 16)).toBe(false);
  });
  it('an element with no layout (jsdom, display: none) is never stuck', () => {
    expect(stuckFrom(rect(0, 0, 0), 0)).toBe(false);
    expect(stuckFrom(null, 0)).toBe(false);
  });
});

function Heading({ index, top }) {
  const ref = useRef(null);
  const stuck = useStuck(ref, { top, bounded: true });
  return (
    <section data-section={index}>
      <div ref={ref} data-heading={index} data-stuck={stuck ? '' : undefined} />
    </section>
  );
}

function Bar({ enabled }) {
  const ref = useRef(null);
  const stuck = useStuck(ref, { enabled });
  return <div ref={ref} data-bar="" data-stuck={stuck ? '' : undefined} />;
}

describe('useStuck', () => {
  let scrollY = 0;
  const ROOT_TOP = 16;
  const STICKY = 36;
  const LINE = ROOT_TOP + STICKY;
  const original = Element.prototype.getBoundingClientRect;
  const originalRaf = window.requestAnimationFrame;

  beforeEach(() => {
    scrollY = 0;
    window.requestAnimationFrame = (cb) => { cb(0); return 1; };
    // A sticky heading sits at its natural top, held at the line while its section spans it,
    // pushed up by its section's bottom after that.
    Element.prototype.getBoundingClientRect = function box() {
      if (this.dataset?.scroller !== undefined) return rect(ROOT_TOP, 800);
      if (this.dataset?.bar !== undefined) return rect(ROOT_TOP + 120 - Math.min(scrollY, 120), 36);
      const s = this.dataset?.section ?? this.dataset?.heading;
      if (s === undefined) return rect(0, 0, 0);
      const sectionTop = ROOT_TOP + 100 + Number(s) * 300 - scrollY;
      if (this.dataset.section !== undefined) return rect(sectionTop, 300);
      return rect(Math.max(sectionTop, Math.min(LINE, sectionTop + 300 - 28)), 28);
    };
  });
  afterEach(() => {
    Element.prototype.getBoundingClientRect = original;
    window.requestAnimationFrame = originalRaf;
  });

  const renderList = () => render(
    <div data-scroller="" style={{ overflowY: 'auto' }}>
      {[0, 1, 2, 3].map((i) => <Heading key={i} index={i} top={STICKY} />)}
    </div>,
  );
  const stuckOnes = (container) => [...container.querySelectorAll('[data-heading][data-stuck]')].map((el) => el.dataset.heading);

  it('computes on register: at the top of the page no heading is stuck', () => {
    const { container } = renderList();
    expect(stuckOnes(container)).toEqual([]);
  });

  it('a jump from 0 to N marks exactly the heading whose section spans the sticky line, none of the off-screen ones', () => {
    const { container } = renderList();
    const scroller = container.querySelector('[data-scroller]');
    scrollY = 700; // section 2 (natural 616..916 in the page) spans the line at 52
    act(() => { scroller.dispatchEvent(new Event('scroll')); });
    expect(stuckOnes(container)).toEqual(['2']);
    scrollY = 120; // jump back up: section 0 spans the line
    act(() => { scroller.dispatchEvent(new Event('scroll')); });
    expect(stuckOnes(container)).toEqual(['0']);
    scrollY = 0;
    act(() => { scroller.dispatchEvent(new Event('scroll')); });
    expect(stuckOnes(container)).toEqual([]);
  });

  it('one shared passive listener per scroll root, released with its last element', () => {
    const add = vi.spyOn(HTMLElement.prototype, 'addEventListener');
    const remove = vi.spyOn(HTMLElement.prototype, 'removeEventListener');
    const { container, unmount } = renderList();
    const scroller = container.querySelector('[data-scroller]');
    const onScroller = (spy) => spy.mock.calls.filter(([type], i) => type === 'scroll' && spy.mock.contexts[i] === scroller);
    const scrolls = onScroller(add);
    expect(scrolls).toHaveLength(1);
    expect(scrolls[0][2]).toEqual({ passive: true });
    unmount();
    expect(onScroller(remove)).toHaveLength(1);
    add.mockRestore();
    remove.mockRestore();
  });

  it('a resize recomputes too', () => {
    const { container } = renderList();
    scrollY = 400; // section 1 spans the line
    act(() => { window.dispatchEvent(new Event('resize')); });
    expect(stuckOnes(container)).toEqual(['1']);
  });

  it('an unbounded strip (the toolbar / selection line) is stuck once it reaches the line; disabled, never', () => {
    const { container, rerender } = render(<div data-scroller="" style={{ overflowY: 'auto' }}><Bar enabled /></div>);
    const bar = container.querySelector('[data-bar]');
    expect(bar).not.toHaveAttribute('data-stuck');
    scrollY = 5000;
    act(() => { container.querySelector('[data-scroller]').dispatchEvent(new Event('scroll')); });
    expect(bar).toHaveAttribute('data-stuck', '');
    rerender(<div data-scroller="" style={{ overflowY: 'auto' }}><Bar enabled={false} /></div>);
    expect(bar).not.toHaveAttribute('data-stuck');
  });

  it('without layout (plain jsdom) nothing is ever stuck', () => {
    Element.prototype.getBoundingClientRect = original;
    const { container } = renderList();
    act(() => { container.querySelector('[data-scroller]').dispatchEvent(new Event('scroll')); });
    expect(stuckOnes(container)).toEqual([]);
  });
});
