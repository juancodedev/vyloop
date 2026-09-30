'use client';

export const runtime = 'edge';

import { useParams, useRouter } from 'next/navigation';
import { useState, useEffect } from 'react';

import { api, type CustomerDetail } from '@/lib/api';

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
  if (days < 7) return `Hace ${days} días`;
  return `Hace ${Math.floor(days / 7)} sem`;
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
  const id = (typeof params.id === 'string' ? params.id : Array.isArray(params.id) ? params.id[0] : undefined) ?? '';

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
      // Refresh in place. This used to raise `loading` as well, which is what
      // left the page stuck on "Cargando cliente…" forever after a sale: the
      // `finally` below resets `submitting`, not `loading`, and nothing else ever
      // cleared it. Counting the pairs balances — the effect's error branch turns
      // `loading` off — so a mismatch in the counts would not have found it.
      //
      // A refresh after a save is not a page load, and the customer is already on
      // screen. The numbers update where they are; `submitting` is the honest
      // signal that work is in flight, and it is bound to the button.
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
      // Not `setModalError`: the modal was closed two lines above, so anything
      // written there is invisible. The sale already succeeded, so this is a
      // refresh that did not come back and the operator should be told that,
      // separately from the failure it would otherwise be read as.
      showToast(
        'error',
        err instanceof Error
          ? `Venta registrada, pero no se pudo refrescar: ${err.message}`
          : 'Venta registrada, pero no se pudo refrescar.',
      );
    } finally {
      setSubmitting(false);
    }
  }

  useEffect(() => {
    // No silent early return. `loading` starts true, so returning here without
    // settling it leaves the page on "Cargando cliente…" for good — no error, no
    // timeout, and nothing in the network panel to point at. `params.id` is
    // `string | string[] | undefined` in the App Router and the `as string`
    // above hides that from the compiler, so this guard is reachable, not
    // theoretical.
    const customerId = typeof id === 'string' ? id : Array.isArray(id) ? id[0] : undefined;

    if (customerId === undefined || customerId === '') {
      setError('No se pudo leer el identificador del cliente desde la URL.');
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    // Fetch customer + tiers in parallel
    Promise.all([
      api.getCustomer(customerId),
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

  // Build unified timeline: merge events + transactions, sort newest first
  const HIDDEN_EVENT_TYPES = ['customer.profile_viewed', 'profile_viewed', 'qr_displayed', 'customer.qr_displayed'];

  type TimelineItem = {
    id: string;
    kind: 'event' | 'tx';
    eventType: string;
    points: number;
    note: string | null;
    createdAt: string;
  };

  const mappedEvents: TimelineItem[] = (customer.customer_events ?? [])
    .filter((e) => !HIDDEN_EVENT_TYPES.includes(e.eventType))
    .map((e) => ({
      id: e.id,
      kind: 'event' as const,
      eventType: e.eventType,
      points: (e.payload?.points ?? 0) as number,
      note: null,
      createdAt: e.createdAt,
    }));

  const mappedTxs: TimelineItem[] = (customer.recent_transactions ?? []).map((t) => ({
    id: t.id,
    kind: 'tx' as const,
    eventType: t.type === 'earn' || t.type === 'earned' ? 'points.earned'
              : t.type === 'redeem' ? 'points.redeemed' : t.type,
    points: t.points,
    note: t.note ?? null,
    createdAt: t.createdAt,
  }));

  const timelineItems = [...mappedEvents, ...mappedTxs]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 20);

  function timelineLabel(item: TimelineItem): string {
    if (item.kind === 'tx' && item.note) return item.note;
    const labels: Record<string, string> = {
      'points.earned': 'Puntos ganados',
      'points.redeemed': 'Puntos canjeados',
      'customer.registered': 'Registro',
      'visit': 'Visita al local',
      'CUSTOMER_REGISTERED': 'Registro',
      'POINTS_EARNED': 'Puntos ganados',
      'POINTS_REDEEMED': 'Puntos canjeados',
      'TIER_CHANGED': 'Cambio de nivel',
      'VISIT_RECORDED': 'Visita registrada',
    };
    return labels[item.eventType] || item.eventType;
  }

  function timelineColor(type: string): string {
    if (type === 'points.earned') return '#16a34a';
    if (type === 'points.redeemed') return '#dc2626';
    if (type === 'visit') return '#2563eb';
    if (type === 'customer.registered') return '#7c3aed';
    return '#6b7280';
  }

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

        {timelineItems.length === 0 ? (
          <p className="text-muted" style={{ padding: '1rem 0' }}>
            Sin actividad registrada
          </p>
        ) : (
          <div className="event-timeline">
            {timelineItems.map((ev) => {
              const color = timelineColor(ev.eventType);
              const isRedeem = ev.eventType === 'points.redeemed';
              return (
                <div key={`${ev.kind}-${ev.id}`} className="event-row">
                  <div className="event-dot" style={{ background: color }} />
                  <div className="event-body">
                    <span className="event-type">{timelineLabel(ev)}</span>
                    {ev.points > 0 && (
                      <span
                        className="event-points"
                        style={{ color: isRedeem ? color : '#16a34a' }}
                      >
                        {isRedeem ? '-' : '+'}{ev.points.toLocaleString()} pts
                      </span>
                    )}
                    <span className="event-date">{formatRelative(ev.createdAt)}</span>
                  </div>
                </div>
              );
            })}
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
