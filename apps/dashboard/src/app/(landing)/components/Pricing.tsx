import Link from 'next/link';

import styles from '../landing.module.css';

/**
 * The published plans. Plus is priced so Pro reads as the better deal.
 *
 * Nothing in the product enforces these limits yet: see `odd/tasks/plan-limits.md`.
 * Every item listed is a feature that exists today.
 */
const PLANS = [
  {
    name: 'Local',
    price: '$19.990',
    pitch: 'Para empezar con un local.',
    items: ['Tarjeta en Google Wallet', 'Puntos por monto de compra', 'Pantalla de caja', '1 sucursal'],
    recommended: false,
  },
  {
    name: 'Plus',
    price: '$34.990',
    pitch: 'Para avisar de vez en cuando.',
    items: ['Todo lo de Local', 'Hasta 4 campañas al mes'],
    recommended: false,
  },
  {
    name: 'Pro',
    price: '$39.990',
    pitch: 'Por $5.000 más que Plus, campañas sin límite y todo lo demás.',
    items: [
      'Todo lo de Plus',
      'Campañas ilimitadas',
      'Niveles y premios',
      'Quién dejó de venir',
      'Hasta 3 sucursales',
    ],
    recommended: true,
  },
];

export function Pricing() {
  return (
    <section id="precios" className={styles.features} aria-labelledby="precios-titulo">
      <div className={`${styles.wrap} ${styles.featuresInner}`}>
        <h2 id="precios-titulo" className={`${styles.display} ${styles.cashierTitle}`}>
          Precios
        </h2>
        <p className={styles.cashierLead}>
          Precios mensuales en pesos chilenos. Si pagas el año, te regalamos 2 meses.
        </p>
        <div className={styles.planList}>
          {PLANS.map((plan) => (
            <article
              key={plan.name}
              className={`${styles.plan} ${plan.recommended ? styles.planRecommended : ''}`}
            >
              {plan.recommended ? <span className={styles.planBadge}>Recomendado</span> : null}
              <h3 className={styles.planName}>{plan.name}</h3>
              <p className={styles.planPrice}>
                <span className={styles.display}>{plan.price}</span>
                <span className={styles.planPeriod}> al mes</span>
              </p>
              <p className={styles.planPitch}>{plan.pitch}</p>
              <ul className={styles.planItems}>
                {plan.items.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
              <Link
                href="/login?signup=true"
                className={`${styles.pill} ${plan.recommended ? '' : styles.pillInk}`}
              >
                Crear mi comercio
              </Link>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
