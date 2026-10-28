'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

import styles from './summary.module.css';

import { api } from '@/lib/api';
import type { KpiResponse, TimelineEvent } from '@/lib/api';

const formatNumber = (n: number) => n.toLocaleString('es-CL');

function formatRelative(time: string): string {
  const diff = Date.now() - new Date(time).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Ahora';
  if (mins < 60) return `Hace ${mins} min`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `Hace ${hrs} h`;
  const days = Math.floor(hrs / 24);
  if (days === 1) return 'Ayer';
  return `Hace ${days} días`;
}

function firstTwoWords(text: string): string {
  return text.split(' ').slice(0, 2).join(' ');
}

/**
 * The summary: one place for the numbers Inicio, Programa and Analytics used to
 * repeat. They are totals since the program started, because that is what the
 * API reports; the page says so rather than calling them "today".
 */
export default function SummaryPage() {
  const [kpis, setKpis] = useState<KpiResponse | null>(null);
  const [timeline, setTimeline] = useState<TimelineEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([api.getKpis(), api.getTimeline()])
      .then(([kpiData, timelineData]) => {
        setKpis(kpiData);
        setTimeline(timelineData);
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="loading-screen">
        <div className="spinner" />
        <p className="text-muted">Cargando resumen…</p>
      </div>
    );
  }

  if (error || !kpis) {
    return (
      <div className="page">
        <div className="empty-state">
          <p>{error ?? 'No pudimos cargar el resumen.'}</p>
          <button className="btn btn-primary mt-4" onClick={() => window.location.reload()}>
            Reintentar
          </button>
        </div>
      </div>
    );
  }

  const tiers = Object.entries(kpis.tierDistribution);

  return (
    <div className={styles.page}>
      <p className={styles.date}>
        {new Date().toLocaleDateString('es-CL', { weekday: 'long', day: 'numeric', month: 'long' })}
      </p>

      <section aria-labelledby="summary-totals" className={styles.totalsBlock}>
        <h2 id="summary-totals" className={styles.blockTitle}>
          Desde que empezó tu programa
        </h2>
        <dl className={styles.totals}>
          <div className={styles.total}>
            <dt className={styles.totalLabel}>Clientes</dt>
            <dd className={styles.totalValue}>{formatNumber(kpis.totalCustomers)}</dd>
            <dd className={styles.totalNote}>{formatNumber(kpis.activeCustomers)} activos</dd>
          </div>
          <div className={styles.total}>
            <dt className={styles.totalLabel}>Puntos entregados</dt>
            <dd className={styles.totalValue}>{formatNumber(kpis.totalPointsIssued)}</dd>
            <dd className={styles.totalNote}>{formatNumber(kpis.totalPointsRedeemed)} canjeados</dd>
          </div>
          <div className={styles.total}>
            <dt className={styles.totalLabel}>Premios canjeados</dt>
            <dd className={styles.totalValue}>{formatNumber(kpis.rewardsClaimed)}</dd>
          </div>
          <div className={styles.total}>
            <dt className={styles.totalLabel}>Puntos que vuelven como premio</dt>
            <dd className={styles.totalValue}>{kpis.redemptionRate}%</dd>
          </div>
        </dl>
      </section>

      <div className={styles.columns}>
        <section aria-labelledby="summary-activity" className={styles.activity}>
          <h2 id="summary-activity" className={styles.blockTitle}>
            Movimientos recientes
          </h2>
          {timeline.length === 0 ? (
            <p className={styles.empty}>
              Todavía no hay movimientos. El primero aparece cuando sumes puntos en la{' '}
              <Link href="/dashboard/loyalty/pos">caja</Link>.
            </p>
          ) : (
            <ul className={styles.feed}>
              {timeline.slice(0, 15).map((ev, i) => (
                <li key={i} className={styles.feedItem}>
                  <span>
                    <strong>{firstTwoWords(ev.customerName)}</strong> {ev.description}
                  </span>
                  <time className={styles.feedTime} dateTime={ev.timestamp}>
                    {formatRelative(ev.timestamp)}
                  </time>
                </li>
              ))}
            </ul>
          )}
        </section>

        {tiers.length > 0 && (
          <section aria-labelledby="summary-tiers" className={styles.tiers}>
            <h2 id="summary-tiers" className={styles.blockTitle}>
              Clientes por nivel
            </h2>
            <ul className={styles.tierList}>
              {tiers.map(([name, count]) => {
                const pct =
                  kpis.totalCustomers > 0 ? Math.round((count / kpis.totalCustomers) * 100) : 0;
                return (
                  <li key={name} className={styles.tierRow}>
                    <div className={styles.tierHead}>
                      <span className={styles.tierName}>{name}</span>
                      <span className={styles.tierCount}>
                        {formatNumber(count)} · {pct}%
                      </span>
                    </div>
                    <div className={styles.tierTrack} aria-hidden="true">
                      <div className={styles.tierBar} style={{ width: `${Math.max(2, pct)}%` }} />
                    </div>
                  </li>
                );
              })}
            </ul>
            <Link href="/dashboard/loyalty/tiers" className={styles.textLink}>
              Ajustar niveles
            </Link>
          </section>
        )}
      </div>
    </div>
  );
}
