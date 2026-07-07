'use client';

export const runtime = 'edge';

import { useParams, useRouter } from 'next/navigation';
import { useState, useEffect } from 'react';

import { api, type CustomerDetail } from '@/lib/api';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function eventLabel(type: string): string {
  const map: Record<string, string> = {
    CUSTOMER_REGISTERED: 'Registro',
    POINTS_EARNED: 'Puntos ganados',
    POINTS_REDEEMED: 'Puntos canjeados',
    TIER_CHANGED: 'Cambio de nivel',
    VISIT_RECORDED: 'Visita registrada',
  };
  return map[type] || type;
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('es-MX', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

// ---------------------------------------------------------------------------
// Tier badge color
// ---------------------------------------------------------------------------

function tierColor(tierName: string): string {
  const colors: Record<string, string> = {
    Bronce: '#cd7f32',
    Plata: '#a0a0a0',
    Oro: '#ffd700',
  };
  return colors[tierName] || '#6b7280';
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function CustomerDetailPage() {
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;

  const [customer, setCustomer] = useState<CustomerDetail | null>(null);
  const [tierName, setTierName] = useState('—');
  const [tierMultiplier, setTierMultiplier] = useState(1);
  const [earnRate, setEarnRate] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [amount, setAmount] = useState(0);
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ type: string; message: string } | null>(null);

  function showToast(type: string, message: string) {
    setToast({ type, message });
    setTimeout(() => setToast(null), 3500);
  }

  function handleOpenModal() {
    setAmount(0);
    setNote('');
    setModalError(null);
    setShowModal(true);
  }

  function handleCloseModal() {
    setShowModal(false);
    setAmount(0);
    setNote('');
    setModalError(null);
  }

  async function handleSubmit() {
    if (amount < 1 || !customer) return;
    setSubmitting(true);
    setModalError(null);
    try {
      await api.assignPoints(customer.id, amount, note || undefined);
      showToast('success', 'Venta registrada exitosamente');
      handleCloseModal();
      // Refetch customer + tiers
      setLoading(true);
      const [cust, tiers] = await Promise.all([
        api.getCustomer(id),
        api.getTiers().catch(() => []),
      ]);
      setCustomer(cust);
      if (cust.currentTierId) {
        const match = tiers.find((t) => t.id === cust.currentTierId);
        setTierName(match?.name || cust.currentTier || '—');
        setTierMultiplier(match?.multiplier || 1);
      } else {
        setTierName(cust.currentTier || 'Bronce');
        setTierMultiplier(1);
      }
    } catch (err) {
      setModalError(err instanceof Error ? err.message : 'Error al registrar venta');
    } finally {
      setSubmitting(false);
    }
  }

  useEffect(() => {
    if (!id) return;

    setLoading(true);
    setError(null);

    // Fetch customer + tiers in parallel
    Promise.all([
      api.getCustomer(id),
      api.getTiers().catch(() => []),
      api.getLoyaltyConfig().catch(() => ({ earnRate: 1 })),
    ])
      .then(([cust, tiers, config]) => {
        setCustomer(cust);
        setEarnRate(config.earnRate);

        // Map tier ID to name + multiplier
        if (cust.currentTierId) {
          const match = tiers.find((t) => t.id === cust.currentTierId);
          setTierName(match?.name || cust.currentTier || '—');
          setTierMultiplier(match?.multiplier || 1);
        } else {
          setTierName(cust.currentTier || 'Bronce');
          setTierMultiplier(1);
        }
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Error al cargar cliente');
      })
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) {
    return (
      <div className="text-center text-muted" style={{ padding: '4rem' }}>
        Cargando cliente…
      </div>
    );
  }

  if (error || !customer) {
    return (
      <div className="text-center" style={{ padding: '4rem' }}>
        <p style={{ color: '#ef4444', marginBottom: '1rem' }}>{error || 'Cliente no encontrado'}</p>
        <button className="btn btn-secondary" onClick={() => router.push('/dashboard/customers')}>
          Volver a clientes
        </button>
      </div>
    );
  }

  const tierBaseColor = tierColor(tierName);
  const recentEvents = customer.customer_events.slice(-10).reverse();

  return (
    <>
      {/* Back */}
      <button
        className="btn-back"
        onClick={() => router.push('/dashboard/customers')}
      >
        ← Volver a clientes
      </button>

      {/* ---------- Hero / Card ---------- */}
      <div
        className="card customer-hero-card"
        style={{
          background: `linear-gradient(135deg, ${tierBaseColor}22 0%, ${tierBaseColor}44 100%)`,
          borderLeft: `4px solid ${tierBaseColor}`,
        }}
      >
        <div className="customer-hero-info">
          <h1 className="customer-hero-name">{customer.fullName}</h1>
          {customer.email && <p className="customer-hero-email">{customer.email}</p>}
          <p className="customer-hero-phone">{customer.phone}</p>
          {customer.birthDate && (
            <p className="customer-hero-birth">
              🎂 {new Date(customer.birthDate).toLocaleDateString('es-MX')}
            </p>
          )}
          <p className="customer-hero-since">
            Cliente desde {customer.createdAt}
          </p>
        </div>

        <div className="customer-hero-stats">
          <div className="hero-stat">
            <span className="hero-stat-label">Nivel</span>
            <span
              className="hero-stat-value hero-tier-badge"
              style={{
                background: tierBaseColor,
                color: tierName === 'Oro' ? '#333' : '#fff',
              }}
            >
              {tierName}
            </span>
          </div>
          <div className="hero-stat">
            <span className="hero-stat-label">Puntos</span>
            <span className="hero-stat-value hero-points">
              {customer.points.toLocaleString()}
            </span>
          </div>
          <div className="hero-stat">
            <span className="hero-stat-label">Ganados (total)</span>
            <span className="hero-stat-value">
              {customer.totalPointsEarned.toLocaleString()}
            </span>
          </div>
        </div>

        <button className="btn btn-primary" onClick={handleOpenModal} style={{ marginTop: '1rem', alignSelf: 'flex-start' }}>
          Registrar Venta
        </button>
      </div>

      {/* ---------- Recent Activity ---------- */}
      <div className="card" style={{ marginTop: '1.5rem' }}>
        <h2 className="card-title">Actividad reciente</h2>

        {recentEvents.length === 0 ? (
          <p className="text-muted" style={{ padding: '1rem 0' }}>
            Sin actividad registrada
          </p>
        ) : (
          <div className="event-timeline">
            {recentEvents.map((ev, i) => (
              <div key={ev.id || i} className="event-row">
                <div className="event-dot" />
                <div className="event-body">
                  <span className="event-type">{eventLabel(ev.eventType)}</span>
                  {ev.points != null && ev.points !== 0 && (
                    <span
                      className="event-points"
                      style={{ color: ev.points > 0 ? '#16a34a' : '#dc2626' }}
                    >
                      {ev.points > 0 ? '+' : ''}{ev.points} pts
                    </span>
                  )}
                  <span className="event-date">{formatDate(ev.createdAt)}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ---------- Registrar Venta Modal ---------- */}
      {showModal && (
        <div className="modal-overlay" onClick={handleCloseModal}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Registrar Venta</h3>
              <button className="modal-close" onClick={handleCloseModal}>&times;</button>
            </div>

            <div className="modal-body">
              <div className="form-group">
                <label htmlFor="sale-amount">Monto de venta ($)</label>
                <input
                  id="sale-amount"
                  type="number"
                  min="1"
                  className="form-control"
                  placeholder="Ej: 1500"
                  value={amount || ''}
                  onChange={(e) => setAmount(Number(e.target.value))}
                />
              </div>

              {amount > 0 && (
                <div className="points-preview" style={{ background: '#f9fafb', padding: '0.75rem', borderRadius: '6px', marginBottom: '1rem' }}>
                  <p className="text-sm text-muted" style={{ marginBottom: '0.5rem' }}>Desglose de puntos</p>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.875rem' }}>
                    <span>Base: {amount} pts</span>
                    <span>&times; Multiplicador ({tierMultiplier}x)</span>
                    <span><strong>= {Math.floor(amount * earnRate * tierMultiplier)} pts</strong></span>
                  </div>
                </div>
              )}

              <div className="form-group">
                <label htmlFor="sale-note">Nota (opcional)</label>
                <textarea
                  id="sale-note"
                  className="form-control"
                  rows={2}
                  placeholder="Nota interna sobre esta venta"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
              </div>

              {modalError && (
                <p style={{ color: '#ef4444', fontSize: '0.875rem', marginTop: '0.5rem' }}>{modalError}</p>
              )}
            </div>

            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={handleCloseModal} disabled={submitting}>
                Cancelar
              </button>
              <button
                className="btn btn-primary"
                onClick={handleSubmit}
                disabled={submitting || amount < 1}
              >
                {submitting ? 'Registrando…' : 'Registrar Venta'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div className="toast-container">
          <div className={`toast toast-${toast.type}`}>{toast.message}</div>
        </div>
      )}
    </>
  );
}
