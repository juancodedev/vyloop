import { QrCode } from 'lucide-react';
import Link from 'next/link';

import styles from '../landing.module.css';

export function Hero() {
  return (
    <section className={`${styles.wrap} ${styles.hero}`}>
      <div className={styles.heroText}>
        <div className={styles.sign}>
          <h1 className={`${styles.display} ${styles.headline}`}>
            Tus clientes vuelven, y su tarjeta ya va en el celular.
          </h1>
        </div>
        <p className={styles.lead}>
          Un programa de puntos para tu café o almacén. Tus clientes suman puntos según lo que
          compran, y los ven en Google Wallet, sin bajar otra app.
        </p>
        <div className={styles.ctas}>
          <Link href="/login?signup=true" className={styles.pill}>
            Crear mi comercio
          </Link>
          <a href="#como-funciona" className={styles.textLink}>
            Ver cómo funciona
          </a>
        </div>
      </div>

      <div className={styles.heroPass}>
        <WalletPass />
      </div>
    </section>
  );
}

/** An example of the pass a customer saves: what it shows, not a real account. */
function WalletPass() {
  return (
    <div
      className={styles.pass}
      role="img"
      aria-label="Ejemplo de tarjeta en Google Wallet: 1.240 puntos, nivel Plata"
    >
      <div className={styles.passShop}>
        <span className={styles.passMark}>C</span>
        Café del Barrio
      </div>
      <div className={styles.passBalance}>
        <div className={styles.passLabel}>Saldo</div>
        <div className={styles.passPoints}>
          1.240 <span className={styles.passUnit}>puntos</span>
        </div>
      </div>
      <div className={styles.passMeta}>
        <div>
          <div className={styles.passLabel}>Nivel</div>
          Plata
        </div>
        <div style={{ textAlign: 'right' }}>
          <div className={styles.passLabel}>Socia</div>
          Ana Rojas
        </div>
      </div>
      <div className={styles.passCode}>
        <QrCode size={104} strokeWidth={1.5} aria-hidden="true" />
      </div>
    </div>
  );
}
