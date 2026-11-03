import styles from '../landing.module.css';

/**
 * Every answer is backed by the product as it ships: the POS looks a customer up
 * by phone, and the customer web shows balance, next reward and history. There is
 * no Apple Wallet pass, so no answer promises one.
 */
const QUESTIONS = [
  {
    question: '¿Mis clientes tienen que bajar una app?',
    answer:
      'No. Escanean el QR del local, entran con su número de teléfono y guardan la tarjeta en Google Wallet.',
  },
  {
    question: '¿Y si mi cliente tiene iPhone?',
    answer:
      'Igual suma puntos. En caja lo buscas por su teléfono, y desde la página de tu programa, en el navegador, ve su saldo, su próximo premio y su historial. Por ahora, la tarjeta en el celular es para Google Wallet.',
  },
  {
    question: '¿Qué necesito para empezar?',
    answer:
      'Crear tu comercio, decidir cuántos pesos vale un punto y descargar el QR desde el panel para pegarlo en el mesón. Quien atiende usa la pantalla de caja del panel.',
  },
  {
    question: '¿Por qué puntos y no timbres?',
    answer:
      'Con timbres, un café y un almuerzo valen lo mismo. Con puntos según el monto, cada compra suma lo que vale, y tú eliges cuántos pesos vale un punto.',
  },
  {
    question: '¿Funciona si tengo varias sucursales?',
    answer: 'Sí. Es un solo programa, y el cliente suma en cualquiera de tus locales.',
  },
  {
    question: '¿Qué pasa con los datos de mis clientes?',
    answer:
      'Cada cliente ve sus datos y puede eliminar su cuenta cuando quiera. Las campañas solo llegan a quienes aceptaron recibirlas.',
  },
];

export function Faq() {
  return (
    <section id="preguntas" className={styles.features}>
      <div className={`${styles.wrap} ${styles.featuresInner}`}>
        <h2 className={`${styles.display} ${styles.cashierTitle}`}>Preguntas frecuentes</h2>
        <div className={styles.faqList}>
          {QUESTIONS.map((item) => (
            <details key={item.question} className={styles.faqItem}>
              <summary className={styles.faqQuestion}>{item.question}</summary>
              <p className={styles.featureText}>{item.answer}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}
