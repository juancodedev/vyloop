import styles from '../landing.module.css';

/** Only what the product does today. */
const FEATURES = [
  {
    name: 'Tarjeta en Google Wallet',
    text: 'Con tu nombre y tu logo. Se actualiza sola con cada compra.',
  },
  {
    name: 'Puntos por monto de compra',
    text: 'Tú decides cuántos pesos vale un punto.',
  },
  {
    name: 'Niveles y premios',
    text: 'Bronce, Plata y Oro, o los nombres que quieras. Premios que se canjean en caja.',
  },
  {
    name: 'Varias sucursales',
    text: 'Un solo programa; el cliente suma en cualquiera de tus locales.',
  },
  {
    name: 'Avisos al celular',
    text: 'Campañas que llegan a quienes aceptaron recibirlas.',
  },
  {
    name: 'Tus clientes, a la vista',
    text: 'Quién vino, cuánto compró y quién hace rato que no aparece.',
  },
];

export function Features() {
  return (
    <section id="que-incluye" className={styles.features}>
      <div className={`${styles.wrap} ${styles.featuresInner}`}>
        <h2 className={`${styles.display} ${styles.cashierTitle}`}>Qué incluye</h2>
        <dl className={styles.featureList}>
          {FEATURES.map((feature) => (
            <div key={feature.name}>
              <dt className={styles.featureName}>{feature.name}</dt>
              <dd className={styles.featureText}>{feature.text}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}
