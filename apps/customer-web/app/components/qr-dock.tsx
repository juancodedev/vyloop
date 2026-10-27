'use client';

import { QrCode } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';

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
 * page comes back, and released on unmount even if it arrives after closing.
 */
function useScreenWakeLock() {
  useEffect(() => {
    let active = true;
    let sentinel: WakeLockSentinel | null = null;

    const acquire = async () => {
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
export function QrSheet({ globalId, fullName, memberCode, onClose }: QrProps & { onClose: () => void }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const code = formatMemberCode(memberCode);

  useScreenWakeLock();

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
        return;
      }

      if (event.key !== 'Tab' || !dialogRef.current) return;

      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const current = document.activeElement;

      if (event.shiftKey && (current === first || current === headingRef.current)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && current === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [onClose],
  );

  return (
    <div className="club-qr-sheet" onClick={onClose}>
      <div
        ref={dialogRef}
        className="club-qr-sheet__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="club-qr-sheet-title"
        onKeyDown={handleKeyDown}
        onClick={(event) => event.stopPropagation()}
      >
        <span className="club-qr-sheet__grip" aria-hidden="true" />
        <h2 ref={headingRef} className="club-qr-sheet__title" id="club-qr-sheet-title" tabIndex={-1}>
          Mostrale esto en caja
        </h2>

        <MemberQrCode globalId={globalId} fullName={fullName} showIdOnFailure={!code} />

        {code ? (
          <>
            <p className="club-qr-sheet__code">{code}</p>
            <p className="club-qr-sheet__note">Si no pueden escanear, dictá el código.</p>
          </>
        ) : (
          <p className="club-qr-sheet__note">Tu código aparece cuando agregás la tarjeta a Wallet</p>
        )}

        <button type="button" className="club-qr-sheet__close" onClick={onClose}>
          Listo
        </button>
      </div>
    </div>
  );
}

/**
 * The "Mostrar mi código" button, fixed at the bottom of the viewport so the
 * QR is one tap away from any scroll position.
 */
export function QrDock({ globalId, fullName, memberCode }: QrProps) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

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
          onClick={() => setOpen(true)}
        >
          <QrCode size={20} strokeWidth={1.75} aria-hidden="true" />
          <span>Mostrar mi código</span>
        </button>
      </div>

      {open ? <QrSheet globalId={globalId} fullName={fullName} memberCode={memberCode} onClose={close} /> : null}
    </>
  );
}
