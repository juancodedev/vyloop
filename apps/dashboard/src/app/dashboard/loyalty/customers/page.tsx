'use client';

import { ChevronLeft, ChevronRight, Search } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

import styles from './page.module.css';

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
      <div className={styles.toolbar}>
        <div className={styles.searchWrap}>
          <Search className={styles.searchIcon} size={16} />
          <input
            type="text"
            className={styles.searchInput}
            placeholder="Buscar cliente por nombre…"
            value={search}
            onInput={(e) => handleSearch(e.currentTarget.value)}
          />
        </div>
        <span className={styles.count}>
          {data.total} cliente{data.total !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Table */}
      <div className={styles.card}>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
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
                  <td colSpan={5} className={styles.loadingRow}>
                    Cargando…
                  </td>
                </tr>
              ) : data.items.length === 0 ? (
                <tr>
                  <td colSpan={5} className={styles.loadingRow}>
                    No se encontraron clientes
                  </td>
                </tr>
              ) : (
                data.items.map((c) => (
                  <tr key={c.id} onClick={() => handleRowClick(c)}>
                    <td>
                      <div className={styles.cellName}>{c.fullName}</div>
                      {c.email && <div className={styles.cellEmail}>{c.email}</div>}
                    </td>
                    <td className={styles.cellPoints}>{c.points.toLocaleString()}</td>
                    <td>
                      <span className={styles.badgeDefault}>{c.currentTier}</span>
                    </td>
                    <td>{c.totalPointsEarned.toLocaleString()}</td>
                    <td className={styles.cellDate}>{c.createdAt}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {data.totalPages > 1 && (
          <div className={styles.pagination}>
            <span className={styles.paginationInfo}>
              Página {data.page} de {data.totalPages} ({data.total} clientes)
            </span>
            <div className={styles.paginationControls}>
              <button
                className={styles.pageBtn}
                onClick={() => goToPage(data.page - 1)}
                disabled={data.page <= 1}
                aria-label="Página anterior"
              >
                <ChevronLeft size={16} />
              </button>
              {Array.from({ length: data.totalPages }, (_, i) => i + 1).map((p) => (
                <button
                  key={p}
                  className={p === data.page ? styles.pageActive : styles.pageBtn}
                  onClick={() => goToPage(p)}
                >
                  {p}
                </button>
              ))}
              <button
                className={styles.pageBtn}
                onClick={() => goToPage(data.page + 1)}
                disabled={data.page >= data.totalPages}
                aria-label="Página siguiente"
              >
                <ChevronRight size={16} />
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
