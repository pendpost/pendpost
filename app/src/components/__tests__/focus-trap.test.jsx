import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { axeClean } from '../../test-utils/axe.js';
import { SlideOver } from '../ui.jsx';
import { ConfirmProvider, useConfirm } from '../ui/confirm.jsx';
import { Popover, PopoverTrigger, PopoverContent } from '../ui/Popover.jsx';

// A1 (WCAG 2.2 AA): SlideOver and the Confirm/Prompt dialog are aria-modal but did
// not trap Tab, so keyboard focus could escape the open dialog. A shared focus trap
// now cycles Tab/Shift+Tab within the panel. Critically it must NOT fight a nested
// Radix popover (e.g. PostDetail's reschedule DateTimePicker), whose content is
// portaled to document.body and manages its own focus - so the trap bails whenever
// an in-panel popover trigger reports data-state="open".

// fireEvent.keyDown returns false when a handler called preventDefault, i.e. when
// the trap fired; true when the event ran its default (trap inactive / bailed).
const tab = (el, opts = {}) => fireEvent.keyDown(el, { key: 'Tab', ...opts });

function PanelHarness({ children }) {
  return (
    <SlideOver onClose={() => {}} label="Test panel">
      {children}
    </SlideOver>
  );
}

describe('SlideOver focus trap', () => {
  it('wraps Tab from the last focusable back to the first', () => {
    render(
      <PanelHarness>
        <button type="button">First</button>
        <button type="button">Second</button>
        <button type="button">Third</button>
      </PanelHarness>,
    );
    const first = screen.getByRole('button', { name: 'First' });
    const third = screen.getByRole('button', { name: 'Third' });
    third.focus();
    expect(tab(third)).toBe(false); // trap fired (default prevented)
    expect(document.activeElement).toBe(first);
  });

  it('wraps Shift+Tab from the first focusable to the last', () => {
    render(
      <PanelHarness>
        <button type="button">First</button>
        <button type="button">Second</button>
        <button type="button">Third</button>
      </PanelHarness>,
    );
    const first = screen.getByRole('button', { name: 'First' });
    const third = screen.getByRole('button', { name: 'Third' });
    first.focus();
    expect(tab(first, { shiftKey: true })).toBe(false);
    expect(document.activeElement).toBe(third);
  });

  it('does NOT trap Tab while a nested Radix popover is open (regression guard)', async () => {
    render(
      <PanelHarness>
        <button type="button">Before</button>
        <Popover>
          <PopoverTrigger asChild>
            <button type="button">Open picker</button>
          </PopoverTrigger>
          <PopoverContent>
            <button type="button">Inside popover</button>
          </PopoverContent>
        </Popover>
        <button type="button">After</button>
      </PanelHarness>,
    );
    const after = screen.getByRole('button', { name: 'After' });

    // Closed popover: the trap is active and wraps as usual.
    after.focus();
    expect(tab(after)).toBe(false);

    // Open the popover; its trigger now reports data-state="open".
    fireEvent.click(screen.getByRole('button', { name: 'Open picker' }));
    await screen.findByRole('button', { name: 'Inside popover' });
    expect(screen.getByRole('button', { name: 'Open picker' }).getAttribute('data-state')).toBe('open');

    // With the popover open the trap bails so Radix owns Tab inside its content.
    after.focus();
    expect(tab(after)).toBe(true); // default NOT prevented
  });

  it('has no axe violations', async () => {
    const { container } = render(
      <PanelHarness>
        <button type="button">First</button>
        <button type="button">Second</button>
      </PanelHarness>,
    );
    expect(await axeClean(container)).toHaveNoViolations();
  });
});

describe('Confirm dialog focus trap', () => {
  function ConfirmHarness() {
    const confirm = useConfirm();
    return (
      <button type="button" onClick={() => confirm({ title: 'Sure?' })}>
        Ask
      </button>
    );
  }

  it('cycles Tab between the Cancel and Confirm buttons', async () => {
    render(
      <ConfirmProvider>
        <ConfirmHarness />
      </ConfirmProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
    const dialog = await screen.findByRole('dialog');
    const panel = dialog.querySelector('[data-dialog-panel]');
    const [cancelBtn, confirmBtn] = within(panel).getAllByRole('button');

    confirmBtn.focus();
    expect(tab(confirmBtn)).toBe(false); // trap fired
    expect(document.activeElement).toBe(cancelBtn);

    cancelBtn.focus();
    expect(tab(cancelBtn, { shiftKey: true })).toBe(false);
    expect(document.activeElement).toBe(confirmBtn);
  });
});
