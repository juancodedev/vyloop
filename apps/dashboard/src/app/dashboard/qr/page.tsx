'use client';

import { QRCodeCanvas } from 'qrcode.react';
import { useEffect, useRef, useState } from 'react';

import { apiFetch } from '@/lib/api';
import {
  customerWebBaseUrl,
  qrFileNameFor,
  registerHrefFor,
} from '@/lib/merchant-qr';

/**
 * The customer-web origin, read once from config.
 *
 * The value used to be a literal in this file. That made it the fourth copy of
 * the host in the repository and the only one a customer's phone could be sent
 * through, so it belongs beside the URL builder rather than inside a component.
 */
const CUSTOMER_WEB_BASE_URL = customerWebBaseUrl(process.env.NEXT_PUBLIC_CUSTOMER_WEB_URL);

/**
 * The slice of `GET /v1/wallet/program` this page needs — the business's identity.
 *
 * `businessName` and `businessSlug` come from the joined read in the wallet worker
 * and are scoped to the tenant the operator token names. Before this change the
 * page had no access to either: the session carries `email`, `name`, `id` and
 * `role`, and this route returned `classId`, `reviewStatus` and the demo-mode
 * flags. That is why the name and the slug were constants here — not laziness, an
 * absent contract.
 */
interface WalletProgramIdentity {
  /** `tenants.name`, or `null` when there is no tenant row to join. */
  businessName: string | null;
  /**
   * `tenants.slug`, verbatim. `null` when there is no tenant row, and possibly
   * `''` — `tenants.slug` is `notNull` with no check constraint, so a blank slug is
   * a real value and the endpoint reports it rather than hiding it. Both are
   * "no public page", and neither is a slug this page may put in a URL.
   */
  businessSlug: string | null;
}

type QrState =
  /** The identity is on its way. Nothing is rendered, because nothing is known. */
  | { kind: 'loading' }
  /** The identity could not be read. */
  | { kind: 'error'; message: string }
  /** The identity is known, and there is no usable slug to build a URL from. */
  | { kind: 'no-slug'; businessName: string | null }
  /** The identity is known and names a public page. */
  | { kind: 'ready'; businessName: string | null; href: string; fileName: string };

