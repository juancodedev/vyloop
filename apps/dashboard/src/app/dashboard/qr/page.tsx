'use client';

import { Button } from '@vyloop/design-system';
import { Check, Copy, Download, Info } from 'lucide-react';
import { QRCodeCanvas } from 'qrcode.react';
import { useRef, useState } from 'react';

import styles from './page.module.css';

const CUSTOMER_WEB_URL = 'https://vyloop-customer-web.pages.dev/register?biz=cafe-central';
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
    <div className={styles.page}>
      {/* QR Card */}
      <div className={styles.card} ref={qrRef}>
        <div>
          <h2 className={styles.cardTitle}>{BUSINESS_NAME}</h2>
          <p className={styles.subtitle}>Escaneá para acceder a tu tarjeta de puntos</p>
        </div>

        <div className={styles.qrWrap}>
          <QRCodeCanvas
            value={CUSTOMER_WEB_URL}
            size={220}
            bgColor="#ffffff"
            fgColor="#0f172a"
            level="M"
            includeMargin
          />
        </div>

        <p className={styles.url}>{CUSTOMER_WEB_URL}</p>
      </div>

      {/* Actions */}
      <div className={styles.actions}>
        <Button icon={<Download size={16} />} onClick={handleDownload}>
          Descargar QR
        </Button>
        <Button
          variant="secondary"
          icon={copied ? <Check size={16} /> : <Copy size={16} />}
          onClick={handleCopyLink}
        >
          {copied ? '¡Copiado!' : 'Copiar enlace'}
        </Button>
      </div>

      {/* Info */}
      <div className={styles.info}>
        <h3 className={styles.infoTitle}>¿Cómo funciona?</h3>
        <ol className={styles.steps}>
          <li className={styles.step}>
            <span className={styles.stepNum}>1</span>
            <span className={styles.stepText}>
              <strong>Mostrale este QR al cliente</strong> en la caja o en la mesa
            </span>
          </li>
          <li className={styles.step}>
            <span className={styles.stepNum}>2</span>
            <span className={styles.stepText}>
              <strong>El cliente escanea</strong> con la cámara de su celular
            </span>
          </li>
          <li className={styles.step}>
            <span className={styles.stepNum}>3</span>
            <span className={styles.stepText}>
              <strong>Se registra</strong> con su teléfono y empieza a acumular puntos
            </span>
          </li>
        </ol>

        <div className={styles.tip}>
          <Info className={styles.tipIcon} size={18} />
          <span>
            Podés imprimir este QR y ponerlo en la caja, o mostrarlo en una tablet en el mostrador.
          </span>
        </div>
      </div>
    </div>
  );
}
