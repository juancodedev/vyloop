'use client';

import { useRouter } from 'next/navigation';
import { useState, useEffect, useCallback } from 'react';

import { api } from '@/lib/api';
import type { Customer } from '@/lib/api';

const PER_PAGE = 10;

export default function LoyaltyCustomersPage() {
  const router = useRouter();
  const [data, setData] = useState<{
    items: Customer[];
    total: number;
    page: number;
    totalPages: number;
  }>({ items: [], total: 0, page: 1, totalPages: 0 });
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (page: number) => {
    setLoading(true);
    const result = await api.getCustomerPoints(search || undefined, page, PER_PAGE);
    setData(result);
    setLoading(false);
  }, [search]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load(1);
  }, [load]);

  function handleSearch(value: string) {
    setSearch(value);
  }

  function goToPage(page: number) {
    if (page < 1 || page > data.totalPages) return;
    load(page);
  }

  function handleRowClick(customer: Customer) {
    router.push(`/dashboard/customers/${customer.id}`);
  }

  return (
    <>
      {/* Toolbar */}
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-semibold">Clientes</h1>
        <div className="flex items-center gap-2">
          <input
            type="search"
            placeholder="Buscar por nombre o email…"
            value={search}
            onChange={(e) => handleSearch(e.target.value)}
            className="w-64 px-3 py-2 rounded border bg-white"
            aria-label="Buscar clientes"
          />
        </div>
      </div>

      {/* Table */}
      {loading ? (
        <div className="text-center py-8 text-muted">Cargando…</div>
      ) : data.items.length === 0 ? (
        <div className="text-center py-8 text-muted">
          No hay clientes. Cuando se registren, aparecerán aquí.
        </div>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr className="text-left text-sm text-muted border-b">
                  <th className="pb-2 pr-4">Nombre</th>
                  <th className="pb-2 pr-4">Email</th>
                  <th className="pb-2 pr-4">Puntos</th>
                  <th className="pb-2 pr-4">Nivel</th>
                  <th className="pb-2 pr-4">Última visita</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((customer) => (
                  <tr
                    key={customer.id}
                    className="border-b hover:bg-[var(--surface-hover)] cursor-pointer"
                    onClick={() => handleRowClick(customer)}
                  >
                    <td className="py-3 pr-4 font-medium">{customer.fullName}</td>
                    <td className="py-3 pr-4 text-muted">{customer.email}</td>
                    <td className="py-3 pr-4">{customer.pointsBalance.toLocaleString('es-CL')}</td>
                    <td className="py-3 pr-4">
                      <span
                        className={`inline-block px-2 py-0.5 text-xs rounded-full ${
                          customer.tier === 'Oro'
                            ? 'bg-yellow-100 text-yellow-800'
                            : customer.tier === 'Plata'
                              ? 'bg-gray-100 text-gray-800'
                              : 'bg-amber-100 text-amber-800'
                        }`}
                      >
                        {customer.tier}
                      </span>
                    </td>
                    <td className="py-3 pr-4 text-muted">
                      {customer.lastVisitAt
                        ? new Date(customer.lastVisitAt).toLocaleDateString('es-CL', {
                            day: '2-digit',
                            month: '2-digit',
                            year: 'numeric',
                          })
                        : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {data.totalPages > 1 && (
            <div className="flex items-center justify-center gap-2 mt-4">
              <button
                onClick={() => goToPage(data.page - 1)}
                disabled={data.page === 1}
                className="px-3 py-1 rounded border disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Anterior
              </button>
              <span className="px-3 text-sm text-muted">
                Página {data.page} de {data.totalPages}
              </span>
              <button
                onClick={() => goToPage(data.page + 1)}
                disabled={data.page === data.totalPages}
                className="px-3 py-1 rounded border disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Siguiente
              </button>
            </div>
          )}
        </>
      )}
    </>
  );
}