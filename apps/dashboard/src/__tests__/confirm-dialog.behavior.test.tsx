// @vitest-environment jsdom

/**
 * The in-app confirmation that replaced the browser's `confirm()`: it looks
 * like the rest of the app, names what is about to happen, and defaults to the
 * safe answer.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { useConfirm } from '../components/ConfirmDialog';

let ask: ReturnType<typeof useConfirm>[0];

function Harness() {
  const [confirm, dialog] = useConfirm();
  useEffect(() => {
    ask = confirm;
  });
  return <>{dialog}</>;
}

function open() {
  let answer: Promise<boolean> = Promise.resolve(false);
  act(() => {
    answer = ask({
      title: '¿Eliminar el nivel "Oro"?',
      message: 'Esta acción no se puede deshacer.',
      confirmLabel: 'Eliminar',
    });
  });
  return answer;
}

afterEach(cleanup);

describe('the confirmation dialog', () => {
  it('shows the question as an alert dialog, with nothing chosen for the user', () => {
    render(<Harness />);
    void open();

    const dialog = screen.getByRole('alertdialog', { name: '¿Eliminar el nivel "Oro"?' });
    expect(dialog.textContent).toContain('Esta acción no se puede deshacer.');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancelar' }));
  });

  it('answers yes from the confirm button and closes', async () => {
    render(<Harness />);
    const answer = open();

    fireEvent.click(screen.getByRole('button', { name: 'Eliminar' }));

    await expect(answer).resolves.toBe(true);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('answers no from Cancelar, from Escape and from the backdrop', async () => {
    render(<Harness />);

    let answer = open();
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    await expect(answer).resolves.toBe(false);

    answer = open();
    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' });
    await expect(answer).resolves.toBe(false);

    answer = open();
    fireEvent.click(screen.getByTestId('confirm-backdrop'));
    await expect(answer).resolves.toBe(false);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});
