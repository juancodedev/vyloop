'use client';

import Link from 'next/link';
import { useState, useEffect } from 'react';

import { apiFetch } from '@/lib/api';
import { describeDeliveryFailure } from '@/lib/delivery-failure';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MessageLogEntry {
  id: string;
  customerId: string;
  /** Joined by the worker; null when the customer row is gone. */
  customerName: string | null;
  channel: string;
  status: string;
  /** A push delivery's `{ title, body, url, reference_id }`. */
  content: Record<string, unknown> | null;
  /** Holds `error` when the delivery failed. */
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

/** The statuses a push delivery can be in. */
const STATUS_CONFIG: Record<string, { label: string; className: string }> = {
  queued: { label: 'En cola', className: 'badge-muted' },
  sent: { label: 'Enviado', className: 'badge-success' },
  failed: { label: 'Fallido', className: 'badge-warning' },
};

const PER_PAGE = 15;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function MessagesPage() {
  const [messages, setMessages] = useState<MessageLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [statusFilter, setStatusFilter] = useState('');

  const totalPages = Math.ceil(total / PER_PAGE);

  const fetchMessages = () => {
    setLoading(true);
    setError(null);

    const params = new URLSearchParams();
    params.set('page', String(page));
    params.set('per_page', String(PER_PAGE));
    // Push only: WhatsApp is hidden for now, and so are its rows.
    params.set('channel', 'push');
    if (statusFilter) params.set('status', statusFilter);

    apiFetch(`/v1/communication/history?${params}`)
      .then((data) => {
        const resp = data as {
          data: MessageLogEntry[];
          meta: { total: number; page: number; per_page: number };
        };
        setMessages(resp.data ?? []);
        setTotal(resp.meta?.total ?? 0);
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchMessages();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, statusFilter]);

  const handleStatusFilter = (status: string) => {
    setStatusFilter(status);
    setPage(1);
  };

  // ─── Loading ───

  if (loading) {
    return (
      <div className="loading-screen">
        <div className="spinner" />
        <p className="text-muted">Cargando mensajes…</p>
      </div>
    );
  }

  // ─── Error ───

  if (error && messages.length === 0) {
    return (
      <div className="page fade-in">
        <div className="empty-state">
          <svg
            width="48"
            height="48"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ color: 'var(--text-muted)' }}
          >
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          <p>{error}</p>
          <button className="btn btn-primary mt-4" onClick={() => fetchMessages()}>
            Reintentar
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="page fade-in">
      {/* ─── Header ─── */}
      <div className="dash-header">
        <div>
          <h1 className="dash-title">Mensajes</h1>
          <p className="dash-subtitle">Las notificaciones que enviaste a tus clientes</p>
        </div>
      </div>

      {/* ─── Filters ─── */}
      <div className="card mb-4">
        <div
          className="card-body"
          style={{ padding: '0.75rem 1rem', display: 'flex', gap: '0.5rem', alignItems: 'center' }}
        >
          <span className="text-sm" style={{ fontWeight: 600, color: 'var(--text-secondary)' }}>
            Filtrar:
          </span>
          {[
            { value: '', label: 'Todos' },
            ...Object.entries(STATUS_CONFIG).map(([value, cfg]) => ({ value, label: cfg.label })),
          ].map((opt) => (
            <button
              key={opt.value}
              className={`btn btn-sm ${statusFilter === opt.value ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => handleStatusFilter(opt.value)}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* ─── Empty state ─── */}
      {messages.length === 0 && !error ? (
        <div className="card">
          <div className="empty-state">
            <svg
              width="48"
              height="48"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{ color: 'var(--text-muted)' }}
            >
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
            <p>Todavía no hay notificaciones enviadas.</p>
            <Link href="/dashboard/communication/campaigns" className="btn btn-primary mt-4">
              Ir a Campañas
            </Link>
          </div>
        </div>
      ) : (
        /* ─── Table ─── */
        <div className="card">
          <div className="table-container">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Cliente</th>
                  <th>Notificación</th>
                  <th>Estado</th>
                  <th>Fecha</th>
                </tr>
              </thead>
              <tbody>
                {messages.map((msg) => {
                  const statusCfg = STATUS_CONFIG[msg.status] ?? {
                    label: 'Sin estado',
                    className: 'badge-muted',
                  };
                  const title = msg.content?.title ? String(msg.content.title) : 'Notificación';
                  const body = msg.content?.body ? String(msg.content.body) : '';
                  return (
                    <tr key={msg.id}>
                      <td style={{ fontWeight: 500 }}>
                        {msg.customerName ?? (
                          <span className="text-muted">Cliente no disponible</span>
                        )}
                      </td>
                      <td style={{ maxWidth: 320 }}>
                        <div style={{ fontWeight: 500 }}>{title}</div>
                        {body && (
                          <div
                            className="text-sm text-muted"
                            style={{
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {body}
                          </div>
                        )}
                      </td>
                      <td style={{ maxWidth: 280 }}>
                        <span className={`badge ${statusCfg.className}`}>{statusCfg.label}</span>
                        {msg.status === 'failed' && (
                          <div
                            className="text-sm"
                            style={{ marginTop: 4, color: 'var(--text-secondary)' }}
                          >
                            {describeDeliveryFailure(msg.metadata)}
                          </div>
                        )}
                      </td>
                      <td className="text-sm text-muted">{formatRelative(msg.createdAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* ─── Pagination ─── */}
          {totalPages > 1 && (
            <div className="pagination" style={{ padding: '0.75rem 1rem' }}>
              <span className="pagination-info">{total} notificaciones en total</span>
              <div className="pagination-controls">
                <button disabled={page <= 1} onClick={() => setPage(page - 1)}>
                  Anterior
                </button>
                {Array.from({ length: Math.min(totalPages, 5) }, (_, i) => {
                  const startPage = Math.max(1, Math.min(page - 2, totalPages - 4));
                  const p = startPage + i;
                  if (p > totalPages) return null;
                  return (
                    <button
                      key={p}
                      className={page === p ? 'active' : ''}
                      onClick={() => setPage(p)}
                    >
                      {p}
                    </button>
                  );
                })}
                <button disabled={page >= totalPages} onClick={() => setPage(page + 1)}>
                  Siguiente
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
