'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useAuth } from '../../lib/auth';
import {
  MOCK_MOVEMENTS,
  type Movement,
} from '../../lib/mock-data';

type FilterType = 'all' | 'earned' | 'redeemed';

function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const year = date.getFullYear();
  return `${day}/${month}/${year}`;
}

function formatTime(dateStr: string): string {
  const date = new Date(dateStr);
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

export default function HistoryPage() {
  const router = useRouter();
  const { customer, isLoading } = useAuth();
  const [filter, setFilter] = useState<FilterType>('all');
  const [refreshing, setRefreshing] = useState(false);

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
      ? MOCK_MOVEMENTS
      : MOCK_MOVEMENTS.filter((m) => m.type === filter);

  function handleRefresh() {
    setRefreshing(true);
    // Simulate network delay
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
                <div className="movement__date">
                  {formatDate(mov.date)} · {formatTime(mov.date)}
                </div>
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
