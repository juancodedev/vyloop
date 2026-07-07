import styles from './HowItWorks.module.css';

const STEPS = [
  {
    number: 1,
    title: 'Registra a tus clientes',
    description:
      'Crea perfiles con su número de WhatsApp. No necesitan app.',
  },
  {
    number: 2,
    title: 'Acumulan puntos',
    description:
      'Cada compra suma puntos automáticos. Tú defines las reglas.',
  },
  {
    number: 3,
    title: 'Canjean recompensas',
    description:
      'Tus clientes canjean sus puntos por los premios que elijas.',
  },
];

export function HowItWorks() {
  return (
    <section className={styles.section}>
      <h2 className={styles.title}>Cómo funciona vyloop</h2>
      <p className={styles.subtitle}>
        Tres pasos simples para tener tu programa de lealtad funcionando
      </p>
      <div className={styles.grid}>
        {STEPS.map((step) => (
          <div key={step.number} className={styles.card}>
            <span className={styles.number}>{step.number}</span>
            <h3 className={styles.cardTitle}>{step.title}</h3>
            <p className={styles.cardDesc}>{step.description}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
