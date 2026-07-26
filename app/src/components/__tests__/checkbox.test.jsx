import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Checkbox } from '../ui/Checkbox.jsx';

// The shared checkbox primitive replaces the ad-hoc `accent-brand` native inputs. It stays a real
// <input type="checkbox"> (so every getByRole('checkbox') across the suite keeps working) but draws
// its own box: an outline when unchecked (never a bright fill that reads as "on" in dark mode) and a
// brand fill + check glyph when checked.
describe('Checkbox (shared primitive)', () => {
  it('is a real checkbox that reflects the checked prop', () => {
    const { rerender } = render(<Checkbox checked={false} onChange={() => {}} aria-label="Wants coffee" />);
    const cb = screen.getByRole('checkbox', { name: 'Wants coffee' });
    expect(cb).not.toBeChecked();
    rerender(<Checkbox checked onChange={() => {}} aria-label="Wants coffee" />);
    expect(screen.getByRole('checkbox', { name: 'Wants coffee' })).toBeChecked();
  });

  it('calls onChange when toggled', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Checkbox checked={false} onChange={onChange} aria-label="Wants coffee" />);
    await user.click(screen.getByRole('checkbox', { name: 'Wants coffee' }));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('does not fire onChange while disabled', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Checkbox checked={false} disabled onChange={onChange} aria-label="Wants coffee" />);
    const cb = screen.getByRole('checkbox', { name: 'Wants coffee' });
    expect(cb).toBeDisabled();
    await user.click(cb);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('renders an outline (no accent-brand fill utility) when unchecked so dark mode does not read it as on', () => {
    render(<Checkbox checked={false} onChange={() => {}} aria-label="Wants coffee" />);
    const cb = screen.getByRole('checkbox', { name: 'Wants coffee' });
    // appearance-none + a border is the outline treatment; the old bright native fill is gone.
    expect(cb.className).toMatch(/appearance-none/);
    expect(cb.className).toMatch(/border/);
    expect(cb.className).not.toMatch(/accent-brand/);
  });

  it('reflects the indeterminate prop on the input (used by select-all)', () => {
    render(<Checkbox checked={false} indeterminate onChange={() => {}} aria-label="Select all" />);
    expect(screen.getByRole('checkbox', { name: 'Select all' }).indeterminate).toBe(true);
  });

  it('passes through id and extra props to the input', () => {
    render(<Checkbox id="agree" checked onChange={() => {}} aria-label="Agree" />);
    expect(screen.getByRole('checkbox', { name: 'Agree' })).toHaveAttribute('id', 'agree');
  });
});
