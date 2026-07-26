import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import DevReadonlyBadge from '../DevReadonlyBadge.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// The read-only marker is a SAFETY signal for `npm run dev:live`: it must appear iff the
// server reports devReadonly (GET /api/health -> devReadonly), and be invisible in the
// normal app. Guards against a silent regression (e.g. a renamed health field) that would
// hide the "you are in a read-only dev view of live data" cue.
let healthData = {};
vi.mock('../../lib/api.js', () => ({ useBuildStatus: () => ({ data: healthData }) }));

const renderBadge = () => render(<I18nProvider locale="en"><DevReadonlyBadge /></I18nProvider>);

describe('DevReadonlyBadge (dev:live read-only marker)', () => {
  it('renders nothing in the normal app (devReadonly falsy)', () => {
    healthData = { devReadonly: false };
    const { container } = renderBadge();
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when the health field is absent', () => {
    healthData = {};
    const { container } = renderBadge();
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the read-only marker when devReadonly is true', () => {
    healthData = { devReadonly: true };
    renderBadge();
    expect(screen.getByText(/read-only dev/i)).toBeInTheDocument();
  });
});
