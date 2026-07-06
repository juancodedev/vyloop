'use client';

import { useState, useEffect } from 'react';

import { api } from '@/lib/api';
import type { KpiResponse } from '@/lib/api';

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
      <div className="card">
        <div className="card-body text-center text-muted">Cargando analytics…</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="card">
        <div className="card-body text-center">
          <p className="text-muted">{error}</p>
          <button className="btn btn-primary btn-sm mt-4" onClick={loadKpis}>
            Reintentar
          </button>
        </div>
      </div>
    );
  }

  if (!kpis) return null;

  const cards = [
    {
      icon: (
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
          <path d="M16 3.13a4 4 0 0 1 0 7.75" />
        </svg>
      ),
      value: kpis.totalCustomers.toLocaleString(),
      label: 'Total Clientes',
      bg: '#eff6ff',
      color: '#2563eb',
    },
    {
      icon: (
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
          <path d="M16 3.13a4 4 0 0 1 0 7.75" />
          <circle cx="18" cy="8" r="3" fill="currentColor" />
        </svg>
      ),
      value: kpis.activeCustomers.toLocaleString(),
      label: 'Clientes Activos',
      bg: '#f0fdf4',
      color: '#16a34a',
    },
    {
      icon: (
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="12" y1="1" x2="12" y2="23" />
          <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
        </svg>
      ),
      value: kpis.totalPointsIssued.toLocaleString(),
      label: 'Puntos Emitidos',
      bg: '#fefce8',
      color: '#ca8a04',
    },
    {
      icon: (
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="12" y1="1" x2="12" y2="23" />
          <path d="M6 19H14.5a3.5 3.5 0 0 0 0-7h-5a3.5 3.5 0 0 1 0-7H18" />
        </svg>
      ),
      value: kpis.totalPointsRedeemed.toLocaleString(),
      label: 'Puntos Canjeados',
      bg: '#fef2f2',
      color: '#dc2626',
    },
    {
      icon: (
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
        </svg>
      ),
      value: `${kpis.redemptionRate}%`,
      label: 'Tasa de Canje',
      bg: '#f5f3ff',
      color: '#7c3aed',
    },
    {
      icon: (
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
        </svg>
      ),
      value: kpis.rewardsClaimed.toLocaleString(),
      label: 'Recompensas Canjeadas',
      bg: '#fff7ed',
      color: '#ea580c',
    },
  ];

  return (
    <>
      {/* KPI Cards Grid */}
      <div className="kpi-grid">
        {cards.map((card, i) => (
          <div key={i} className="card kpi-card" style={{ borderLeft: `4px solid ${card.color}` }}>
            <div className="card-body">
              <div className="kpi-card-header">
                <div className="kpi-icon" style={{ background: card.bg, color: card.color }}>
                  {card.icon}
                </div>
              </div>
              <div className="kpi-value">{card.value}</div>
              <div className="kpi-label">{card.label}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Tier Distribution */}
      <div className="card mt-4">
        <div className="card-header">
          <h3>Distribución por Nivel</h3>
        </div>
        <div className="card-body">
          {Object.keys(kpis.tierDistribution).length === 0 ? (
            <p className="text-muted text-sm">No hay datos de distribución por nivel.</p>
          ) : (
            <div className="tier-distribution">
              {Object.entries(kpis.tierDistribution).map(([name, count]) => (
                <div key={name} className="tier-dist-row">
                  <span className="tier-dist-name">{name}</span>
                  <div className="tier-dist-bar-wrapper">
                    <div
                      className="tier-dist-bar"
                      style={{
                        width: `${Math.max(
                          2,
                          (count / Math.max(...Object.values(kpis.tierDistribution))) * 100,
                        )}%`,
                      }}
                    />
                  </div>
                  <span className="tier-dist-count">{count} clientes</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
