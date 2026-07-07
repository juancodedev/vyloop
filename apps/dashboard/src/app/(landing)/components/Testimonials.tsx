import styles from './Testimonials.module.css';

const TESTIMONIALS = [
  {
    quote:
      'En dos semanas teníamos todo funcionando. Nuestros clientes aman poder ver sus puntos desde el celular.',
    name: 'María García',
    business: 'Café Central, Santiago',
    initials: 'MG',
  },
  {
    quote:
      'Dejamos las tarjetas de papel. Ahora la gente vuelve porque sabe que acumula puntos con cada compra.',
    name: 'Carlos Medina',
    business: 'Ferretería El Constructor, Lima',
    initials: 'CM',
  },
  {
    quote:
      'Lo mejor es que no necesitamos una app. Con el WhatsApp ya tienen todo.',
    name: 'Ana Lucía Pérez',
    business: 'Boutique Serena, Bogotá',
    initials: 'AP',
  },
];

export function Testimonials() {
  return (
    <section className={styles.section} id="testimonials">
      <h2 className={styles.title}>Lo que dicen nuestros clientes</h2>
      <p className={styles.subtitle}>
        Negocios como el tuyo ya están transformando su relación con los clientes
      </p>
      <div className={styles.grid}>
        {TESTIMONIALS.map((t) => (
          <article key={t.name} className={styles.card}>
            <div className={styles.avatar}>{t.initials}</div>
            <p className={styles.quote}>&ldquo;{t.quote}&rdquo;</p>
            <div className={styles.author}>
              <span className={styles.name}>{t.name}</span>
              <span className={styles.business}>{t.business}</span>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
