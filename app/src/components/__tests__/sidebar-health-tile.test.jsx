import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { axeClean } from '../../test-utils/axe.js';
import { HealthTile } from '../Sidebar.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// US-CONN-14: the first-run credential tiles must not be a dead end - clicking a
// platform tile deep-links to Setup (where the guided keys flow lives) instead of
// only offering a copy-CLI command. The mode badge + any CLI action stay sibling
// controls so there is no nested-interactive a11y violation.
function renderTile(props) {
  return render(
    <I18nProvider locale="en">
      <TooltipProvider>
        <HealthTile {...props} />
      </TooltipProvider>
    </I18nProvider>,
  );
}

describe('Sidebar HealthTile (US-CONN-14)', () => {
  it('is a button that deep-links to Setup when onClick is given', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    renderTile({ tone: 'err', title: 'Facebook + Instagram', sub: 'Not configured', mode: 'mock', onClick });
    await user.click(screen.getByRole('button', { name: /facebook \+ instagram/i }));
    expect(onClick).toHaveBeenCalled();
  });

  it('is not a navigation button when onClick is absent (e.g. the scheduler tile)', () => {
    renderTile({ tone: 'ok', title: 'Scheduler', sub: 'Active' });
    expect(screen.queryByRole('button', { name: /scheduler/i })).toBeNull();
  });

  it('has no axe violations with a mode badge and a sibling action (no nested buttons)', async () => {
    const { container } = renderTile({
      tone: 'err', title: 'LinkedIn', sub: 'Not connected', mode: 'mock',
      onClick: vi.fn(),
      action: <button type="button" aria-label="refresh" />,
    });
    expect(await axeClean(container)).toHaveNoViolations();
  });
});
