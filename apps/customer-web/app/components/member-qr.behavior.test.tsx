/**
 * The QR disclosure, as a keyboard user meets it.
 *
 * The panel is the one thing on the pass that a customer opens and closes
 * themselves, so it is the one thing with a keyboard contract: Space and Enter
 * open it, Escape closes it, focus goes back to the control that opened it, and
 * Tab from there continues down the page rather than being held inside.
 *
 * The code payload itself is covered by `profile.contract.test.ts` — it is a
 * byte string only the counter scanner ever reads.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { MemberQr } from './member-qr';

const GLOBAL_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

function renderQr() {
  return render(<MemberQr globalId={GLOBAL_ID} fullName="Ada Lovelace" />);
}

function toggle(): HTMLButtonElement {
  return screen.getByRole('button', { name: /código/i }) as HTMLButtonElement;
}

afterEach(cleanup);

describe('the QR disclosure', () => {
  it('starts closed, and says so in its own label', () => {
    renderQr();

    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    expect(toggle().textContent).toContain('Mostrar mi código');
    expect(document.querySelector('#club-qr-panel')).toBeNull();
  });

  it('opens on activation and reports the state', async () => {
    renderQr();

    await act(async () => {
      toggle().click();
    });

    await waitFor(() => expect(document.querySelector('#club-qr-panel')).toBeTruthy());

    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    // The label changes too, so the state is not carried by the attribute alone.
    expect(toggle().textContent).toContain('Ocultar mi código');
  });

  it('closes on Escape and returns focus to the control that opened it', async () => {
    // Without the focus return, closing the panel removes the subtree focus was
    // in and drops it at the top of the document — the one way a disclosure can
    // strand somebody at the start of the page.
    renderQr();

    await act(async () => {
      toggle().click();
    });

    await waitFor(() => expect(document.querySelector('#club-qr-panel')).toBeTruthy());

    await act(async () => {
      fireEvent.keyDown(document.querySelector('.club-qr') as HTMLElement, { key: 'Escape' });
    });

    expect(document.querySelector('#club-qr-panel')).toBeNull();
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(toggle());
  });

  it('closes on Escape from inside the panel, which is where the retry button is', async () => {
    // A customer who could not generate a code is exactly the person who reaches
    // for Escape, and the retry button is the only focusable thing in there.
    renderQr();

    await act(async () => {
      toggle().click();
    });

    await waitFor(() => expect(document.querySelector('#club-qr-panel')).toBeTruthy());

    // Whichever state the panel settled into, Escape from inside it closes it
    // and hands focus back.
    const inside = document.querySelector('#club-qr-panel') as HTMLElement;

    await act(async () => {
      fireEvent.keyDown(inside, { key: 'Escape' });
    });

    expect(document.querySelector('#club-qr-panel')).toBeNull();
    expect(document.activeElement).toBe(toggle());
  });

  it('ignores Escape while it is closed, and leaves focus where it was', () => {
    renderQr();

    const outside = document.createElement('button');
    document.body.appendChild(outside);

    act(() => {
      outside.focus();
      fireEvent.keyDown(outside, { key: 'Escape' });
    });

    expect(document.activeElement).toBe(outside);
    expect(document.querySelector('#club-qr-panel')).toBeNull();

    outside.remove();
  });

  it('is not a trap: the panel is not focusable itself and holds no tab stop', async () => {
    renderQr();

    await act(async () => {
      toggle().click();
    });

    await waitFor(() => expect(document.querySelector('#club-qr-panel')).toBeTruthy());

    // The panel is a plain div with no `tabindex`, so Tab moves out of it into
    // the rest of the page rather than cycling inside.
    const panel = document.querySelector('#club-qr-panel') as HTMLElement;

    expect(panel.getAttribute('tabindex')).toBeNull();

    // And the toggle is the only thing that owns a tab stop on the control side.
    expect(toggle().getAttribute('type')).toBe('button');
  });

  it('always shows the readable member id, closed or open', async () => {
    // The id is what the customer can read out or type at the counter when the
    // code will not scan, so it is never inside the collapsible part.
    renderQr();

    expect(screen.getByText(GLOBAL_ID)).toBeTruthy();

    await act(async () => {
      toggle().click();
    });

    await waitFor(() => expect(document.querySelector('#club-qr-panel')).toBeTruthy());

    expect(screen.getByText(GLOBAL_ID)).toBeTruthy();
  });
});

describe('the QR disclosure, closing while it is still generating', () => {
  it('stays closed when the code lands after the customer dismissed it', async () => {
    // A real race, not a hypothetical one. Generating takes long enough to be
    // interrupted, and before this was guarded the promise resolved after the
    // close and called `setState({ status: 'ready' })` — putting the panel back
    // on screen by itself. The customer dismisses the code and it springs open
    // again a moment later.
    renderQr();

    await act(async () => {
      toggle().click();
    });

    // The panel is up and still working, which is the window the race lives in.
    await waitFor(() => expect(document.querySelector('#club-qr-panel')).toBeTruthy());

    await act(async () => {
      fireEvent.keyDown(document.querySelector('.club-qr') as HTMLElement, { key: 'Escape' });
    });

    expect(document.querySelector('#club-qr-panel')).toBeNull();

    // Now let the in-flight generation land. The panel must stay down.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(document.querySelector('#club-qr-panel')).toBeNull();
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
  });

  it('stays closed when the button closes it mid-generation', async () => {
    // The same race through the other door, and the one a customer hits without
    // ever pressing a key.
    renderQr();

    await act(async () => {
      toggle().click();
    });

    await waitFor(() => expect(document.querySelector('#club-qr-panel')).toBeTruthy());

    await act(async () => {
      toggle().click();
    });

    expect(document.querySelector('#club-qr-panel')).toBeNull();

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(document.querySelector('#club-qr-panel')).toBeNull();
  });

  it('still opens normally when nothing interrupts it', async () => {
    // The guard must not break the happy path.
    renderQr();

    await act(async () => {
      toggle().click();
    });

    await waitFor(() => expect(document.querySelector('.club-qr__image')).toBeTruthy());

    expect(document.querySelector('#club-qr-panel')).toBeTruthy();
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
  });
});
