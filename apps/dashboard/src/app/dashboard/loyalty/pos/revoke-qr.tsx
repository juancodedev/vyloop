'use client';

import { useCallback, useState, type FormEvent } from 'react';

import styles from './pos.module.css';

import { useConfirm } from '@/components/ConfirmDialog';
import { ApiError, api, type CardTokenRotation } from '@/lib/api';

/** The server's bounds on the audited reason, applied to the trimmed text. */
export const REVOKE_REASON_MIN = 3;
export const REVOKE_REASON_MAX = 500;

type RevokeState =
  | { phase: 'closed' }
  | { phase: 'editing' }
  | { phase: 'submitting' }
  | { phase: 'done'; pass: CardTokenRotation['pass'] }
  | { phase: 'failed'; message: string };

/**
 * What to tell the operator when the rotation did not come back clean.
 *
 * `PASS_UPDATE_FAILED` is the one that needs care: the old QR is already
 * invalid, only the Wallet pass is behind, so "it failed" would be false and
 * would invite the operator to assume the old QR still works.
 */
function revokeFailureMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'PASS_UPDATE_FAILED') {
      return 'El QR se revocó, pero no pudimos actualizar el pase de Wallet del cliente. Inténtalo de nuevo.';
    }
    if (err.code === 'CUSTOMER_NOT_FOUND') {
      return 'No encontramos a este cliente. Vuelve a identificarlo e inténtalo de nuevo.';
    }
    if (err.code === 'CARD_TOKEN_REASON_REQUIRED') {
      return `Escribe un motivo de entre ${REVOKE_REASON_MIN} y ${REVOKE_REASON_MAX} caracteres.`;
    }
  }
  return err instanceof Error && err.message ? err.message : 'No se pudo revocar el QR.';
}

function revokeSuccessMessage(pass: CardTokenRotation['pass']): string {
  return pass === 'updated'
    ? 'QR revocado. El código anterior ya no funciona y el pase de Wallet ya tiene el nuevo.'
    : 'QR revocado. El código anterior ya no funciona.';
}

/**
 * "Revocar QR" for the customer on screen: asks for a reason, confirms, and
 * rotates the card token. Revoking never touches points, tier or history; it
 * only invalidates the scannable credential.
 */
export function RevokeQr({ customerId }: { customerId: string }) {
  const [state, setState] = useState<RevokeState>({ phase: 'closed' });
  const [reason, setReason] = useState('');
  const [ask, confirmDialog] = useConfirm();

  const submit = useCallback(async () => {
    const trimmed = reason.trim();
    if (trimmed.length < REVOKE_REASON_MIN || trimmed.length > REVOKE_REASON_MAX) return;

    const confirmed = await ask({
      title: '¿Revocar el QR de este cliente?',
      message:
        'El QR actual dejará de funcionar en caja. El cliente tendrá que usar el nuevo QR de su pase o de su tarjeta web.',
      confirmLabel: 'Revocar',
    });
    if (!confirmed) return;

    setState({ phase: 'submitting' });
    try {
      const result = await api.rotateCardToken(customerId, trimmed);
      setState({ phase: 'done', pass: result.pass });
      setReason('');
    } catch (err) {
      setState({ phase: 'failed', message: revokeFailureMessage(err) });
    }
  }, [ask, customerId, reason]);

  return (
    <>
      <RevokeQrView
        state={state}
        reason={reason}
        onOpen={() => setState({ phase: 'editing' })}
        onCancel={() => {
          setState({ phase: 'closed' });
          setReason('');
        }}
        onReasonChange={setReason}
        onSubmit={submit}
      />
      {confirmDialog}
    </>
  );
}

interface RevokeQrViewProps {
  state: RevokeState;
  reason: string;
  onOpen: () => void;
  onCancel: () => void;
  onReasonChange: (value: string) => void;
  onSubmit: () => void;
}

/** Presentational: everything it shows comes in through props. */
export function RevokeQrView({
  state,
  reason,
  onOpen,
  onCancel,
  onReasonChange,
  onSubmit,
}: RevokeQrViewProps) {
  if (state.phase === 'closed') {
    return (
      <button type="button" className={styles.linkBtn} onClick={onOpen}>
        Revocar QR
      </button>
    );
  }

  if (state.phase === 'done') {
    return (
      <p role="status" className={styles.lookupNote}>
        {revokeSuccessMessage(state.pass)}
      </p>
    );
  }

  const trimmedLength = reason.trim().length;
  const valid = trimmedLength >= REVOKE_REASON_MIN && trimmedLength <= REVOKE_REASON_MAX;
  const submitting = state.phase === 'submitting';

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (valid && !submitting) onSubmit();
  };

  return (
    <form className={styles.revokeBox} onSubmit={handleSubmit}>
      <label htmlFor="pos-revoke-reason" className={styles.revokeLabel}>
        Motivo de la revocación
      </label>
      <textarea
        id="pos-revoke-reason"
        className={`${styles.input} ${styles.revokeReason}`}
        value={reason}
        maxLength={REVOKE_REASON_MAX}
        rows={2}
        placeholder="Por ejemplo: tarjeta extraviada"
        onChange={(e) => onReasonChange(e.currentTarget.value)}
        disabled={submitting}
      />
      <p className={styles.revokeHint}>
        Obligatorio, entre {REVOKE_REASON_MIN} y {REVOKE_REASON_MAX} caracteres. Queda registrado
        quién revocó, cuándo y por qué.
      </p>

      {state.phase === 'failed' && (
        <p role="alert" className={styles.lookupWarn}>
          {state.message}
        </p>
      )}

      <div className={styles.revokeActions}>
        <button type="submit" className={styles.secondaryBtn} disabled={!valid || submitting}>
          {submitting ? 'Revocando…' : 'Revocar este QR'}
        </button>
        <button type="button" className={styles.linkBtn} onClick={onCancel} disabled={submitting}>
          Cancelar
        </button>
      </div>
    </form>
  );
}
