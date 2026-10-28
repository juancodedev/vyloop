'use client';

import { useEffect, useState } from 'react';

import { apiFetch } from '@/lib/api';

/**
 * Business settings, and the Google Wallet test console.
 *
 * The navigation has carried a "Configuración" link to this path since before the
 * route existed, so the item 404'd for anyone who clicked it. Creating the page
 * fixes that, and the wallet section lives here because this is the only
 * operator surface in the product.
 *
 * ## Why the wallet section is here and not in the customer app
 *
 * A Google Wallet pass cannot reach a real customer while the issuer is in demo
 * mode: Google limits delivery to the issuer's own test accounts. So the button
 * has to exist somewhere the operator can reach, and nowhere a customer can. That
 * is this page. The customer web's delivery gate keeps every wallet call to
 * action out of the product, and this is the operator's console rather than the
 * customer's app — which is the distinction the gate is actually protecting.
 */

/**
 * The operator's view of the wallet program.
 *
 * Field names mirror the worker's response. `storedDemoMode` is this tenant's own
 * switch and `demoModeCeiling` is the deployment's; `demoMode` is the effective
 * value that decides whether a pass mints, and it is the AND of the two. They are
 * separate fields rather than one because an operator who sees only the row cannot
 * tell which of the two is holding the passes back, and that is exactly the
 * question this console exists to answer.
 */
interface WalletProgram {
  classId: string;
  reviewStatus: string;
  storedDemoMode: boolean;
  demoMode: boolean;
  demoModeCeiling: boolean;
}

const REVIEW_ES: Record<string, string> = {
  approved: 'Aprobada por Google — el pase llega a cualquier cliente.',
  draft: 'Borrador — Google no ha concedido acceso de publicación todavía.',
  under_review: 'En revisión por Google.',
  rejected: 'Rechazada por Google.',
  none: 'Sin estado de revisión registrado.',
};

export default function SettingsPage() {
  const [program, setProgram] = useState<WalletProgram | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * The operator's own read path, not `/v1/wallet/status`.
   *
   * That route is scoped to the customer named by the token — it resolves
   * `findCustomer(auth.userId)` and answers 403 when there is no such row — and
   * this page is called with an operator token, so it used to receive a 403 from
   * the one screen built to show the wallet state. `/v1/wallet/program` is the
   * operator-scoped read and answers about the tenant rather than a customer.
   */
  useEffect(() => {
    apiFetch('/v1/wallet/program')
      .then((raw) => setProgram((raw as { data: WalletProgram }).data))
      .catch((err) =>
        setError(err instanceof Error ? err.message : 'No se pudo leer el estado del programa.'),
      )
      .finally(() => setLoading(false));
  }, []);

  async function setDemoMode(next: boolean) {
    setSaving(true);
    setError(null);
    try {
      const raw = await apiFetch('/v1/wallet/program/demo-mode', {
        method: 'PUT',
        body: JSON.stringify({ demoMode: next }),
      });
      // The response carries the effective value, so the switch reflects what a
      // pass would actually do rather than what was asked for. Under a `false`
      // ceiling the row can be on while minting stays off, and showing the
      // optimistic value would be a lie the operator would have to debug.
      setProgram((raw as { data: WalletProgram }).data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo cambiar el modo.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      <div className="card">
        <div className="card-header">
          <h3>Configuración</h3>
        </div>
        <div className="card-body">
          <p className="text-muted" style={{ margin: 0 }}>
            Preferencias del negocio. La sección de Google Wallet está más abajo.
          </p>
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <h3>Google Wallet</h3>
        </div>
        <div className="card-body">
          {loading ? (
            <p className="text-muted">Consultando estado…</p>
          ) : program === null ? (
            <p className="text-muted">No se pudo leer el estado del programa.</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <div>
                <div className="text-xs text-muted" style={{ marginBottom: '0.25rem' }}>
                  ESTADO DE LA CLASE
                </div>
                <div style={{ fontSize: '1rem', fontWeight: 500 }}>
                  {REVIEW_ES[program.reviewStatus] ?? program.reviewStatus}
                </div>
                <div
                  className="text-xs text-muted"
                  style={{ marginTop: '0.25rem', fontFamily: 'monospace', wordBreak: 'break-all' }}
                >
                  {program.classId}
                </div>
              </div>

              {/*
                The switch, and the reason it is not a single checkbox.

                `storedDemoMode` is this tenant's row and `demoModeCeiling` is the
                deployment's. A pass mints only when both allow it, so a checkbox
                showing one of them would let an operator turn demo mode "on", see
                no passes appear, and conclude the integration was broken. The
                effective value is shown as its own line for that reason.
              */}
              <div>
                <div className="text-xs text-muted" style={{ marginBottom: '0.5rem' }}>
                  MODO DE EMISIÓN
                </div>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <button
                    className="btn btn-primary"
                    onClick={() => setDemoMode(true)}
                    disabled={saving || program.storedDemoMode}
                    aria-pressed={program.storedDemoMode}
                  >
                    Test / demo
                  </button>
                  <button
                    className="btn"
                    onClick={() => setDemoMode(false)}
                    disabled={saving || !program.storedDemoMode}
                    aria-pressed={!program.storedDemoMode}
                  >
                    Producción
                  </button>
                </div>
                <div style={{ fontSize: '0.9rem', marginTop: '0.5rem' }}>
                  Este negocio: <strong>{program.storedDemoMode ? 'demo' : 'producción'}</strong>
                  {' · '}
                  Techo del despliegue: <strong>{program.demoModeCeiling ? 'demo' : 'producción'}</strong>
                </div>
                <div style={{ fontSize: '0.9rem', marginTop: '0.25rem', fontWeight: 500 }}>
                  {program.demoMode
                    ? 'Efectivo: los pases se emiten.'
                    : 'Efectivo: los pases NO se emiten. ' +
                      (program.demoModeCeiling
                        ? 'El modo de este negocio está en producción.'
                        : 'El techo del despliegue está en producción y no permite emitir.')}
                </div>
              </div>

              {/*
                No "generate a test pass" button, and that is a decision rather
                than an omission.

                A pass belongs to a customer: `/v1/wallet/pass` is scoped to the
                customer named by the token and answers 403 for anyone else, which
                is the correct rule. An operator token is not a customer, so a
                button here could only ever render a 403 — and the version that did
                render one shipped in #138. Minting a pass for a chosen customer is
                a separate operator capability with its own authorisation decision
                about *whose* customer may be minted; it is not something to
                re-add here on the way to a different problem.
              */}
              <div>
                <div className="text-xs text-muted" style={{ marginBottom: '0.25rem' }}>
                  EMITIR UN PASE
                </div>
                <p className="text-muted" style={{ margin: 0 }}>
                  El pase pertenece a un cliente, así que se emite desde la cuenta del
                  cliente en la app, no desde aquí. Un pase de prueba real ya se generó
                  de punta a punta y se puede agregar a Google Wallet con la cuenta de
                  prueba del emisor.
                </p>
              </div>

              {error && (
                <p style={{ color: 'var(--danger, var(--error))', margin: 0 }}>{error}</p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
