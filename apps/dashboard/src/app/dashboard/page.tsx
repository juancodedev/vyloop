'use client';

import { Button } from '@vyloop/design-system';
import {
  AlertCircle,
  ArrowUpRight,
  ChevronRight,
  Clock,
  DollarSign,
  Gift,
  Sparkles,
  Star,
  TrendingUp,
  UserPlus,
  Users,
} from 'lucide-react';
import Link from 'next/link';
import { useState, useEffect } from 'react';

import styles from './page.module.css';

import { api } from '@/lib/api';
import type { KpiResponse, TimelineEvent } from '@/lib/api';


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

function getName(text: string): string {
  return text.split(' ').slice(0, 2).join(' ');
}

type KpiEntry = {
  icon: React.ReactNode;
  iconBg: string;
  iconColor: string;
  value: string;
  label: string;
  trend?: number;
  trendLabel?: string;
  link?: string;
};

const TIMELINE_ICON_MAP: Record<string, React.ReactNode> = {
  'customer.created': <UserPlus size={14} />,
  'points.earned': <DollarSign size={14} />,
  'points.redeemed': <Gift size={14} />,
  'customer.event': <Clock size={14} />,
};

const TIMELINE_COLORS: Record<string, string> = {
  'customer.created': 'var(--info)',
  'points.earned': 'var(--success)',
  'points.redeemed': 'var(--error)',
  'customer.event': 'var(--text-muted)',
};

const TIMELINE_LABELS: Record<string, string> = {
  'customer.created': 'Nuevo cliente',
  'points.earned': 'Puntos ganados',
  'points.redeemed': 'Puntos canjeados',
  'customer.event': 'Evento',
};

const TIER_BAR_COLORS: Record<string, string> = {
  Bronce: 'var(--brand-300)',
  Plata: 'var(--stone-400)',
  Oro: 'var(--brand-500)',
};

