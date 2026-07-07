'use client';

export const runtime = 'edge';

import { Button } from '@vyloop/design-system';
import {
  AlertCircle,
  ArrowLeft,
  Award,
  Cake,
  Calendar,
  CheckCircle,
  Mail,
  Phone,
  Plus,
  Sparkles,
  Star,
  TrendingUp,
  X,
} from 'lucide-react';
import { useParams, useRouter } from 'next/navigation';
import { useState, useEffect } from 'react';

import styles from './page.module.css';

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

function getInitials(name: string): string {
  return name
    .split(' ')
    .slice(0, 2)
    .map((n) => n[0])
    .join('')
    .toUpperCase();
}

// ---------------------------------------------------------------------------
// Tier helpers
// ---------------------------------------------------------------------------

function tierClass(tierName: string): string {
  const key = tierName.toLowerCase();
  if (key === 'bronce') return styles.tierBronce;
  if (key === 'plata') return styles.tierPlata;
  if (key === 'oro') return styles.tierOro;
  return styles.tierPlata;
}

function tierDotColor(tierName: string): string {
  const colors: Record<string, string> = {
    Bronce: 'var(--brand-500)',
    Plata: 'var(--stone-400)',
    Oro: 'var(--brand-400)',
  };
  return colors[tierName] || 'var(--stone-400)';
}

function tierAvatarBg(tierName: string): string {
  const colors: Record<string, string> = {
    Bronce: 'var(--brand-100)',
    Plata: 'var(--stone-100)',
    Oro: 'var(--brand-100)',
  };
  return colors[tierName] || 'var(--stone-100)';
}

function tierAvatarColor(tierName: string): string {
  const colors: Record<string, string> = {
    Bronce: 'var(--brand-700)',
    Plata: 'var(--stone-600)',
    Oro: 'var(--brand-800)',
  };
  return colors[tierName] || 'var(--stone-600)';
}

// ---------------------------------------------------------------------------
// Event dot color
// ---------------------------------------------------------------------------

function eventDotColor(eventType: string): string {
  const colors: Record<string, string> = {
    CUSTOMER_REGISTERED: 'var(--info)',
    POINTS_EARNED: 'var(--success)',
    POINTS_REDEEMED: 'var(--error)',
    TIER_CHANGED: 'var(--warning)',
    VISIT_RECORDED: 'var(--stone-400)',
  };
  return colors[eventType] || 'var(--stone-300)';
}

