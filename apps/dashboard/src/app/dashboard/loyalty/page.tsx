'use client';

import Link from 'next/link';
import { useState, useEffect } from 'react';

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

export default function LoyaltyPage() {
  const [kpis, setKpis] = useState<KpiResponse | null>(null);
  const [timeline, setTimeline] = useState<TimelineEvent[]>([]);
  const [programName, setProgramName] = useState('Programa de Lealtad');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([api.getKpis(), api.getTimeline(), api.getLoyaltyConfig()])
      .then(([kpiData, timelineData, config]) => {
        setKpis(kpiData);
        setTimeline(timelineData);
        if (config.programName) setProgramName(config.programName);
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="loading-screen">
        <div className="spinner" />
        <p className="text-muted">Cargando programa…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="page fade-in">
        <div className="empty-state">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--text-muted)' }}>
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          <p>{error}</p>
          <button className="btn btn-primary mt-4" onClick={() => window.location.reload()}>
            Reintentar
          </button>
        </div>
      </div>
    );
  }

  const kpiCards = kpis
    ? [
        {
          icon: (
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
              <path d="M16 3.13a4 4 0 0 1 0 7.75" />
            </svg>
          ),
          value: kpis.activeCustomers.toLocaleString(),
          label: 'Miembros Activos',
          sub: `${kpis.totalCustomers.toLocaleString()} registrados`,
          color: 'var(--primary)',
          bg: 'var(--primary-light)',
          link: '/dashboard/loyalty/customers',
        },
        {
          icon: (
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="1" x2="12" y2="23" />
              <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
            </svg>
          ),
          value: kpis.totalPointsIssued.toLocaleString(),
          label: 'Puntos Emitidos',
          color: '#ca8a04',
          bg: '#fefce8',
        },
        {
          icon: (
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
            </svg>
          ),
          value: `${kpis.redemptionRate}%`,
          label: 'Tasa de Canje',
          sub: `${kpis.totalPointsRedeemed.toLocaleString()} pts canjeados`,
          color: '#7c3aed',
          bg: '#f5f3ff',
        },
        {
          icon: (
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
            </svg>
          ),
          value: kpis.rewardsClaimed.toLocaleString(),
          label: 'Recompensas Canjeadas',
          color: '#ea580c',
          bg: '#fff7ed',
          link: '/dashboard/loyalty/rewards',
        },
      ]
    : [];

  const timelineIcons: Record<string, React.ReactNode> = {
    'customer.created': (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
        <circle cx="8.5" cy="7" r="4" />
        <line x1="20" y1="8" x2="20" y2="14" />
        <line x1="23" y1="11" x2="17" y2="11" />
      </svg>
    ),
    'points.earned': (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <line x1="12" y1="1" x2="12" y2="23" />
        <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
      </svg>
    ),
    'points.redeemed': (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <line x1="12" y1="1" x2="12" y2="23" />
        <path d="M6 19H14.5a3.5 3.5 0 0 0 0-7h-5a3.5 3.5 0 0 1 0-7H18" />
      </svg>
    ),
    'customer.event': (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" />
        <polyline points="12 6 12 12 16 14" />
      </svg>
    ),
    'customer.profile_viewed': (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
        <circle cx="12" cy="12" r="3" />
      </svg>
    ),
  };

  const timelineColors: Record<string, string> = {
    'customer.created': '#2563eb',
    'points.earned': '#16a34a',
    'points.redeemed': '#dc2626',
    'customer.event': '#6b7280',
    'customer.profile_viewed': '#6b7280',
  };

  const timelineLabels: Record<string, string> = {
    'customer.created': 'Nuevo miembro',
    'points.earned': 'Puntos ganados',
    'points.redeemed': 'Puntos canjeados',
    'customer.event': 'Evento',
    'customer.profile_viewed': 'Perfil visto',
  };

  return (
    <div className="page fade-in">
      {/* ─── Header ─── */}
      <div className="dash-header">
        <div>
          <h1 className="dash-title">{programName}</h1>
          <p className="dash-subtitle">Resumen del programa de lealtad</p>
        </div>
        <div className="dash-actions">
          <Link href="/dashboard/loyalty/config" className="btn btn-secondary btn-sm">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
            Configuración
          </Link>
          <Link href="/dashboard/loyalty/pos" className="btn btn-primary btn-sm">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z" />
              <line x1="3" y1="6" x2="21" y2="6" />
              <path d="M16 10a4 4 0 0 1-8 0" />
            </svg>
            POS / Registrar Venta
          </Link>
        </div>
      </div>

      {/* ─── KPI Cards ─── */}
      <div className="dash-kpi-grid">
        {kpiCards.map((card, i) => (
          <Link
            key={i}
            href={card.link ?? '#'}
            className={`card dash-kpi-card ${card.link ? 'dash-kpi-linked' : ''}`}
          >
            <div className="card-body">
              <div className="dash-kpi-top">
                <div className="dash-kpi-icon" style={{ background: card.bg, color: card.color }}>
                  {card.icon}
                </div>
              </div>
              <div className="dash-kpi-value">{card.value}</div>
              <div className="dash-kpi-label">{card.label}</div>
              {card.sub && (
                <div className="dash-kpi-trend">
                  <span className="text-muted text-sm">{card.sub}</span>
                </div>
              )}
            </div>
          </Link>
        ))}
      </div>

      {/* ─── Content grid ─── */}
      <div className="dash-content-grid">
        {/* ─── Timeline ─── */}
        <div className="card dash-timeline-card">
          <div className="card-header">
            <h3>Actividad Reciente</h3>
            <span className="text-sm text-muted">{timeline.length} eventos</span>
          </div>
          <div className="card-body" style={{ padding: 0 }}>
            {timeline.length === 0 ? (
              <div className="empty-state" style={{ padding: '2rem' }}>
                <p className="text-muted">No hay actividad reciente</p>
              </div>
            ) : (
              <div className="timeline-list">
                {timeline.slice(0, 15).map((ev, i) => (
                  <div key={i} className="timeline-item">
                    <div
                      className="timeline-dot"
                      style={{ background: timelineColors[ev.type] || '#6b7280' }}
                    />
                    <div className="timeline-icon">{timelineIcons[ev.type]}</div>
                    <div className="timeline-body">
                      <div className="timeline-desc">
                        <span className="timeline-name">{getName(ev.customerName)}</span>{' '}
                        <span className="timeline-action">{ev.description}</span>
                      </div>
                      <div className="timeline-label">{timelineLabels[ev.type]}</div>
                    </div>
                    <div className="timeline-time">{formatRelative(ev.timestamp)}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* ─── Sidebar: tiers + quick links ─── */}
        <div className="dash-sidebar-grid">
          {/* Tier Distribution */}
          {kpis && Object.keys(kpis.tierDistribution).length > 0 && (
            <div className="card">
              <div className="card-header">
                <h3>Distribución por Nivel</h3>
                <Link href="/dashboard/loyalty/tiers" className="text-sm" style={{ color: 'var(--primary)' }}>
                  Gestionar
                </Link>
              </div>
              <div className="card-body">
                <div className="tier-distribution">
                  {Object.entries(kpis.tierDistribution).map(([name, count]) => {
                    const pct =
                      kpis.totalCustomers > 0
                        ? Math.round((count / kpis.totalCustomers) * 100)
                        : 0;
                    return (
                      <div key={name} className="dash-tier-dist-row">
                        <div className="tier-dist-header">
                          <span className="tier-dist-name">{name}</span>
                          <span className="tier-dist-count">{count} cl.</span>
                        </div>
                        <div className="tier-dist-bar-wrapper">
                          <div className="tier-dist-bar" style={{ width: `${Math.max(2, pct)}%` }} />
                        </div>
                        <span className="tier-dist-pct">{pct}%</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {/* Quick Links */}
          <div className="card">
            <div className="card-header">
              <h3>Secciones del Programa</h3>
            </div>
            <div className="card-body dash-links">
              <Link href="/dashboard/loyalty/config" className="dash-link-item">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="3" />
                  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                </svg>
                <span>Configuración</span>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="dash-link-arrow">
                  <polyline points="9 18 15 12 9 6" />
                </svg>
              </Link>
              <Link href="/dashboard/loyalty/tiers" className="dash-link-item">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M6 9H4.5a2.5 2.5 0 0 1 0-5C7 4 7 7 7 7" />
                  <path d="M18 9h1.5a2.5 2.5 0 0 0 0-5C17 4 17 7 17 7" />
                  <path d="M12 22v-8" />
                  <path d="M4 17h16" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
                <span>Niveles</span>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="dash-link-arrow">
                  <polyline points="9 18 15 12 9 6" />
                </svg>
              </Link>
              <Link href="/dashboard/loyalty/rewards" className="dash-link-item">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                </svg>
                <span>Recompensas</span>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="dash-link-arrow">
                  <polyline points="9 18 15 12 9 6" />
                </svg>
              </Link>
              <Link href="/dashboard/loyalty/customers" className="dash-link-item">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                  <circle cx="9" cy="7" r="4" />
                  <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                  <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                </svg>
                <span>Clientes</span>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="dash-link-arrow">
                  <polyline points="9 18 15 12 9 6" />
                </svg>
              </Link>
              <Link href="/dashboard/loyalty/pos" className="dash-link-item">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z" />
                  <line x1="3" y1="6" x2="21" y2="6" />
                  <path d="M16 10a4 4 0 0 1-8 0" />
                </svg>
                <span>POS / Registrar Venta</span>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="dash-link-arrow">
                  <polyline points="9 18 15 12 9 6" />
                </svg>
              </Link>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
