'use client';

import { useState, useEffect, useCallback } from 'react';

import { api } from '@/lib/api';
import type { Customer } from '@/lib/api';

const PER_PAGE = 10;

export default function LoyaltyCustomersPage() {
  const [data, setData] = useState<{
    items: Customer[];
    total: number;
    page: number;
    totalPages: number;
  }>({ items: [], total: 0, page: 1, totalPages: 0 });
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<{ type: string; message: string } | null>(null);

  const load = useCallback(async (page: number) => {
    setLoading(true);
    const result = await api.getCustomerPoints(search || undefined, page, PER_PAGE);
    setData(result);
    setLoading(false);
  }, [search]);

  useEffect(() => {
    load(1);
  }, [load]);

  function showToast(message: string) {
    setToast({ type: 'info', message });
    setTimeout(() => setToast(null), 3000);
  }

  function handleSearch(value: string) {
    setSearch(value);
  }

  function goToPage(page: number) {
    if (page < 1 || page > data.totalPages) return;
    load(page);
  }

  function handleRowClick(customer: Customer) {
    showToast(`Detalle de ${customer.fullName} — próximamente`);
  }

  return (
    <>
      {/* Toolbar */}
      <div className="flex items-center justify-between mb-4">
        <div className="search-input-wrapper">
          <svg
            className="search-icon"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            type="text"
            className="form-control"
            placeholder="Buscar cliente por nombre…"
            value={search}
            onInput={(e) => handleSearch(e.currentTarget.value)}
          />
        </div>
        <span className="text-sm text-muted">
          {data.total} cliente{data.total !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Table */}
      <div className="card">
        <div className="table-container">
          <table className="data-table">
            <thead>
              <tr>
                <th>Nombre</th>
                <th>Puntos Actuales</th>
                <th>Nivel</th>
                <th>Total Acumulado</th>
                <th>Miembro desde</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={5} className="text-center text-muted" style={{ padding: '2rem' }}>
                    Cargando…
                  </td>
                </tr>
              ) : data.items.length === 0 ? (
                <tr>
                  <td colSpan={5} className="text-center text-muted" style={{ padding: '2rem' }}>
                    No se encontraron clientes
                  </td>
                </tr>
              ) : (
                data.items.map((c) => (
                  <tr
                    key={c.id}
                    onClick={() => handleRowClick(c)}
                    style={{ cursor: 'pointer' }}
                  >
                    <td>
                      <div style={{ fontWeight: 500 }}>{c.fullName}</div>
                      {c.email && (
                        <div className="text-xs text-muted">{c.email}</div>
                      )}
                    </td>
                    <td style={{ fontWeight: 600 }}>
                      {c.points.toLocaleString()}
                    </td>
                    <td>
                      <span className={`badge badge-${c.currentTier.toLowerCase()}`}>
                        {c.currentTier}
                      </span>
                    </td>
                    <td>{c.totalPointsEarned.toLocaleString()}</td>
                    <td className="text-sm text-muted">{c.createdAt}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {data.totalPages > 1 && (
          <div className="pagination" style={{ padding: '0.75rem 1.5rem', borderTop: '1px solid var(--border)' }}>
            <div className="pagination-info">
              Página {data.page} de {data.totalPages} ({data.total} clientes)
            </div>
            <div className="pagination-controls">
              <button
                onClick={() => goToPage(data.page - 1)}
                disabled={data.page <= 1}
              >
                Anterior
              </button>
              {Array.from({ length: data.totalPages }, (_, i) => i + 1).map((p) => (
                <button
                  key={p}
                  className={p === data.page ? 'active' : ''}
                  onClick={() => goToPage(p)}
                >
                  {p}
                </button>
              ))}
              <button
                onClick={() => goToPage(data.page + 1)}
                disabled={data.page >= data.totalPages}
              >
                Siguiente
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Toast */}
      {toast && (
        <div className="toast-container">
          <div className={`toast toast-${toast.type}`}>{toast.message}</div>
        </div>
      )}
    </>
  );
}
