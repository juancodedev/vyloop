'use client';

import { Button } from '@vyloop/design-system';
import {
  Activity,
  AlertCircle,
  Banknote,
  BarChart3,
  Gift,
  RefreshCw,
  ShoppingBag,
  UserCheck,
  Users,
} from 'lucide-react';
import { useState, useEffect } from 'react';

import styles from './page.module.css';

import { api } from '@/lib/api';
import type { KpiResponse } from '@/lib/api';


// ---------------------------------------------------------------------------
// KPI card config
// ---------------------------------------------------------------------------

interface KpiCardConfig {
  icon: React.ReactNode;
  value: string;
  label: string;
  iconBg: string;
  iconColor: string;
  accentColor: string;
}

function buildCards(kpis: KpiResponse): KpiCardConfig[] {
  return [
    {
      icon: <Users size={20} />,
      value: kpis.totalCustomers.toLocaleString(),
      label: 'Total Clientes',
      iconBg: 'var(--info-bg)',
      iconColor: 'var(--info)',
      accentColor: 'var(--info)',
    },
    {
      icon: <UserCheck size={20} />,
      value: kpis.activeCustomers.toLocaleString(),
      label: 'Clientes Activos',
      iconBg: 'var(--success-bg)',
      iconColor: 'var(--success)',
      accentColor: 'var(--success)',
    },
    {
      icon: <Banknote size={20} />,
      value: kpis.totalPointsIssued.toLocaleString(),
      label: 'Puntos Emitidos',
      iconBg: 'var(--warning-bg)',
      iconColor: 'var(--warning)',
      accentColor: 'var(--warning)',
    },
    {
      icon: <ShoppingBag size={20} />,
      value: kpis.totalPointsRedeemed.toLocaleString(),
      label: 'Puntos Canjeados',
      iconBg: 'var(--error-bg)',
      iconColor: 'var(--error)',
      accentColor: 'var(--error)',
    },
    {
      icon: <Activity size={20} />,
      value: `${kpis.redemptionRate}%`,
      label: 'Tasa de Canje',
      iconBg: 'oklch(0.96 0.02 260)',
      iconColor: 'var(--info)',
      accentColor: 'var(--info)',
    },
    {
      icon: <Gift size={20} />,
      value: kpis.rewardsClaimed.toLocaleString(),
      label: 'Recompensas Canjeadas',
      iconBg: 'oklch(0.97 0.03 82.5)',
      iconColor: 'var(--warning)',
      accentColor: 'var(--warning)',
    },
  ];
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function AnalyticsPage() {
  const [kpis, setKpis] = useState<KpiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadKpis();
  }, []);

  async function loadKpis() {
    setLoading(true);
    setError(null);
    try {
      const data = await api.getKpis();
      setKpis(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al cargar analytics');
    } finally {
      setLoading(false);
    }
  }

  if (loading) {
    return (
      <div className={styles.loadingState}>
        <div className={styles.spinner} />
        <span>Cargando analytics…</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className={styles.errorState}>
        <AlertCircle size={32} style={{ color: 'var(--error)' }} />
        <p className={styles.errorMessage}>{error}</p>
        <Button variant="primary" icon={<RefreshCw size={14} />} onClick={loadKpis}>
          Reintentar
        </Button>
      </div>
    );
  }

  if (!kpis) return null;

  const cards = buildCards(kpis);

  return (
    <>
      {/* ─── Header ─── */}
      <div className={styles.header}>
        <h1 className={styles.title}>Analytics</h1>
        <Button variant="secondary" size="sm" icon={<RefreshCw size={14} />} onClick={loadKpis}>
          Actualizar
        </Button>
      </div>

      {/* ─── KPI Cards Grid ─── */}
      <div className={styles.kpiGrid}>
        {cards.map((card, i) => (
          <div
            key={i}
            className={styles.kpiCard}
            style={{ borderLeft: `3px solid ${card.accentColor}` }}
          >
            <div
              className={styles.kpiIconWrapper}
              style={{ background: card.iconBg, color: card.iconColor }}
            >
              {card.icon}
            </div>
            <div className={styles.kpiValue}>{card.value}</div>
            <div className={styles.kpiLabel}>{card.label}</div>
          </div>
        ))}
      </div>

      {/* ─── Tier Distribution ─── */}
      <div className={styles.tierCard}>
        <div className={styles.tierHeader}>
          <BarChart3 size={18} style={{ color: 'var(--text-secondary)' }} />
          <h3 className={styles.tierTitle}>Distribución por Nivel</h3>
        </div>
        <div className={styles.tierBody}>
          {Object.keys(kpis.tierDistribution).length === 0 ? (
            <p className={styles.tierEmpty}>No hay datos de distribución por nivel.</p>
          ) : (
            Object.entries(kpis.tierDistribution).map(([name, count]) => {
              const maxCount = Math.max(...Object.values(kpis.tierDistribution));
              const barWidth = Math.max(2, (count / maxCount) * 100);
              return (
                <div key={name} className={styles.tierRow}>
                  <span className={styles.tierName}>{name}</span>
                  <div className={styles.tierBarWrapper}>
                    <div className={styles.tierBar} style={{ width: `${barWidth}%` }} />
                  </div>
                  <span className={styles.tierCount}>{count} clientes</span>
                </div>
              );
            })
          )}
        </div>
      </div>
    </>
  );
}
