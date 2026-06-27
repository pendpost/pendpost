import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { axeClean } from '../../test-utils/axe.js';
import { MultiSelectDropdown } from '../ui/MultiSelectDropdown.jsx';

// US-FR-06: filter dimensions with many options (type, status) collapse into a
// multi-select dropdown so the filter bar stays compact; platform stays chips.
const OPTS = [{ key: 'reel', label: 'Reel' }, { key: 'story', label: 'Story' }];

describe('MultiSelectDropdown (US-FR-06)', () => {
  it('opens and toggles an option', async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(<MultiSelectDropdown label="Type" options={OPTS} selected={[]} onToggle={onToggle} />);
    await user.click(screen.getByRole('button', { name: /type/i }));
    await user.click(screen.getByRole('checkbox', { name: 'Reel' }));
    expect(onToggle).toHaveBeenCalledWith('reel');
  });

  it('shows the selected count on the trigger', () => {
    render(<MultiSelectDropdown label="Status" options={OPTS} selected={['reel']} onToggle={() => {}} />);
    expect(screen.getByRole('button', { name: /status/i }).textContent).toMatch(/1/);
  });

  it('has no axe violations when open', async () => {
    const user = userEvent.setup();
    const { container } = render(<MultiSelectDropdown label="Type" options={OPTS} selected={[]} onToggle={() => {}} />);
    await user.click(screen.getByRole('button', { name: /type/i }));
    expect(await axeClean(container)).toHaveNoViolations();
  });
});
