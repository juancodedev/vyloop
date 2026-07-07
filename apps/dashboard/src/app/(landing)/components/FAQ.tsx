import styles from './FAQ.module.css';

const FAQ_ITEMS = [
  {
    question: '¿Qué es vyloop?',
    answer:
      'Vyloop es un programa de lealtad digital para pequeños y medianos negocios en Latinoamérica. Te permite crear un sistema de puntos y recompensas para tus clientes en minutos, sin necesidad de conocimientos técnicos. Tus clientes acumulan puntos con cada compra y los canjean por los premios que tú elijas.',
  },
  {
    question: '¿Cuánto tiempo toma configurarlo?',
    answer:
      'Puedes tener todo funcionando en menos de 10 minutos. Solo registras a tus clientes, defines las reglas de acumulación y las recompensas, y listo. No hay instalaciones ni configuraciones complicadas.',
  },
  {
    question: '¿Necesito integrarlo con mi sistema de ventas?',
    answer:
      'No es necesario. Puedes empezar sin ninguna integración. Cuando estés listo, podemos conectarlo con tu sistema de ventas para que los puntos se asignen automáticamente con cada transacción.',
  },
  {
    question: '¿Mis clientes necesitan descargar una app?',
    answer:
      'No. Tus clientes ven sus puntos directamente desde su navegador o los reciben por WhatsApp. No necesitan instalar nada. Para ellos es tan simple como abrir un enlace.',
  },
  {
    question: '¿Hay un contrato mínimo?',
    answer:
      'No. Puedes cancelar en cualquier momento sin multas ni cargos extras. Creemos que nuestro servicio debe ganarse tu confianza cada mes.',
  },
  {
    question: '¿Cómo acumulan puntos mis clientes?',
    answer:
      'Tú defines las reglas: por ejemplo, 1 punto por cada dólar gastado, o un punto por cada compra. Los puntos se asignan automáticamente cuando registras la compra de tu cliente en el sistema.',
  },
  {
    question: '¿Qué tipo de soporte ofrecen?',
    answer:
      'Todos los planes incluyen soporte por email. En el plan Pro tienes soporte prioritario con respuestas más rápidas. Y en Enterprise cuentas con un gerente de cuenta dedicado para ti.',
  },
];

export function FAQ() {
  return (
    <section className={styles.section} id="faq">
      <h2 className={styles.title}>Preguntas frecuentes</h2>
      <p className={styles.subtitle}>
        Todo lo que necesitas saber antes de empezar
      </p>
      <div className={styles.list}>
        {FAQ_ITEMS.map((item) => (
          <details key={item.question} className={styles.details}>
            <summary className={styles.summary}>{item.question}</summary>
            <div className={styles.answer}>
              <p>{item.answer}</p>
            </div>
          </details>
        ))}
      </div>
    </section>
  );
}
