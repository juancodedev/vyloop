import { Button } from '@vyloop/design-system';
import { ArrowRight, Play } from 'lucide-react';
import Link from 'next/link';

import styles from './Hero.module.css';

export function Hero() {
  return (
    <section className={styles.section}>
      <div className={styles.content}>
        <h1 className={styles.headline}>
          Fideliza a tus clientes sin complicarte
        </h1>
        <p className={styles.subheadline}>
          Crea un programa de lealtad en minutos. Tus clientes acumulan puntos y
          canjean recompensas desde su celular. Sin integraciones complejas.
        </p>
        <div className={styles.ctas}>
          <Link href="/login?signup=true">
            <Button variant="primary" size="lg" icon={<ArrowRight size={18} />}>
              Comenzar gratis — sin tarjeta
            </Button>
          </Link>
          <Link href="#demo">
            <Button variant="outline" size="lg" icon={<Play size={18} />}>
              Ver demo en vivo
            </Button>
          </Link>
        </div>
        <p className={styles.socialProof}>
          +500 negocios en Latinoamérica confían en vyloop
        </p>
      </div>
    </section>
  );
}
