'use client';

import { QrCode } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '../lib/api';
import { readCachedCardToken, writeCachedCardToken } from '../lib/card-credential-cache';
import { formatMemberCode } from '../lib/format';

import { MemberQrCode } from './member-qr';

const FOCUSABLE = 'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

type QrProps = {
  globalId: string;
  fullName: string;
  /**
   * The member code from the wallet pass response. It is minted lazily, on the
   * first pass request, so `null` or `undefined` is the normal state for a
   * customer who has not reached the wallet card yet, not a broken account.
   */
  memberCode?: string | null | undefined;
};

/**
 * Holds a screen wake lock while mounted, so the code does not go dark in
 * front of the cashier.
 *
 * A courtesy, never a requirement: an unsupported browser, a refusal or a
 * battery saver all leave the QR on screen with no error. The lock is dropped
 * by the browser when the tab is hidden, so it is asked for again when the
 * page comes back — but only once the held one is actually released, so locks
 * never stack — and released on unmount even if it arrives after closing.
 */
function useScreenWakeLock() {
  useEffect(() => {
    let active = true;
    let sentinel: WakeLockSentinel | null = null;
    let pending = false;

    const acquire = async () => {
      if (pending || (sentinel && !sentinel.released)) return;
      pending = true;
      try {
        const lock = await navigator.wakeLock?.request('screen');
        if (!lock) return;
        if (!active) {
          await lock.release();
          return;
        }
        sentinel = lock;
      } catch {
        // Refused or unsupported: the sheet works without it.
      } finally {
        pending = false;
      }
    };

    const onVisibility = () => {
      if (document.visibilityState === 'visible') void acquire();
    };

    void acquire();
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      active = false;
      document.removeEventListener('visibilitychange', onVisibility);
      void sentinel?.release().catch(() => {});
    };
  }, []);
}

/**
 * The modal bottom sheet with the member QR and, when minted, the member code.
 *
 * Focus moves to the heading on open and is held inside the sheet; Escape and
 * "Listo" close it, and the dock returns focus to its own button.
 */
export function QrSheet({
  globalId,
  fullName,
  memberCode,
  cardToken,
  onClose,
}: QrProps & { cardToken: string | null | undefined; onClose: () => void }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const code = formatMemberCode(memberCode);

  useScreenWakeLock();

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  /**
   * Escape and the Tab trap listen on the document, not on the panel, so they
   * still work when focus has left the sheet (a click on the scrim's edge, a
   * browser control). Tab from outside pulls focus back to the first control.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
        return;
      }

      const dialog = dialogRef.current;
      if (event.key !== 'Tab' || !dialog) return;

      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const current = document.activeElement;

      if (!dialog.contains(current)) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && (current === first || current === headingRef.current)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && current === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div className="club-qr-sheet" onClick={onClose}>
      <div
        ref={dialogRef}
        className="club-qr-sheet__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="club-qr-sheet-title"
        onClick={(event) => event.stopPropagation()}
      >
        <span className="club-qr-sheet__grip" aria-hidden="true" />
        <h2 ref={headingRef} className="club-qr-sheet__title" id="club-qr-sheet-title" tabIndex={-1}>
          Muéstrale esto en caja
        </h2>

        {/* The uuid is only worth dictating to a customer without a token: the
            counter refuses it once a token exists. */}
        <MemberQrCode
          globalId={globalId}
          cardToken={cardToken}
          fullName={fullName}
          showIdOnFailure={!code && !cardToken}
        />

        {code ? (
          <>
            <p className="club-qr-sheet__code">{code}</p>
            <p className="club-qr-sheet__note">Si no pueden escanear, dicta el código.</p>
          </>
        ) : (
          <p className="club-qr-sheet__note">Tu código aparece cuando agregas la tarjeta a Wallet</p>
        )}

        <button type="button" className="club-qr-sheet__close" onClick={onClose}>
          Listo
        </button>
      </div>
    </div>
  );
}

type CardCredential =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'resolved'; token: string | null; failed: boolean };

/**
 * The scannable credential from `GET /v1/wallet/card`, asked for on demand.
 *
 * `request` is called when the customer opens the sheet, never on mount: the
 * route may mint the token, and a profile view is not a request for the code.
 * A token or `null` is kept for later opens. A failed call resolves to `null`
 * so the sheet still draws the uuid QR — the customer is at the counter and a
 * scannable code beats an error — and is asked again on the next open.
 *
 * `undefined` means "still resolving"; the QR waits for it rather than drawing
 * the uuid first and swapping it for the token a moment later.
 */
function useCardCredential(globalId: string) {
  const [credential, setCredential] = useState<CardCredential>({ status: 'idle' });
  const live = useRef(true);

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const request = useCallback(() => {
    if (credential.status === 'loading') return;
    if (credential.status === 'resolved' && !credential.failed) return;

    setCredential({ status: 'loading' });
    api.getWalletCard().then(
      (token) => {
        writeCachedCardToken(globalId, token);
        if (live.current) setCredential({ status: 'resolved', token, failed: false });
      },
      () => {
        // A failed call falls back to the last answer this browser saw, not to the
        // uuid: a customer who already has a token would get a code the counter
        // refuses. With nothing remembered, the uuid is the best there is.
        const remembered = readCachedCardToken(globalId);
        if (live.current) {
          setCredential({ status: 'resolved', token: remembered ?? null, failed: true });
        }
      },
    );
  }, [credential, globalId]);

  const cardToken = credential.status === 'resolved' ? credential.token : undefined;

  return { cardToken, request };
}

/**
 * The "Mostrar mi código" button, fixed at the bottom of the viewport so the
 * QR is one tap away from any scroll position.
 */
export function QrDock({ globalId, fullName, memberCode }: QrProps) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const { cardToken, request } = useCardCredential(globalId);

  const close = useCallback(() => {
    setOpen(false);
    buttonRef.current?.focus();
  }, []);

  return (
    <>
      <div className="club-qr-dock">
        <button
          ref={buttonRef}
          type="button"
          className="club-qr-dock__button"
          aria-haspopup="dialog"
          onClick={() => {
            request();
            setOpen(true);
          }}
        >
          <QrCode size={20} strokeWidth={1.75} aria-hidden="true" />
          <span>Mostrar mi código</span>
        </button>
      </div>

      {open ? (
        <QrSheet
          globalId={globalId}
          fullName={fullName}
          memberCode={memberCode}
          cardToken={cardToken}
          onClose={close}
        />
      ) : null}
    </>
  );
}
