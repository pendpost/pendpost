import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { axeClean } from '../../test-utils/axe.js';
import { StatusLegend } from '../ui.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// US-FR-05: a legend that explains the green/amber/red status tones, driven by
// the canonical TIME_CHIP_META so it can never drift from the chips, with colour
// always paired with an icon + accessible name.
function r(ui) {
  return render(<I18nProvider locale="en">{ui}</I18nProvider>);
}

describe('StatusLegend (US-FR-05)', () => {
  it('explains the three status tones', () => {
    r(<StatusLegend />);
    expect(screen.getByText(/clear to publish/i)).toBeInTheDocument();
    expect(screen.getByText(/needs approval/i)).toBeInTheDocument();
    expect(screen.getByText(/blocked or rejected/i)).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = r(<StatusLegend />);
    expect(await axeClean(container)).toHaveNoViolations();
  });
});