function eventPointsColor(points: number): string {
  return points > 0 ? 'var(--success)' : 'var(--error)';
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
      <div className={styles.loadingState}>
        <div className={styles.spinner} />
        <span>Cargando cliente…</span>
      </div>
    );
  }

  if (error || !customer) {
    return (
      <div className={styles.errorState}>
        <AlertCircle size={32} style={{ color: 'var(--error)' }} />
        <p className={styles.errorMessage}>{error || 'Cliente no encontrado'}</p>
        <Button variant="secondary" onClick={() => router.push('/dashboard/customers')}>
          Volver a clientes
        </Button>
      </div>
    );
  }

  const recentEvents = customer.customer_events.slice(-10).reverse();

  return (
    <>
      {/* Back */}
      <button className={styles.backLink} onClick={() => router.push('/dashboard/customers')}>
        <ArrowLeft size={14} />
        Volver a clientes
      </button>

      {/* ---------- Hero Card ---------- */}
      <div
        className={styles.heroCard}
        style={{
          borderLeft: `3px solid ${tierDotColor(tierName)}`,
        }}
      >
        <div className={styles.heroContent}>
          <div
            className={styles.avatar}
            style={{
              background: tierAvatarBg(tierName),
              color: tierAvatarColor(tierName),
            }}
          >
            {getInitials(customer.fullName)}
          </div>

          <div className={styles.heroInfo}>
            <h1 className={styles.heroName}>{customer.fullName}</h1>

            <div className={styles.heroMeta}>
              {customer.email && (
                <span className={styles.heroMetaItem}>
                  <Mail />
                  {customer.email}
                </span>
              )}
              <span className={styles.heroMetaItem}>
                <Phone />
                {customer.phone}
              </span>
              {customer.birthDate && (
                <span className={styles.heroMetaItem}>
                  <Cake />
                  {new Date(customer.birthDate).toLocaleDateString('es-MX')}
                </span>
              )}
            </div>

            <div className={styles.heroSince}>
              <Calendar />
              Cliente desde {customer.createdAt}
            </div>
          </div>
        </div>

        {/* Stats */}
        <div className={styles.statsRow}>
          <div className={styles.statCard}>
            <span className={styles.statLabel}>
              <Award size={12} style={{ verticalAlign: 'middle', marginRight: 4 }} />
              Nivel
            </span>
            <span className={`${styles.tierBadge} ${tierClass(tierName)}`}>
              <Sparkles size={12} />
              {tierName}
            </span>
          </div>
          <div className={styles.statCard}>
            <span className={styles.statLabel}>
              <Star size={12} style={{ verticalAlign: 'middle', marginRight: 4 }} />
              Puntos
            </span>
            <span className={styles.statValue}>{customer.points.toLocaleString()}</span>
          </div>
          <div className={styles.statCard}>
            <span className={styles.statLabel}>
              <TrendingUp size={12} style={{ verticalAlign: 'middle', marginRight: 4 }} />
              Ganados (total)
            </span>
            <span className={styles.statValue}>
              {customer.totalPointsEarned.toLocaleString()}
            </span>
          </div>
        </div>

        {/* Actions */}
        <div className={styles.heroActions}>
          <Button variant="primary" icon={<Plus size={16} />} onClick={handleOpenModal}>
            Registrar Venta
          </Button>
        </div>
      </div>

      {/* ---------- Recent Activity ---------- */}
      <div className={styles.activityCard}>
        <div className={styles.activityHeader}>
          <h2 className={styles.activityTitle}>Actividad reciente</h2>
          <span className="text-xs text-muted">{recentEvents.length} eventos</span>
        </div>

        {recentEvents.length === 0 ? (
          <div className={styles.activityEmpty}>Sin actividad registrada</div>
        ) : (
          <div className={styles.timeline}>
            {recentEvents.map((ev, i) => (
              <div key={ev.id || i} className={styles.timelineItem}>
                <div
                  className={styles.timelineDot}
                  style={{ background: eventDotColor(ev.eventType) }}
                />
                <div className={styles.timelineBody}>
                  <span className={styles.timelineType}>{eventLabel(ev.eventType)}</span>
                  {ev.points != null && ev.points !== 0 && (
                    <span
                      className={styles.timelinePoints}
                      style={{ color: eventPointsColor(ev.points) }}
                    >
                      {ev.points > 0 ? '+' : ''}
                      {ev.points} pts
                    </span>
                  )}
                  <span className={styles.timelineDate}>{formatDate(ev.createdAt)}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ---------- Registrar Venta Modal ---------- */}
      {showModal && (
        <div className={styles.modalOverlay} onClick={handleCloseModal}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div className={styles.modalHeader}>
              <h3 className={styles.modalTitle}>Registrar Venta</h3>
              <button className={styles.modalClose} onClick={handleCloseModal}>
                <X size={18} />
              </button>
            </div>

            <div className={styles.modalBody}>
              <div className={styles.formGroup}>
                <label className={styles.formLabel} htmlFor="sale-amount">
                  Monto de venta ($)
                </label>
                <input
                  id="sale-amount"
                  type="number"
                  min="1"
                  className={styles.formControl}
                  placeholder="Ej: 1500"
                  value={amount || ''}
                  onChange={(e) => setAmount(Number(e.target.value))}
                />
              </div>

              {amount > 0 && (
                <div className={styles.pointsPreview}>
                  <p className={styles.pointsPreviewTitle}>Desglose de puntos</p>
                  <div className={styles.pointsBreakdown}>
                    <span>Base: {amount} pts</span>
                    <span>&times; Multiplicador ({tierMultiplier}x)</span>
                    <span className={styles.pointsTotal}>
                      = {Math.floor(amount * earnRate * tierMultiplier)} pts
                    </span>
                  </div>
                </div>
              )}

              <div className={styles.formGroup}>
                <label className={styles.formLabel} htmlFor="sale-note">
                  Nota (opcional)
                </label>
                <textarea
                  id="sale-note"
                  className={styles.formControl}
                  rows={2}
                  placeholder="Nota interna sobre esta venta"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
              </div>

              {modalError && (
                <p className={styles.modalError}>
                  <AlertCircle size={14} />
                  {modalError}
                </p>
              )}
            </div>

            <div className={styles.modalFooter}>
              <Button variant="secondary" onClick={handleCloseModal} disabled={submitting}>
                Cancelar
              </Button>
              <Button
                variant="primary"
                onClick={handleSubmit}
                disabled={submitting || amount < 1}
                loading={submitting}
              >
                Registrar Venta
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div className={styles.toastContainer}>
          <div
            className={`${styles.toast} ${toast.type === 'success' ? styles.toastSuccess : styles.toastError}`}
          >
            {toast.type === 'success' ? <CheckCircle size={16} /> : <AlertCircle size={16} />}
            {toast.message}
          </div>
        </div>
      )}
    </>
  );
}
