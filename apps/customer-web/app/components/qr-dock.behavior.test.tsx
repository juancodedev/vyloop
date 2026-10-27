/**
 * The QR dock and sheet, as a customer at the counter meets them.
 *
 * The dock is the one control that stays on screen while the profile scrolls,
 * and the sheet is the one modal surface on the page, so it carries the full
 * dialog contract: focus moves in, stays in, and returns to the dock; Escape
 * and "Listo" close it. The wake lock is a courtesy and its refusal must never
 * reach the customer.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { QrDock } from './qr-dock';

const mocks = vi.hoisted(() => ({ toDataURL: vi.fn() }));

vi.mock('qrcode', () => ({
  default: { toDataURL: mocks.toDataURL },
}));

const GLOBAL_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const NOT_MINTED_COPY = 'Tu código aparece cuando agregás la tarjeta a Wallet';

type WakeLockStub = { request: ReturnType<typeof vi.fn> } | undefined;

function setWakeLock(stub: WakeLockStub) {
  Object.defineProperty(navigator, 'wakeLock', { value: stub, configurable: true });
}

function renderDock(memberCode?: string | null) {
  return render(<QrDock globalId={GLOBAL_ID} fullName="Ada Lovelace" memberCode={memberCode} />);
}

function dockButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: 'Mostrar mi código' }) as HTMLButtonElement;
}

async function openSheet() {
  await act(async () => {
    fireEvent.click(dockButton());
  });
  return screen.getByRole('dialog');
}

let release: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mocks.toDataURL.mockReset();
  mocks.toDataURL.mockResolvedValue('data:image/png;base64,SEVMTE8=');
  release = vi.fn().mockResolvedValue(undefined);
  setWakeLock({ request: vi.fn().mockResolvedValue({ release }) });
});

afterEach(() => {
  cleanup();
  setWakeLock(undefined);
});

describe('the QR dock', () => {
  it('shows only the dock until the customer asks for the code', () => {
    renderDock('K7F2QX');

    expect(dockButton()).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(mocks.toDataURL).not.toHaveBeenCalled();
  });
});

describe('the QR sheet', () => {
  it('opens as a modal dialog with its heading focused', async () => {
    renderDock('K7F2QX');

    const dialog = await openSheet();

    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const heading = screen.getByRole('heading', { name: 'Mostrale esto en caja' });
    expect(document.activeElement).toBe(heading);
  });

  it('renders a QR that encodes exactly /c/<globalId> at 210px', async () => {
    renderDock('K7F2QX');
    await openSheet();

    const image = await screen.findByRole('img');
    expect(mocks.toDataURL.mock.calls[0][0]).toBe(`/c/${GLOBAL_ID}`);
    expect(image.getAttribute('width')).toBe('210');
    expect(image.getAttribute('height')).toBe('210');
    expect(image.getAttribute('alt')).toContain(GLOBAL_ID);
  });

  it('shows the member code grouped in threes', async () => {
    renderDock('K7F2QX');
    await openSheet();

    expect(screen.getByText('K7F 2QX')).toBeTruthy();
    expect(screen.queryByText(NOT_MINTED_COPY)).toBeNull();
  });

  it('shows only the QR and says where the code comes from when it is not minted', async () => {
    renderDock(null);
    await openSheet();

    expect(await screen.findByRole('img')).toBeTruthy();
    expect(screen.getByText(NOT_MINTED_COPY)).toBeTruthy();
  });

  it('closes on Escape and returns focus to the dock', async () => {
    renderDock('K7F2QX');
    const dialog = await openSheet();

    await act(async () => {
      fireEvent.keyDown(dialog, { key: 'Escape' });
    });

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(dockButton());
  });

  it('closes on "Listo" and returns focus to the dock', async () => {
    renderDock('K7F2QX');
    await openSheet();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Listo' }));
    });

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(dockButton());
  });

  it('keeps Tab inside the sheet', async () => {
    renderDock('K7F2QX');
    const dialog = await openSheet();
    const done = screen.getByRole('button', { name: 'Listo' });

    done.focus();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(dialog.contains(document.activeElement)).toBe(true);

    done.focus();
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it('holds a screen wake lock while open and releases it on close', async () => {
    renderDock('K7F2QX');
    await openSheet();

    const wakeLock = (navigator as unknown as { wakeLock: { request: ReturnType<typeof vi.fn> } }).wakeLock;
    await waitFor(() => expect(wakeLock.request).toHaveBeenCalledWith('screen'));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Listo' }));
    });

    await waitFor(() => expect(release).toHaveBeenCalledTimes(1));
  });

  it('shows the QR and no error when the wake lock is refused', async () => {
    setWakeLock({ request: vi.fn().mockRejectedValue(new Error('NotAllowedError')) });
    renderDock('K7F2QX');
    await openSheet();

    expect(await screen.findByRole('img')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows the QR and no error when the browser has no wake lock', async () => {
    setWakeLock(undefined);
    renderDock('K7F2QX');
    await openSheet();

    expect(await screen.findByRole('img')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('offers a retry and keeps a readable fallback when the QR cannot be generated', async () => {
    mocks.toDataURL.mockRejectedValueOnce(new Error('canvas unavailable'));
    renderDock(null);
    await openSheet();

    expect(await screen.findByText(/No pudimos generar el código QR/)).toBeTruthy();
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByText(GLOBAL_ID)).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    });

    expect(await screen.findByRole('img')).toBeTruthy();
    expect(mocks.toDataURL).toHaveBeenCalledTimes(2);
  });
});
