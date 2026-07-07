import { Button } from '@vyloop/design-system';
import { Check } from 'lucide-react';
import Link from 'next/link';

import styles from './Pricing.module.css';

const TIERS = [
  {
    name: 'Gratis',
    price: '$0',
    period: '/mes',
    description: 'Perfecto para empezar',
    href: '/login?signup=true',
    highlighted: false,
    features: [
      'Hasta 100 clientes',
      '1 nivel de lealtad',
      '1 recompensa activa',
      'Dashboard básico',
      'Soporte por email',
    ],
  },
  {
    name: 'Pro',
    price: '$29',
    period: '/mes',
    description: 'Para negocios en crecimiento',
    href: '/login?signup=true',
    highlighted: true,
    features: [
      'Clientes ilimitados',
      'Niveles ilimitados',
      'Recompensas ilimitadas',
      'Dashboard completo',
      'Exportación de datos',
      'Soporte prioritario',
    ],
  },
  {
    name: 'Enterprise',
    price: 'Contactar',
    period: '',
    description: 'Para grandes operaciones',
    href: '#contact',
    highlighted: false,
    features: [
      'Todo lo de Pro',
      'API dedicada',
      'Integraciones personalizadas',
      'SLA de disponibilidad',
      'Gerente de cuenta dedicado',
    ],
  },
];

export function Pricing() {
  return (
    <section className={styles.section} id="pricing">
      <h2 className={styles.title}>Planes simples, sin sorpresas</h2>
      <p className={styles.subtitle}>
        Elige el plan que mejor se adapte a tu negocio. Cambia o cancela cuando
        quieras.
      </p>
      <div className={styles.grid}>
        {TIERS.map((tier) => (
          <article
            key={tier.name}
            className={`${styles.card} ${tier.highlighted ? styles.cardHighlighted : ''}`}
          >
            {tier.highlighted && (
              <span className={styles.badge}>Más popular</span>
            )}
            <h3 className={styles.tierName}>{tier.name}</h3>
            <div className={styles.priceRow}>
              <span className={styles.price}>{tier.price}</span>
              {tier.period && (
                <span className={styles.period}>{tier.period}</span>
              )}
            </div>
            <p className={styles.description}>{tier.description}</p>
            <ul className={styles.featureList}>
              {tier.features.map((f) => (
                <li key={f} className={styles.featureItem}>
                  <Check size={16} className={styles.checkIcon} aria-hidden="true" />
                  <span>{f}</span>
                </li>
              ))}
            </ul>
            <div className={styles.ctaWrap}>
              <Link href={tier.href}>
                <Button
                  variant={tier.highlighted ? 'primary' : 'secondary'}
                  size="lg"
                  fullWidth
                >
                  {tier.name === 'Enterprise' ? 'Contactar ventas' : 'Comenzar gratis'}
                </Button>
              </Link>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
