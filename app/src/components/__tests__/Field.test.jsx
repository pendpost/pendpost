import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import Field from '../ui/Field.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';

// Field is the ONE labelled-text-input primitive (block label above a full-width
// input), extracted so ConnectPanel / AgentTokenPanel / IdentifierRow can never
// again hand-roll a wrapper that lets an inline label overlap an intrinsic-width
// input. The regression this file exists to refuse: an input without w-full.
function renderField(props) {
  return render(
    <TooltipProvider>
      <Field label="Client secret" {...props} />
    </TooltipProvider>,
  );
}

describe('Field primitive', () => {
  it('associates the label with the input so it is reachable by its name', () => {
    renderField({ value: '', onChange: () => {} });
    expect(screen.getByLabelText('Client secret')).toBeInTheDocument();
  });

  // THE regression guard (flywheel step 7): the measured bug was a FIELD input
  // with no width, collapsing to intrinsic width and floating beside an inline
  // label. The primitive forces w-full; this test refuses any future drift.
  it('always renders the input full-width', () => {
    renderField({ value: '', onChange: () => {} });
    expect(screen.getByLabelText('Client secret').className).toMatch(/\bw-full\b/);
  });

  it('renders a password field when secret', () => {
    renderField({ secret: true, value: '', onChange: () => {} });
    expect(screen.getByLabelText('Client secret')).toHaveAttribute('type', 'password');
  });

  it('reserves right padding and shows the adornment when one is passed', () => {
    renderField({ value: '', onChange: () => {}, adornment: <span data-testid="glyph" /> });
    expect(screen.getByTestId('glyph')).toBeInTheDocument();
    expect(screen.getByLabelText('Client secret').className).toMatch(/\bpr-9\b/);
  });

  it('wires a hint via aria-describedby', () => {
    renderField({ value: '', onChange: () => {}, hint: 'from the developer portal' });
    const input = screen.getByLabelText('Client secret');
    const hint = screen.getByText('from the developer portal');
    expect(input).toHaveAttribute('aria-describedby', hint.id);
  });

  it('marks the field invalid and announces the error', () => {
    renderField({ value: '', onChange: () => {}, error: 'Something broke' });
    const input = screen.getByLabelText('Client secret');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent('Something broke');
  });

  it('renders a reachable help affordance when a help label is given', () => {
    renderField({ value: '', onChange: () => {}, help: 'Where to find this' });
    expect(screen.getByRole('button', { name: /help: client secret/i })).toBeInTheDocument();
  });
});
