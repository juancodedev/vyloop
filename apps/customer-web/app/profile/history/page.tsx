'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, useCallback } from 'react';

import { api, type Transaction } from '../../lib/api';
import { useAuth } from '../../lib/auth';

const CID_KEY = 'vyloop_customer_id';

type FilterType = 'all' | 'earned' | 'redeemed';

type Movement = {
  id: string;
  type: 'earned' | 'redeemed';
  description: string;
  points: number;
  balance: number;
  date: string;
  referenceId?: string;
};

/** Map API transaction type to Movement type */
function mapType(t: string): 'earned' | 'redeemed' {
  if (t === 'earn') return 'earned';
  if (t === 'redeem') return 'redeemed';
  return 'earned';
}

/** Format ISO date to es-CL short date */
function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('es-CL', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  } catch {
    return iso;
  }
}

/** Build a descriptive label from a transaction */
function describeTx(tx: Transaction): string {
  if (tx.type === 'earn') return tx.note || 'Puntos acumulados';
  if (tx.type === 'redeem') return tx.note || 'Canje de recompensa';
  return 'Movimiento';
}

export default function HistoryPage() {
  const router = useRouter();
  const { customer, isLoading } = useAuth();
  const [filter, setFilter] = useState<FilterType>('all');
  const [refreshing, setRefreshing] = useState(false);
  const [movements, setMovements] = useState<Movement[]>([]);
  const [fetching, setFetching] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const fetchTransactions = useCallback(async () => {
    const customerId = localStorage.getItem(CID_KEY);
    if (!customerId) {
      setFetchError('No se encontró el perfil del cliente. Volvé a la página de perfil.');
      setFetching(false);
      return;
    }

    try {
      const result = await api.getTransactions({ customer_id: customerId, limit: 50 });
      setMovements(
        result.data.map((tx) => ({
          id: tx.id,
          type: mapType(tx.type),
          description: describeTx(tx),
          points: tx.points,
          balance: tx.balance_after,
          date: formatDate(tx.created_at),
          ...(tx.reference_id ? { referenceId: tx.reference_id } : {}),
        })),
      );
      setFetchError(null);
    } catch (err: unknown) {
      setFetchError((err as Error).message || 'Error al cargar movimientos');
    } finally {
      setFetching(false);
    }
  }, []);

  useEffect(() => {
    if (!isLoading && !customer) {
      router.replace('/login');
    }
  }, [isLoading, customer, router]);

  useEffect(() => {
    if (!customer) return;
    fetchTransactions();
  }, [customer, fetchTransactions]);

  if (isLoading) {
    return <div className="loading">Cargando...</div>;
  }

  if (!customer) {
    return null;
  }

  const filtered: Movement[] =
    filter === 'all'
      ? movements
      : movements.filter((m) => m.type === filter);

  function handleRefresh() {
    setRefreshing(true);
    fetchTransactions().finally(() => setRefreshing(false));
  }

  return (
    <div className="page fade-in">
      {/* Back link */}
      <Link href="/profile" className="back-link">
        ← Volver
      </Link>

      <h1 className="title title--sm" style={{ marginBottom: 16 }}>
        Historial
      </h1>

      {/* Error banner */}
      {fetchError && (
        <div className="error-box" style={{ marginBottom: 16 }}>
          {fetchError}
        </div>
      )}

      {/* Filters */}
      <div className="filter-tabs">
        <button
          type="button"
          className={`filter-tab${filter === 'all' ? ' filter-tab--active' : ''}`}
          onClick={() => setFilter('all')}
        >
          Todos
        </button>
        <button
          type="button"
          className={`filter-tab${filter === 'earned' ? ' filter-tab--active' : ''}`}
          onClick={() => setFilter('earned')}
        >
          Ganados
        </button>
        <button
          type="button"
          className={`filter-tab${filter === 'redeemed' ? ' filter-tab--active' : ''}`}
          onClick={() => setFilter('redeemed')}
        >
          Canjeados
        </button>
      </div>

      {/* Movements */}
      <div className="card card--compact card--noshadow" style={{ padding: 0 }}>
        {fetching ? (
          <div className="empty-state">Cargando movimientos...</div>
        ) : filtered.length === 0 ? (
          <div className="empty-state">
            {filter === 'all'
              ? 'No hay movimientos'
              : filter === 'earned'
                ? 'No hay movimientos de puntos ganados'
                : 'No hay movimientos de canjes'}
          </div>
        ) : (
          filtered.map((mov) => (
            <div className="movement" key={mov.id}>
              <div
                className={`movement__icon ${
                  mov.type === 'earned'
                    ? 'movement__icon--earned'
                    : 'movement__icon--redeemed'
                }`}
              >
                {mov.type === 'earned' ? '↑' : '↓'}
              </div>
              <div className="movement__body">
                <div className="movement__description">
                  {mov.description}
                </div>
                <div className="movement__date">{mov.date}</div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div
                  className={`movement__points ${
                    mov.type === 'earned'
                      ? 'movement__points--earned'
                      : 'movement__points--redeemed'
                  }`}
                >
                  {mov.type === 'earned' ? '+' : '-'}
                  {mov.points.toLocaleString('es-CL')}
                </div>
                <div className="movement__balance">
                  Saldo: {mov.balance.toLocaleString('es-CL')}
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Refresh button */}
      <button
        type="button"
        className="refresh-btn"
        disabled={refreshing || fetching}
        onClick={handleRefresh}
      >
        {refreshing ? 'Actualizando...' : 'Actualizar'}
      </button>
    </div>
  );
}
