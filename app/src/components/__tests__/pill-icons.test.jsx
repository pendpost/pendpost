import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { axeClean } from '../../test-utils/axe.js';
import { StatusPill, ApprovalPill } from '../ui.jsx';
import { STATE_META, APPROVAL_META } from '../../lib/format.js';

// A2 (DESIGN.md section 3): StatusPill/ApprovalPill carried meaning by color +
// text only. They now lead with a decorative (aria-hidden) lucide icon, matching
// the TimeChip's icon+tone treatment. The pills already carry their text label, so
// the icon never becomes the sole signal (WCAG 1.4.1) - it is purely coherence.

describe('StatusPill icon', () => {
  it('renders a decorative (aria-hidden) icon ahead of the label for every state', () => {
    for (const state of Object.keys(STATE_META)) {
      const { container } = render(<StatusPill state={state} />);
      const svg = container.querySelector('svg');
      expect(svg, `state "${state}" should render an icon`).not.toBeNull();
      expect(svg.getAttribute('aria-hidden')).toBe('true');
      // The text label is still present (icon is additive, not a replacement).
      expect(container.textContent.trim().length).toBeGreaterThan(0);
    }
  });

  it('keeps BOTH the icon and the text on the compact `short` pill (not icon-only)', () => {
    const { container } = render(<StatusPill state="overdue" short />);
    expect(container.querySelector('svg')).not.toBeNull();
    expect(container.textContent.trim().length).toBeGreaterThan(0);
  });
});

describe('ApprovalPill icon', () => {
  it('renders a decorative icon + label for a non-approved status', () => {
    const { container } = render(<ApprovalPill approval="pending" />);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(container.textContent.trim().length).toBeGreaterThan(0);
  });

  it('still renders nothing for the approved status (unchanged behavior)', () => {
    const { container } = render(<ApprovalPill approval="approved" />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('pill META icon coverage', () => {
  // lucide-react icons are forwardRef components (typeof 'object'), so the tripwire
  // asserts a defined, renderable component type rather than a plain function.
  const isComponent = (Icon) => Boolean(Icon) && ['function', 'object'].includes(typeof Icon);

  it('defines an Icon for every STATE_META entry', () => {
    for (const [state, meta] of Object.entries(STATE_META)) {
      expect(isComponent(meta.Icon), `STATE_META.${state} needs an Icon`).toBe(true);
    }
  });

  it('defines an Icon for every APPROVAL_META entry', () => {
    for (const [status, meta] of Object.entries(APPROVAL_META)) {
      expect(isComponent(meta.Icon), `APPROVAL_META.${status} needs an Icon`).toBe(true);
    }
  });
});

describe('pill accessibility', () => {
  it('has no axe violations with the icon present', async () => {
    const { container } = render(
      <div>
        <StatusPill state="posted" />
        <StatusPill state="overdue" short />
        <ApprovalPill approval="pending" />
      </div>,
    );
    expect(await axeClean(container)).toHaveNoViolations();
  });
});
