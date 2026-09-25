import { ChevronDown, ChevronUp, QrCode } from 'lucide-react';
import QRCode from 'qrcode';
import { useCallback, useState } from 'react';

/** Rendered pixel size. Also set on the <img> so the image cannot reflow. */
const QR_SIZE = 200;

const IDLE_LABEL = 'Mostrar mi código';
const OPEN_LABEL = 'Ocultar mi código';

/**
 * The payload the counter scanner expects.
 *
 * This format is a LIVE contract, not a display choice. The dashboard POS
 * matches `/\/c\/([a-f0-9-]+)/i` against the scanned text and then resolves the
 * captured id through `/v1/customers/by-global-id/:globalId`. Any other
 * encoding — a full URL, a `vyloop://` scheme, a shortened code — still scans
 * as something, and fails silently at the counter, which is the worst possible
 * failure mode. Keep it exactly `/c/<globalId>`.
 */
function buildQrPayload(globalId: string): string {
  return `/c/${globalId}`;
}

/**
 * Groups a uuid the way it is already written, for reading aloud or typing.
 *
 * This is a rendering of the real `globalId` and nothing more. No commercial
 * code format is invented, because no such code exists in the database and a
 * customer quoting `OR-0428-17` at the counter would be quoting a fiction.
 */
/**
 * The readable member id, rendered as the raw `globalId`.
 *
 * A uuid already reads in its natural grouped form (8-4-4-4-12), so there is
 * nothing to reformat. Deliberately NOT a commercial code: no `OR-0428-17`
 * style exists in the database, and a customer reciting an invented code at
 * the counter would be reciting a fiction.
 */
function MemberId({ globalId }: { globalId: string }) {
  return (
    <div className="club-qr__id">
      <p className="club-qr__id-label">Tu código en el local</p>
      <p className="club-qr__id-value">{globalId}</p>
    </div>
  );
}

type QrState =
  | { status: 'closed' }
  | { status: 'generating' }
  | { status: 'ready'; dataUrl: string }
  | { status: 'failed' };

export function MemberQr({ globalId, fullName }: { globalId: string; fullName: string }) {
  const [state, setState] = useState<QrState>({ status: 'closed' });
  const isOpen = state.status !== 'closed';

  const generate = useCallback(async () => {
    setState({ status: 'generating' });

    try {
      const dataUrl = await QRCode.toDataURL(buildQrPayload(globalId), {
        width: QR_SIZE,
        margin: 2,
        color: { dark: '#27201d', light: '#ffffff' },
      });
      setState({ status: 'ready', dataUrl });
    } catch {
      // The readable id above stays on screen, and the retry is offered. A
      // placeholder image would be worse than nothing: at the counter it looks
      // like a working code that simply will not scan.
      setState({ status: 'failed' });
    }
  }, [globalId]);

  const toggle = useCallback(() => {
    if (isOpen) {
      setState({ status: 'closed' });
      return;
    }

    void generate();
  }, [isOpen, generate]);

  const retry = useCallback(() => {
    void generate();
  }, [generate]);

  return (
    <section className="club-qr" aria-labelledby="club-qr-title">
      <h2 className="club-qr__title" id="club-qr-title">
        Mostrar en el local
      </h2>

      <MemberId globalId={globalId} />

      <button
        type="button"
        className="club-qr__toggle"
        onClick={toggle}
        aria-expanded={isOpen}
        aria-controls="club-qr-panel"
      >
        <QrCode size={20} strokeWidth={1.75} aria-hidden="true" />
        <span>{isOpen ? OPEN_LABEL : IDLE_LABEL}</span>
        {isOpen ? (
          <ChevronUp size={18} aria-hidden="true" />
        ) : (
          <ChevronDown size={18} aria-hidden="true" />
        )}
      </button>

      {isOpen ? (
        <div className="club-qr__panel" id="club-qr-panel">
          {state.status === 'ready' ? (
            <img
              className="club-qr__image"
              src={state.dataUrl}
              // Descriptive, not decorative: a screen reader announces the
              // customer's name and the id the code carries.
              alt={`Código QR de ${fullName} para acumulare puntos en el local. Codifica el identificador ${globalId}.`}
              width={QR_SIZE}
              height={QR_SIZE}
            />
          ) : state.status === 'failed' ? (
            <div className="club-qr__failure" role="alert">
              <p className="club-qr__failure-text">
                No pudimos generar el código QR. Tu código de arriba sigue siendo válido en el local.
              </p>
              <button type="button" className="btn btn--outline club-qr__retry" onClick={retry}>
                Reintentar
              </button>
            </div>
          ) : (
            <div className="club-qr__pending" role="status" aria-live="polite">
              <span className="club-qr__spinner" aria-hidden="true" />
              <p className="club-qr__pending-text">Generando tu código…</p>
            </div>
          )}
        </div>
      ) : null}
    </section>
  );
}

export { QR_SIZE };
