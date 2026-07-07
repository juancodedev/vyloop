import {
  BarChart3,
  Gift,
  Smartphone,
  QrCode,
  MessageSquare,
  Unlink,
} from 'lucide-react';

import styles from './Features.module.css';

const FEATURES = [
  {
    icon: Gift,
    title: 'Puntos automáticos',
    description:
      'Olvídate de tarjetas de papel. Los puntos se asignan solos.',
  },
  {
    icon: Smartphone,
    title: 'Programa tu lealtad',
    description:
      'Define niveles, recompensas y reglas desde un panel simple.',
  },
  {
    icon: QrCode,
    title: 'QR para tu local',
    description:
      'Tus clientes escanean y ven sus puntos al instante.',
  },
  {
    icon: BarChart3,
    title: 'Dashboard en vivo',
    description:
      'Mira quién compra más, quién canjea y cómo crece tu negocio.',
  },
  {
    icon: MessageSquare,
    title: 'Segmenta y comunica',
    description:
      'Envía ofertas por WhatsApp a tus mejores clientes.',
  },
  {
    icon: Unlink,
    title: 'Sin contratos',
    description:
      'Cancela cuando quieras. Sin multas ni permanencia.',
  },
];

export function Features() {
  return (
    <section className={styles.section} id="features">
      <h2 className={styles.title}>Todo lo que necesitas</h2>
      <p className={styles.subtitle}>
        Tu programa de lealtad completo, sin complicaciones
      </p>
      <div className={styles.grid}>
        {FEATURES.map((feature) => {
          const Icon = feature.icon;
          return (
            <div key={feature.title} className={styles.card}>
              <div className={styles.iconWrap}>
                <Icon size={22} aria-hidden="true" />
              </div>
              <h3 className={styles.cardTitle}>{feature.title}</h3>
              <p className={styles.cardDesc}>{feature.description}</p>
            </div>
          );
        })}
      </div>
    </section>
  );
}
