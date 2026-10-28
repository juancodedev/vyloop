'use client';

import { useCallback, useState, type ReactNode } from 'react';

import styles from './ConfirmDialog.module.css';

export interface ConfirmOptions {
  /** The question, naming the thing it affects: `¿Eliminar el nivel "Oro"?` */
  title: string;
  /** What happens if the answer is yes. */
  message: string;
  /** The verb on the confirm button, e.g. "Eliminar" or "Desactivar". */
  confirmLabel: string;
}

interface Pending {
  options: ConfirmOptions;
  resolve: (confirmed: boolean) => void;
}

/**
 * Ask before a destructive action, inside the app instead of the browser.
 *
 * Returns `[ask, dialog]`: render `dialog` once in the page and await `ask`
 * where the browser's own confirmation used to be. Focus starts on
 * Cancelar, so a stray Enter never deletes anything; Escape and the backdrop
 * also cancel.
 */
export function useConfirm(): readonly [(options: ConfirmOptions) => Promise<boolean>, ReactNode] {
  const [pending, setPending] = useState<Pending | null>(null);

  const ask = useCallback(
    (options: ConfirmOptions) =>
      new Promise<boolean>((resolve) => setPending({ options, resolve })),
    [],
  );

  const close = (confirmed: boolean) => {
    pending?.resolve(confirmed);
    setPending(null);
  };

  const dialog = pending ? (
    <div className="modal-overlay" data-testid="confirm-backdrop" onClick={() => close(false)}>
      <div
        className={`modal ${styles.dialog}`}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby="confirm-message"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') close(false);
        }}
      >
        <div className="modal-body">
          <h3 id="confirm-title" className={styles.title}>
            {pending.options.title}
          </h3>
          <p id="confirm-message" className={styles.message}>
            {pending.options.message}
          </p>
        </div>
        <div className="modal-footer">
          <button
            type="button"
            className="btn btn-secondary"
            autoFocus
            onClick={() => close(false)}
          >
            Cancelar
          </button>
          <button type="button" className="btn btn-danger" onClick={() => close(true)}>
            {pending.options.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  ) : null;

  return [ask, dialog] as const;
}
