import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';

// Smoke test: proves the Vitest + React Testing Library + jsdom toolchain runs.
function Hello() {
  return <p>pendpost</p>;
}

describe('toolchain smoke', () => {
  it('renders a component into jsdom', () => {
    render(<Hello />);
    expect(screen.getByText('pendpost')).toBeInTheDocument();
  });
});