export default function QRCodePage() {
  const qrRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);
  const [state, setState] = useState<QrState>({ kind: 'loading' });

  /**
   * Read this merchant's identity, then resolve it to a QR or to a reason.
   *
   * Fetched **once** and never re-fetched on a re-render. A refetch would be a
   * chance for the slug to change under a QR that has already been printed, and a
   * printed QR is the one artefact here that cannot be updated after the fact.
   */
  useEffect(() => {
    let live = true;

    apiFetch('/v1/wallet/program')
      .then((raw) => {
        if (!live) return;

        const program = (raw as { data: Partial<WalletProgramIdentity> }).data;

        // Read through `?? null` rather than defaulting to a name or a slug. A
        // fallback here would be a plausible-looking placeholder — precisely what
        // the customer-web delivery gate calls invented content — and this is the
        // page where a placeholder sends a customer to another merchant.
        const businessName = program?.businessName ?? null;
        const businessSlug = program?.businessSlug ?? null;

        // `registerHrefFor` is the single place a customer-web URL is assembled,
        // and it refuses rather than repairing. A blank or absent slug therefore
        // lands here with no URL, which is a state this page has to be able to
        // show — see `no-slug` below.
        const href = registerHrefFor(CUSTOMER_WEB_BASE_URL, businessSlug);

        if (href === null) {
          setState({ kind: 'no-slug', businessName });
          return;
        }

        const fileName = qrFileNameFor(businessName, businessSlug);

        // Both sources were absent, so there is no business to name the file after
        // and nothing to download. Refused rather than falling back to a bare
        // `vyloop-qr-.png`.
        if (fileName === null) {
          setState({ kind: 'no-slug', businessName });
          return;
        }

        setState({
          kind: 'ready',
          // The name is carried through as the API sent it, including `null`. It
          // is `tenants.name`, which is `notNull`, so in practice a slug implies a
          // name — but the card renders the heading only when there is one, so the
          // unreachable case degrades to no heading rather than to a wrong one.
          businessName,
          href,
          fileName,
        });
      })
      .catch((err) => {
        if (!live) return;
        setState({
          kind: 'error',
          message: err instanceof Error ? err.message : 'No se pudo leer el programa.',
        });
      });

    // A resolved fetch after unmount would set state on a gone component.
    return () => {
      live = false;
    };
  }, []);

  async function handleDownload() {
    // Narrowed rather than asserted: the button only exists in the `ready`
    // branch, and a handler that could reach any other state would be a way to
    // download a QR this page has no URL for.
    if (state.kind !== 'ready') return;

    const canvas = qrRef.current?.querySelector('canvas');
    if (!canvas) return;

    const url = canvas.toDataURL('image/png');
    const link = document.createElement('a');
    link.download = state.fileName;
    link.href = url;
    link.click();
  }

  async function handleCopyLink() {
    if (state.kind !== 'ready') return;

    try {
      await navigator.clipboard.writeText(state.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // The clipboard API is unavailable on an insecure origin and can be denied
      // by permission policy, so a textarea fallback still has to copy the same
      // URL — not a different one, and not a constant.
      const input = document.createElement('input');
      input.value = state.href;
      document.body.appendChild(input);
      input.select();
      document.execCommand('copy');
      document.body.removeChild(input);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

  /**
   * The two states with no QR, before the card.
   *
   * Both render no QR, no download and no copy link, and both say which of them
   * happened. The alternative — showing the card with the QR area blanked out —
   * would leave an operator unable to tell "still loading" from "no slug", and the
   * difference decides whether they retry or go fix their slug.
   */
  if (state.kind === 'loading' || state.kind === 'error') {
    return (
      <div className="qr-page">
        <div className="qr-card">
          <div className="qr-card-header">
            {/*
              An explicit loading line, not an empty page. The previous page had no
              state here at all — it was correct at first paint because its data was
              a constant — and the reason it can have one now is that its data is
              not.
            */}
            <h3>{state.kind === 'loading' ? 'Preparando tu QR…' : 'No se pudo preparar el QR'}</h3>
            <p className="qr-subtitle">
              {state.kind === 'loading'
                ? 'Estamos consultando los datos de tu negocio.'
                : state.message}
            </p>
          </div>
        </div>
      </div>
    );
  }

  /**
   * The business has no usable slug, so there is no URL and therefore no QR.
   *
   * This state exists because `tenants.slug` can be blank: the column is `notNull`
   * with no check constraint, and the worker's provisioning path already refuses a
   * blank slug for a pass's `homepageUri`. The API reports that blank verbatim, so
   * the page can distinguish "no slug" from "the request failed" — and it has to,
   * because the operator's next action is completely different in each case.
   *
   * It is stated in the operator's terms rather than as an error: nothing is
   * broken, the business simply has no public page yet, and a QR cannot be
   * printed for a page that does not exist. Rendering some other merchant's slug
   * here instead — or an empty `?biz=` — would produce a scannable code for a
   * business that is not this one, which is the original defect with a friendlier
   * label.
   */
  if (state.kind === 'no-slug') {
    return (
      <div className="qr-page">
        <div className="qr-card">
          <div className="qr-card-header">
            {/* Rendered only when the API reported one. `'Tu negocio'` was the
                fallback and it is exactly the thing being guarded against: a name
                this page did not receive, standing where the business's own name
                goes. */}
            {state.businessName && <h3>{state.businessName}</h3>}
            <p className="qr-subtitle">
              Este negocio todavía no tiene un slug público, así que no hay un QR para mostrar.
            </p>
          </div>

          <div className="qr-info">
            <p className="text-muted" style={{ margin: 0 }}>
              El QR apunta a la página de registro de tu negocio, y esa página se construye con su
              slug. Configura el slug y vuelve a abrir esta pantalla: aquí aparecerá el código
              listo para imprimir.
            </p>
          </div>
        </div>
      </div>
    );
  }

  const { businessName, href } = state;

  return (
    <div className="qr-page">
      <div className="qr-hero">
        <div className="qr-card" ref={qrRef}>
          <div className="qr-card-header">
            {/*
              From the API, never a constant. `Café Central` used to be written
              here, so every merchant's card was headed with another business's
              name — on the same page whose QR pointed at their registration form.

              Rendered only when there is one. A `businessName ?? ''` fallback would
              produce an empty `<h3>`, and an empty heading is still a heading
              promising a name the API did not supply. A merchant whose `tenants`
              row is missing gets a working QR and no invented name over it.
            */}
            {businessName && <h3>{businessName}</h3>}
            <p className="qr-subtitle">Escanea para acceder a tu tarjeta de puntos</p>
          </div>

          <div className="qr-code-wrapper">
            {/*
              `href` is known before this renders, and it does not change afterwards.
              That is the point of resolving it in the effect rather than rendering
              optimistically: an optimistic QR would be painted from a provisional
              value and repainted from the fetched one, and a customer scanning in
              between would be registered against the wrong merchant. There is no
              re-fetch and no derived value, so the destination is stable for the
              life of the mount.
            */}
            <QRCodeCanvas
              value={href}
              size={220}
              bgColor="#ffffff"
              fgColor="#0f172a"
              level="M"
              includeMargin
            />
          </div>

          {/*
            The same `href` the QR encodes, printed as text. A merchant putting
            this into a poster types it by hand, so a URL that disagreed with the
            code beside it would send customers somewhere the QR does not.
          */}
          <p className="qr-url">{href}</p>
        </div>

        <div className="qr-actions">
          <button className="btn-primary" onClick={handleDownload}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a4 0 0 1-4 4H5a4 0 0 1-4-4v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            Descargar QR
          </button>

          <button className="btn-secondary" onClick={handleCopyLink}>
            {copied ? (
              <>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
                ¡Copiado!
              </>
            ) : (
              <>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
                Copiar enlace
              </>
            )}
          </button>
        </div>
      </div>

      <div className="qr-info">
        <h4>¿Cómo funciona?</h4>
        <ol>
          <li>
            <strong>Mostrale este QR al cliente</strong> en la caja o en la mesa
          </li>
          <li>
            <strong>El cliente escanea</strong> con la cámara de su celular
          </li>
          <li>
            <strong>Se registra</strong> con su teléfono y empieza a acumular puntos
          </li>
        </ol>

        <div className="qr-tip">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="16" x2="12" y2="12" />
            <line x1="12" y1="8" x2="12.01" y2="8" />
          </svg>
          <span>
            Puedes imprimir este QR y ponerlo en la caja, o mostrarlo en una tablet en el mesón.
          </span>
        </div>
      </div>
    </div>
  );
}