import styles from '../landing.module.css';

/**
 * A picture of the till, drawn in markup so it stays sharp and translatable. It
 * is an illustration, not a form: nothing in it can be typed into or pressed.
 */
export function CashierPreview() {
  return (
    <section className={`${styles.wrap} ${styles.cashier}`}>
      <div className={styles.cashierText}>
        <h2 className={`${styles.display} ${styles.cashierTitle}`}>
          Hecho para la caja, no para una planilla.
        </h2>
        <p className={styles.cashierLead}>
          Una sola pantalla para quien atiende: escanear, escribir el monto, sumar o canjear. Sin
          menús que cargar ni productos que mantener.
        </p>
      </div>

      <div
        className={styles.till}
        role="img"
        aria-label="Ejemplo de la caja: boleta de $4.500 que suma 45 puntos"
      >
        <div className={styles.tillHead}>
          <span className={styles.tillName}>Ana Rojas</span>
          <span className={styles.tillMuted}>Plata · 1.240 puntos</span>
        </div>
        <span className={styles.tillLabel}>Monto de la boleta</span>
        <div className={styles.tillAmount}>$4.500</div>
        <div className={styles.tillFoot}>
          <span>
            Suma <strong>+45 puntos</strong>
          </span>
          <span className={styles.tillButton}>Sumar puntos</span>
        </div>
      </div>
    </section>
  );
}
