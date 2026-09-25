/**
 * Self-test for the DOM harness this package now depends on.
 *
 * The later stages of the customer-web redesign assert real user-visible
 * behaviour (focus moves, a fieldset disables, an error message replaces
 * another). Those assertions are only trustworthy if the three pieces they
 * rest on actually work together, so this file pins the harness itself:
 *
 *   1. `environment: 'jsdom'` gives us a DOM at all.
 *   2. `esbuild.jsx: 'automatic'` lets a `.tsx` test contain JSX even though
 *      the package tsconfig sets `"jsx": "preserve"` for Next.js.
 *   3. Testing Library's queries and the `act`-wrapped `render` are wired up.
 *
 * If any of the three regresses, this test fails before the behaviour suites
 * start reporting confusing downstream errors.
 */
import { act, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';

function Counter() {
  const [count, setCount] = useState(0);

  return (
    <button type="button" onClick={() => setCount((value) => value + 1)}>
      Contador: {count}
    </button>
  );
}

describe('DOM test harness', () => {
  it('renders JSX and queries it by accessible role and name', () => {
    render(<p>Club del barrio</p>);

    expect(screen.getByText('Club del barrio')).toBeTruthy();
  });

  it('drives state changes through Testing Library inside act', async () => {
    render(<Counter />);

    const button = screen.getByRole('button', { name: 'Contador: 0' });

    await act(async () => {
      button.click();
    });

    expect(screen.getByRole('button', { name: 'Contador: 1' })).toBeTruthy();
  });
});
