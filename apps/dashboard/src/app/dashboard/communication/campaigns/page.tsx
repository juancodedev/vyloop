'use client';

import { useRouter } from 'next/navigation';
import { useState, useEffect, useCallback } from 'react';

import { api, type PushCampaignSummary } from '@/lib/api';

// ---------------------------------------------------------------------------
// Toast Container Component
// ---------------------------------------------------------------------------

function ToastContainer() {
  const [toasts, setToasts] = useState<{ id: number; type: 'success' | 'error' | 'info'; message: string }[]>([]);

  useEffect(() => {
    const handler = (e: Event) => {
      const ce = e as CustomEvent<{ type: 'success' | 'error' | 'info'; message: string }>;
      const { type, message } = ce.detail;
      const id = Date.now();
      setToasts(prev => [...prev, { id, type, message }]);
      setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 3500);
    };
    window.addEventListener('dashboard-toast', handler);
    return () => window.removeEventListener('dashboard-toast', handler);
  }, []);

  return (
    <div className="toast-container" style={{ position: 'fixed', bottom: '1.5rem', right: '1.5rem', zIndex: 1000, display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      {toasts.map(t => {
        return (
        <div key={t.id} className={`toast toast-${t.type}`} style={{ minWidth: '280px', maxWidth: '400px' }}>
          {t.message}
        </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Campaigns Page
// ---------------------------------------------------------------------------

export default function CampaignsPage() {
  const router = useRouter();
  const [campaigns, setCampaigns] = useState<PushCampaignSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [perPage] = useState(20);
  const [statusFilter, setStatusFilter] = useState<'all' | 'sent' | 'failed'>('all');
  const [loading, setLoading] = useState(true);

  const loadCampaigns = useCallback(async () => {
    setLoading(true);
    try {
      const { campaigns, total } = await api.getPushCampaigns({
        page,
        per_page: perPage,
        status: statusFilter,
      });
      setCampaigns(campaigns);
      setTotal(total);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Error al cargar campañas';
      const event = new CustomEvent('dashboard-toast', { detail: { type: 'error', message: msg } });
      window.dispatchEvent(event);
    } finally {
      setLoading(false);
    }
  }, [page, perPage, statusFilter]);

  useEffect(() => {
    loadCampaigns();
  }, [loadCampaigns]);

  return (
    <>
      <ToastContainer />
      <div className="page fade-in">
        <div className="dash-header">
          <div>
            <h1 className="dash-title">Campañas push</h1>
            <p className="dash-subtitle">Componé y enviá mensajes a clientes cercanos</p>
          </div>
          <div className="dash-actions">
            <button className="btn btn-primary" onClick={() => router.push('/dashboard/communication/campaigns/new')}>
              <svg className="w-4 h-4 mr-2" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              Nueva campaña
            </button>
          </div>
        </div>

        {/* Toolbar */}
        <div className="flex items-center justify-between mb-4 flex-wrap gap-4">
          <div className="search-input-wrapper" style={{ flex: 1, minWidth: '280px' }}>
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input type="text" className="form-control" placeholder="Buscar por título…" value="" onChange={() => {}} disabled={loading} />
          </div>
          <div className="flex items-center gap-4">
            <label className="flex items-center gap-2 text-sm text-muted">
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
              </svg>
              <select className="form-control" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as 'all' | 'sent' | 'failed')} disabled={loading}>
                <option value="all">Todos</option>
                <option value="sent">Enviadas</option>
                <option value="failed">Fallidas</option>
              </select>
            </label>
          </div>
        </div>

        <div className="card">
          <div className="table-container">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Fecha</th>
                  <th>Título</th>
                  <th>Tipo objetivo</th>
                  <th>Audiencia</th>
                  <th>Entregados</th>
                  <th>Fallidos</th>
                  <th>Omitidos</th>
                  <th style={{ width: '80px' }}></th>
                </tr>
              </thead>
              <tbody>
                {loading && (
                  <tr>
                    <td colSpan={8} className="text-center text-muted" style={{ padding: '2rem' }}>
                      Cargando…
                    </td>
                  </tr>
                )}
                {!loading && campaigns.length === 0 && (
                  <tr>
                    <td colSpan={8} className="text-center text-muted" style={{ padding: '2rem' }}>
                      <p>No hay campañas enviadas</p>
                      <button className="btn btn-primary mt-2" onClick={() => router.push('/dashboard/communication/campaigns/new')}>
                        Crear primera campaña
                      </button>
                    </td>
                  </tr>
                )}
                {!loading && campaigns.length > 0 && campaigns.map((c) => (
                  <tr key={c.reference_id} className="clickable-row" onClick={() => router.push(`/dashboard/communication/campaigns/${c.reference_id}`)}>
                    <td className="text-sm text-muted">{new Date(c.created_at).toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</td>
                    <td style={{ fontWeight: 500 }}>{c.title}</td>
                    <td>{c.target_type === 'branch' ? <span className="badge badge-primary">Sede única</span> : <span className="badge badge-secondary">Radio</span>}</td>
                    <td>{c.audience_size.toLocaleString()}</td>
                    <td style={{ color: '#16a34a' }}>{c.delivered.toLocaleString()}</td>
                    <td style={{ color: '#dc2626' }}>{c.failed.toLocaleString()}</td>
                    <td className="text-muted">{c.skipped.toLocaleString()}</td>
                    <td>
                      <svg className="w-4 h-4 text-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <line x1="5" y1="12" x2="19" y2="12" />
                        <polyline points="12 5 19 12 12 19" />
                      </svg>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {total > perPage && (
            <div className="flex items-center justify-between mt-4 text-sm text-muted">
              <span>Página {page} de {Math.ceil(total / perPage)}</span>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() => setPage(p => Math.max(1, p - 1))}
                  disabled={page === 1}
                >
                  <svg className="w-4 h-4 mr-1" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <polyline points="15 18 9 12 15 6" />
                  </svg> Anterior
                </button>
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() => setPage(p => Math.min(Math.ceil(total / perPage), p + 1))}
                  disabled={page >= Math.ceil(total / perPage)}
                >
                  Siguiente <svg className="w-4 h-4 ml-1" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <polyline points="9 18 15 12 9 6" />
                  </svg>
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}