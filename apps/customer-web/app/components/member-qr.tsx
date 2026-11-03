import QRCode from 'qrcode';
import { useCallback, useEffect, useRef, useState } from 'react';

/** Rendered pixel size. Also set on the <img> so the image cannot reflow. */
const QR_SIZE = 210;

/**
 * The payload the counter scanner expects.
 *
 * This format is a LIVE contract, not a display choice. It is exactly one of:
 *
 * - `/c/<card_token>` — the opaque, rotatable `vyc1.` credential from
 *   `GET /v1/wallet/card`, the same one the Wallet pass barcode carries. The
 *   dashboard POS resolves it through `/v1/customers/by-card-token/:token`.
 * - `/c/<globalId>` — only when that route answers `null` (a legacy customer
 *   whose issued pass still carries the uuid) or the call fails. The POS
 *   resolves it through `/v1/customers/by-global-id/:globalId`, which refuses
 *   the uuid of a customer who already has a token.
 *
 * The dashboard POS parser accepts both forms. Any other encoding — a full
 * URL, a `vyloop://` scheme, a shortened code — still scans as something, and
 * fails silently at the counter, which is the worst possible failure mode.
 */
function buildQrPayload(globalId: string, cardToken: string | null): string {
  return `/c/${cardToken ?? globalId}`;
}

type QrState =
  | { status: 'generating' }
  | { status: 'ready'; dataUrl: string }
  | { status: 'failed' };

/**
 * The member QR, generated as soon as it is mounted.
 *
 * It lives inside `QrSheet`, so mounting it *is* the customer asking for the
 * code. `cardToken` is resolved by the dock: `undefined` while that request is
 * in flight (the pending state shows, and nothing is drawn, so a uuid QR never
 * flashes before the token), then the token or `null` for the uuid fallback.
 *
 * On failure the retry is offered and, when the sheet has no member code to
 * dictate, the raw `globalId` stays readable as the fallback — never the token,
 * which is a scanner credential and not something to read out loud. A
 * placeholder image would be worse than nothing, because at the counter it
 * looks like a working code that simply will not scan.
 */
export function MemberQrCode({
  globalId,
  cardToken,
  fullName,
  showIdOnFailure,
}: {
  globalId: string;
  cardToken: string | null | undefined;
  fullName: string;
  showIdOnFailure: boolean;
}) {
  const [state, setState] = useState<QrState>({ status: 'generating' });

  /**
   * Whether the component is still mounted when the encoder answers.
   *
   * The sheet can be closed while a slow phone is still drawing the code, and
   * a late `setState` on an unmounted component is a no-op at best. A ref
   * rather than state because the check needs the value at the moment the
   * promise lands, not the one captured when the request went out.
   */
  const live = useRef(true);

  const resolved = cardToken !== undefined;
  const payload = resolved ? buildQrPayload(globalId, cardToken) : null;

  const generate = useCallback(async () => {
    if (payload === null) return;
    setState({ status: 'generating' });

    try {
      const dataUrl = await QRCode.toDataURL(payload, {
        width: QR_SIZE,
        margin: 2,
        color: { dark: '#27201d', light: '#ffffff' },
      });

      if (live.current) setState({ status: 'ready', dataUrl });
    } catch {
      if (live.current) setState({ status: 'failed' });
    }
  }, [payload]);

  useEffect(() => {
    live.current = true;
    void Promise.resolve().then(() => {
      if (live.current) void generate();
    });

    return () => {
      live.current = false;
    };
  }, [generate]);

  if (state.status === 'ready' && resolved) {
    return (
      <img
        className="club-qr__image"
        src={state.dataUrl}
        // Descriptive, not decorative: a screen reader announces the
        // customer's name and, for the uuid payload, the id the code carries.
        // A token is not read aloud: it is long, opaque and means nothing.
        alt={`Código QR de ${fullName} para acumular puntos en el local.${cardToken ? '' : ` Codifica el identificador ${globalId}.`}`}
        width={QR_SIZE}
        height={QR_SIZE}
      />
    );
  }

  if (state.status === 'failed' && resolved) {
    return (
      <div className="club-qr__failure" role="alert">
        <p className="club-qr__failure-text">No pudimos generar el código QR.</p>
        {showIdOnFailure ? (
          <div className="club-qr__id">
            <p className="club-qr__id-label">Tu código en el local</p>
            <p className="club-qr__id-value">{globalId}</p>
          </div>
        ) : null}
        <button type="button" className="btn btn--outline club-qr__retry" onClick={() => void generate()}>
          Reintentar
        </button>
      </div>
    );
  }

  return (
    <div className="club-qr__pending" role="status" aria-live="polite">
      <span className="club-qr__spinner" aria-hidden="true" />
      <p className="club-qr__pending-text">Generando tu código…</p>
    </div>
  );
}

export { QR_SIZE };
