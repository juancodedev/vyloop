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

interface WalletStatus {
  available: boolean;
  reason: string;
  demo_mode: boolean;
  has_member_code: boolean;
  tier_row_available: boolean | null;
}

interface PassResult {
  save_url: string;
  object_id: string;
  class_id: string;
  member_code: string;
  balance_points: number;
}

const REASONS_ES: Record<string, string> = {
  available: 'Listo. La clase está aprobada y este tenant tiene acceso de publicación.',
  demo_mode:
    'Modo demo: Google solo entrega el pase a las cuentas de prueba del emisor. Es el estado correcto hasta que se conceda el acceso de publicación.',
  class_not_approved:
    'La clase de Google sigue en borrador. Google no ha aprobado el acceso de publicación.',
  class_not_provisioned: 'Este negocio no tiene una clase de pase registrada.',
  balance_not_displayable: 'El saldo del cliente no se puede representar en el pase.',
  customer_self_not_found: 'El usuario del token no es un cliente de este negocio.',
};

export default function SettingsPage() {
  const [status, setStatus] = useState<WalletStatus | null>(null);
  const [pass, setPass] = useState<PassResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [minting, setMinting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch('/v1/wallet/status')
      .then((raw) => setStatus((raw as { data: WalletStatus }).data))
      .catch(() => setError('No se pudo leer el estado de la billetera.'))
      .finally(() => setLoading(false));
  }, []);

  async function mintTestPass() {
    setMinting(true);
    setError(null);
    setPass(null);
    try {
      const raw = await apiFetch('/v1/wallet/pass');
      setPass((raw as { data: PassResult }).data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo generar el pase.');
    } finally {
      setMinting(false);
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
          ) : status === null ? (
            <p className="text-muted">No se pudo leer el estado de la billetera.</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <div>
                <div className="text-xs text-muted" style={{ marginBottom: '0.25rem' }}>
                  ESTADO
                </div>
                <div style={{ fontSize: '1rem', fontWeight: 500 }}>
                  {REASONS_ES[status.reason] ?? status.reason}
                </div>
              </div>

              <div>
                <div className="text-xs text-muted" style={{ marginBottom: '0.25rem' }}>
                  MODO DEMO
                </div>
                <div style={{ fontSize: '1rem', fontWeight: 500 }}>
                  {status.demo_mode ? 'Activado' : 'Desactivado'}
                </div>
              </div>

              {/*
                The button is shown whenever the API can produce a link, including
                in demo mode. It is deliberately not gated on `available`: in demo
                mode the pass is exactly what the operator is here to test, and
                Google decides who sees it. Hiding the button in the one state
                where testing is the point would be backwards.
              */}
              <div>
                <button
                  className="btn btn-primary"
                  onClick={mintTestPass}
                  disabled={minting}
                >
                  {minting ? 'Generando…' : 'Generar pase de prueba'}
                </button>
                <p className="text-muted" style={{ marginTop: '0.5rem', marginBottom: 0 }}>
                  Abre el pase en la cuenta de Google con la que iniciaste sesión. Con
                  modo demo activo, Google solo lo muestra si esa cuenta está en la lista
                  de pruebas del emisor.
                </p>
              </div>

              {pass && (
                <div
                  style={{
                    border: '1px solid var(--border, #e5e7eb)',
                    borderRadius: '8px',
                    padding: '1rem',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '0.5rem',
                  }}
                >
                  <div>
                    <div className="text-xs text-muted">CÓDIGO DE SOCIO</div>
                    <div style={{ fontFamily: 'monospace', fontSize: '1.1rem' }}>
                      {pass.member_code}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-muted">SALDO EN EL PASE</div>
                    <div style={{ fontSize: '1rem' }}>{pass.balance_points} puntos</div>
                  </div>
                  <div>
                    <div className="text-xs text-muted">ID DEL OBJETO</div>
                    <div style={{ fontFamily: 'monospace', fontSize: '0.8rem', wordBreak: 'break-all' }}>
                      {pass.object_id}
                    </div>
                  </div>
                  <a
                    className="btn btn-primary"
                    href={pass.save_url}
                    target="_blank"
                    rel="noreferrer"
                    style={{ textAlign: 'center' }}
                  >
                    Agregar a Google Wallet
                  </a>
                </div>
              )}

              {error && (
                <p style={{ color: 'var(--danger, #b91c1c)', margin: 0 }}>{error}</p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
