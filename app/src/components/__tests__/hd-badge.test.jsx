import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { HdBadge } from '../ui/HdBadge.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// Exceptions-only on post rows (owner, 2026-11-05): a row's meta line says nothing when the
// video is HD (the normal case) and keeps the amber 720p warning; the Assets library keeps both.
const renderBadge = (props) => render(
  <I18nProvider locale="en">
    <TooltipProvider>
      <HdBadge {...props} />
    </TooltipProvider>
  </I18nProvider>,
);

describe('HdBadge', () => {
  it('shows the green HD pill by default', () => {
    const { container } = renderBadge({ hdReady: true, static: true });
    expect(container).toHaveTextContent('HD');
  });

  it('warnOnly: nothing when the video is HD', () => {
    const { container } = renderBadge({ hdReady: true, static: true, warnOnly: true });
    expect(container).toBeEmptyDOMElement();
  });

  it('warnOnly: keeps the 720p warning when the master is too thin', () => {
    const { container } = renderBadge({ hdReady: false, bitrate: 3_200_000, static: true, warnOnly: true });
    expect(container).toHaveTextContent('720p');
  });

  it('nothing for an image or an unprobed file, with or without warnOnly', () => {
    expect(renderBadge({ hdReady: null }).container).toBeEmptyDOMElement();
    expect(renderBadge({ hdReady: null, warnOnly: true }).container).toBeEmptyDOMElement();
  });
});
