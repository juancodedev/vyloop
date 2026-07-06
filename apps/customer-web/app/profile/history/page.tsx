'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import { useAuth } from '../../lib/auth';

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

export default function HistoryPage() {
  const router = useRouter();
  const { customer, isLoading } = useAuth();
  const [filter, setFilter] = useState<FilterType>('all');
  const [refreshing, setRefreshing] = useState(false);
  const [movements] = useState<Movement[]>([]);

  useEffect(() => {
    if (!isLoading && !customer) {
      router.replace('/login');
    }
  }, [isLoading, customer, router]);

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
    // Phase 2: fetch movements from API
    setTimeout(() => setRefreshing(false), 800);
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
        {filtered.length === 0 ? (
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
        disabled={refreshing}
        onClick={handleRefresh}
      >
        {refreshing ? 'Actualizando...' : 'Actualizar'}
      </button>
    </div>
  );
}