export default function DashboardHome() {
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
      <div className={styles.loading}>
        <div className={styles.spinner} />
        <p className="text-muted">Cargando dashboard…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className={styles.errorState}>
        <AlertCircle size={40} />
        <p>{error}</p>
        <Button variant="primary" size="sm" onClick={() => window.location.reload()}>
          Reintentar
        </Button>
      </div>
    );
  }

  const kpiCards: KpiEntry[] = kpis
    ? [
        {
          icon: <Users size={18} />,
          iconBg: 'var(--info-bg)',
          iconColor: 'var(--info)',
          value: kpis.totalCustomers.toLocaleString(),
          label: 'Total Clientes',
          trend: kpis.activeCustomers,
          trendLabel: 'activos',
          link: '/dashboard/customers',
        },
        {
          icon: <Sparkles size={18} />,
          iconBg: 'var(--warning-bg)',
          iconColor: 'var(--warning)',
          value: kpis.totalPointsIssued.toLocaleString(),
          label: 'Puntos Emitidos',
        },
        {
          icon: <TrendingUp size={18} />,
          iconBg: 'var(--info-bg)',
          iconColor: 'var(--info)',
          value: `${kpis.redemptionRate}%`,
          label: 'Tasa de Canje',
        },
        {
          icon: <Gift size={18} />,
          iconBg: 'var(--warning-bg)',
          iconColor: 'var(--warning)',
          value: kpis.rewardsClaimed.toLocaleString(),
          label: 'Recompensas',
        },
      ]
    : [];

  const today = new Date().toLocaleDateString('es-CL', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });

  return (
    <div>
      {/* ─── Header ─── */}
      <div className={styles.header}>
        <div className={styles.headerInner}>
          <h1 className={styles.title}>Panel de Control</h1>
          <span className={styles.subtitle}>{today}</span>
        </div>
        <Link href="/dashboard/analytics">
          <Button variant="secondary" size="sm" icon={<Star size={14} />}>
            Ver Analytics
          </Button>
        </Link>
      </div>

      {/* ─── KPI Grid ─── */}
      <div className={styles.kpiGrid}>
        {kpiCards.map((card, i) => {
          const inner = (
            <>
              <div className={styles.kpiTop}>
                <div
                  className={styles.kpiIconWrap}
                  style={{ background: card.iconBg, color: card.iconColor }}
                >
                  {card.icon}
                </div>
                {card.trend !== undefined && (
                  <span className={`${styles.kpiTrend} ${styles.kpiTrendUp}`}>
                    <ArrowUpRight size={12} />
                    <span className={styles.kpiTrendValue}>
                      {card.trend!.toLocaleString()}
                    </span>{' '}
                    {card.trendLabel}
                  </span>
                )}
              </div>
              <div className={styles.kpiValue}>{card.value}</div>
              <div className={styles.kpiLabel}>{card.label}</div>
            </>
          );

          return card.link ? (
            <Link key={i} href={card.link} className={styles.kpiCard}>
              {inner}
            </Link>
          ) : (
            <div key={i} className={styles.kpiCard}>
              {inner}
            </div>
          );
        })}
      </div>

      {/* ─── Content Grid ─── */}
      <div className={styles.contentGrid}>
        {/* ─── Timeline ─── */}
        <div className={styles.card}>
          <div className={styles.cardHeader}>
            <h3>Actividad Reciente</h3>
            <span className="text-sm text-muted">{timeline.length} eventos</span>
          </div>
          <div className={styles.cardBodyCompact}>
            {timeline.length === 0 ? (
              <div className={styles.emptyState}>
                <Clock size={32} />
                <p>No hay actividad reciente</p>
              </div>
            ) : (
              <div className={styles.timelineList}>
                {timeline.slice(0, 15).map((ev, i) => (
                  <div key={i} className={styles.timelineItem}>
                    <div
                      className={styles.timelineDot}
                      style={{ background: TIMELINE_COLORS[ev.type] || 'var(--text-muted)' }}
                    />
                    <div className={styles.timelineIcon}>
                      {TIMELINE_ICON_MAP[ev.type] || <Clock size={14} />}
                    </div>
                    <div className={styles.timelineBody}>
                      <div className={styles.timelineDesc}>
                        <span className={styles.timelineName}>
                          {getName(ev.customerName)}
                        </span>{' '}
                        <span className={styles.timelineAction}>{ev.description}</span>
                      </div>
                      <div className={styles.timelineLabel}>
                        {TIMELINE_LABELS[ev.type]}
                      </div>
                    </div>
                    <div className={styles.timelineTime}>{formatRelative(ev.timestamp)}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* ─── Right Sidebar ─── */}
        <div className={styles.sidebarGrid}>
          {/* Tier Distribution */}
          {kpis && Object.keys(kpis.tierDistribution).length > 0 && (
            <div className={styles.card}>
              <div className={styles.cardHeader}>
                <h3>Distribución por Nivel</h3>
              </div>
              <div className={styles.cardBody}>
                <div className={styles.tierDist}>
                  {Object.entries(kpis.tierDistribution).map(([name, count]) => {
                    const total = kpis.totalCustomers;
                    const pct = total > 0 ? Math.round((count / total) * 100) : 0;
                    return (
                      <div key={name} className={styles.tierDistRow}>
                        <div className={styles.tierDistHeader}>
                          <span className={styles.tierDistName}>{name}</span>
                          <span className={styles.tierDistCount}>
                            {count} cl.
                          </span>
                        </div>
                        <div className={styles.tierDistBarOuter}>
                          <div
                            className={styles.tierDistBarInner}
                            style={{
                              width: `${Math.max(2, pct)}%`,
                              background:
                                TIER_BAR_COLORS[name] || 'var(--brand-500)',
                            }}
                          />
                        </div>
                        <span className={styles.tierDistPct}>{pct}%</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {/* Quick Links */}
          <div className={styles.card}>
            <div className={styles.cardHeader}>
              <h3>Acceso Rápido</h3>
            </div>
            <div className={styles.cardBody}>
              <div className={styles.links}>
                <Link href="/dashboard/customers" className={styles.linkItem}>
                  <Users size={16} className={styles.linkIcon} />
                  <span>Gestionar Clientes</span>
                  <ChevronRight size={14} className={styles.linkArrow} />
                </Link>
                <Link href="/dashboard/analytics" className={styles.linkItem}>
                  <TrendingUp size={16} className={styles.linkIcon} />
                  <span>Analytics</span>
                  <ChevronRight size={14} className={styles.linkArrow} />
                </Link>
                <Link href="/dashboard/loyalty" className={styles.linkItem}>
                  <Star size={16} className={styles.linkIcon} />
                  <span>Programa de Lealtad</span>
                  <ChevronRight size={14} className={styles.linkArrow} />
                </Link>
                <Link href="/dashboard/rewards" className={styles.linkItem}>
                  <Gift size={16} className={styles.linkIcon} />
                  <span>Catálogo de Recompensas</span>
                  <ChevronRight size={14} className={styles.linkArrow} />
                </Link>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
