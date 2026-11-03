import styles from '../landing.module.css';

/** Each vyloop cell states something the product does today. */
const ROWS = [
  {
    paper: 'Se pierde, se moja o queda en otra billetera.',
    vyloop: 'Va en el celular, en Google Wallet.',
  },
  {
    paper: 'Un timbre por visita, compre lo que compre.',
    vyloop: 'Puntos según el monto de la boleta: quien compra más, suma más.',
  },
  {
    paper: 'No sabes quién la tiene.',
    vyloop: 'Sabes quién vino, cuánto compró y cuándo.',
  },
  {
    paper: 'No tienes cómo avisarle de una promoción.',
    vyloop: 'Le envías una campaña, si aceptó recibirlas.',
  },
  {
    paper: 'Para cambiar el premio hay que imprimir otra.',
    vyloop: 'Cambias premios y niveles desde el panel.',
  },
];

export function Comparison() {
  return (
    <section className={styles.compare} aria-labelledby="comparacion-titulo">
      <div className={`${styles.wrap} ${styles.featuresInner}`}>
        <h2 id="comparacion-titulo" className={`${styles.display} ${styles.cashierTitle}`}>
          La tarjeta de papel contra vyloop
        </h2>
        <table className={styles.compareTable}>
          <thead>
            <tr>
              <th scope="col">Tarjeta de papel</th>
              <th scope="col">Con vyloop</th>
            </tr>
          </thead>
          <tbody>
            {ROWS.map((row) => (
              <tr key={row.paper} data-row>
                <td className={styles.comparePaper}>{row.paper}</td>
                <td className={styles.compareVyloop}>{row.vyloop}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
