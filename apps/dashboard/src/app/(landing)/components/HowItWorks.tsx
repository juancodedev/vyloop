import styles from '../landing.module.css';

/** In the order a customer lives them, so the numbers are a real sequence. */
const STEPS = [
  {
    title: 'Escanea el QR del local',
    text: 'Lo pegas en el mesón o la vitrina. Tu cliente entra con su número de teléfono, sin contraseña.',
  },
  {
    title: 'Guarda su tarjeta en Google Wallet',
    text: 'Con el nombre y el logo de tu local. El saldo se actualiza solo después de cada compra.',
  },
  {
    title: 'En caja, suma según lo que compra',
    text: 'Quien atiende escanea la tarjeta, escribe el monto de la boleta y los puntos se calculan solos.',
  },
];

export function HowItWorks() {
  return (
    <section id="como-funciona" className={styles.steps}>
      <div className={`${styles.wrap} ${styles.stepsInner}`}>
        <h2 className={`${styles.display} ${styles.sectionTitle}`}>
          Así suma un cliente, de la puerta a la caja.
        </h2>
        <ol className={styles.stepList}>
          {STEPS.map((step) => (
            <li key={step.title} className={styles.step}>
              <h3 className={styles.stepTitle}>{step.title}</h3>
              <p className={styles.stepText}>{step.text}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
