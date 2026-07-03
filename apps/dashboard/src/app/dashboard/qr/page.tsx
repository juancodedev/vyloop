'use client';

import { QRCodeCanvas } from 'qrcode.react';
import { useRef, useState } from 'react';

const CUSTOMER_WEB_URL = 'https://vyloop-customer-web.pages.dev/register?biz=cafe-central';
const BUSINESS_SLUG = 'cafe-central';
const BUSINESS_NAME = 'Café Central';

export default function QRCodePage() {
  const qrRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);

  async function handleDownload() {
    const canvas = qrRef.current?.querySelector('canvas');
    if (!canvas) return;

    const url = canvas.toDataURL('image/png');
    const link = document.createElement('a');
    link.download = `vyloop-qr-${BUSINESS_NAME.toLowerCase().replace(/\s+/g, '-')}.png`;
    link.href = url;
    link.click();
  }

  async function handleCopyLink() {
    try {
      await navigator.clipboard.writeText(CUSTOMER_WEB_URL);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // fallback
      const input = document.createElement('input');
      input.value = CUSTOMER_WEB_URL;
      document.body.appendChild(input);
      input.select();
      document.execCommand('copy');
      document.body.removeChild(input);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

  return (
    <div className="qr-page">
      <div className="qr-hero">
        <div className="qr-card" ref={qrRef}>
          <div className="qr-card-header">
            <h3>{BUSINESS_NAME}</h3>
            <p className="qr-subtitle">Escaneá para acceder a tu tarjeta de puntos</p>
          </div>

          <div className="qr-code-wrapper">
            <QRCodeCanvas
              value={CUSTOMER_WEB_URL}
              size={220}
              bgColor="#ffffff"
              fgColor="#0f172a"
              level="M"
              includeMargin
            />
          </div>

          <p className="qr-url">{CUSTOMER_WEB_URL}</p>
        </div>

        <div className="qr-actions">
          <button className="btn-primary" onClick={handleDownload}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
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
            Podés imprimir este QR y ponerlo en la caja, o mostrarlo en una tablet en el mostrador.
          </span>
        </div>
      </div>
    </div>
  );
}
