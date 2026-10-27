'use client';

import { useEffect, useRef, useState } from 'react';

import { api, ApiError } from '../lib/api';

interface DeleteAccountProps {
  points: number;
  /** `program.pointsCurrency`, e.g. "puntos". Without it the balance is not named. */
  pointsCurrency: string | null;
  /** Called once the server has deleted the account, for the page to sign out. */
  onDeleted: () => void;
}

function failureFor(err: unknown): string {
  if (err instanceof ApiError && err.code === 'AUTH_SCOPE_MISSING') {
    return 'Para eliminar tu cuenta, cerrá sesión y volvé a entrar.';
  }
  return 'No pudimos eliminar tu cuenta. Intentá de nuevo.';
}

/**
 * "Eliminar mi cuenta" with an in-page confirm step.
 *
 * The first click only opens the step; the request goes out from the confirm
 * button. Deletion anonymises the account at once and cannot be undone, so the
 * step says so, and names the balance that is lost when there is one.
 */
export function DeleteAccount({ points, pointsCurrency, onDeleted }: DeleteAccountProps) {
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const openRef = useRef<HTMLButtonElement>(null);

  // Focus follows the step: onto the safe choice when it opens, back to the
  // trigger when it closes.
  const wasConfirming = useRef(false);
  useEffect(() => {
    if (confirming) cancelRef.current?.focus();
    else if (wasConfirming.current) openRef.current?.focus();
    wasConfirming.current = confirming;
  }, [confirming]);

  async function remove() {
    if (deleting) return;
    setDeleting(true);
    setError(null);
    try {
      await api.deleteAccount();
      onDeleted();
    } catch (err) {
      setError(failureFor(err));
      setDeleting(false);
    }
  }

  if (!confirming) {
    return (
      <button
        ref={openRef}
        type="button"
        className="club-delete-account__open"
        onClick={() => setConfirming(true)}
      >
        Eliminar mi cuenta
      </button>
    );
  }

  const balance = points > 0 && pointsCurrency ? `Vas a perder tus ${points} ${pointsCurrency}. ` : '';

  return (
    <section className="club-delete-account" aria-labelledby="club-delete-account-title">
      <h2 className="club-delete-account__title" id="club-delete-account-title">
        ¿Eliminar tu cuenta?
      </h2>
      <p className="club-delete-account__body">
        {balance}Borramos tu nombre, teléfono, correo y cumpleaños, y tu tarjeta de Google Wallet deja de
        funcionar. Esto no se puede deshacer.
      </p>
      {error ? (
        <p className="error-text" role="alert">
          {error}
        </p>
      ) : null}
      <div className="club-delete-account__actions">
        <button type="button" className="btn btn--danger" onClick={remove} disabled={deleting}>
          Sí, eliminar mi cuenta
        </button>
        <button
          ref={cancelRef}
          type="button"
          className="btn btn--outline"
          onClick={() => {
            setConfirming(false);
            setError(null);
          }}
          disabled={deleting}
        >
          Cancelar
        </button>
      </div>
    </section>
  );
}
