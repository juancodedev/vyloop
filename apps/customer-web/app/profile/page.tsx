'use client';

import { Clock, Gift, ChevronDown, ChevronUp, QrCode, Sparkles } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import QRCode from 'qrcode';
import { useCallback, useEffect, useState } from 'react';

import { api, type CustomerProfile } from '../lib/api';
import { useAuth } from '../lib/auth';

const CID_KEY = 'vyloop_customer_id';

// ─── Tier configuration ──────────────────────────────────────────────

const TIER_CONFIG: Record<string, { min: number; next: string; nextMin: number; color: string; label: string }> = {
  Bronce:  { min: 0,    next: 'Plata', nextMin: 1000, color: 'var(--brand-600)', label: 'Bronce' },
  Plata:   { min: 1000, next: 'Oro',   nextMin: 3000, color: 'var(--stone-500)', label: 'Plata' },
  Oro:     { min: 3000, next: '',      nextMin: 0,     color: 'var(--brand-500)', label: 'Oro' },
};

function getTierConfig(tierName: string | null) {
  return TIER_CONFIG[tierName ?? ''] ?? TIER_CONFIG.Bronce;
}

function formatRelative(time: string): string {
  const diff = Date.now() - new Date(time).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Ahora mismo';
  if (mins < 60) return `Hace ${mins} min`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `Hace ${hrs} h`;
  const days = Math.floor(hrs / 24);
  if (days === 1) return 'Ayer';
  if (days < 7) return `Hace ${days} días`;
  return `Hace ${Math.floor(days / 7)} sem`;
}

function getInitials(name: string): string {
  return name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
}

function getTierEmoji(tier: string | null): string {
  switch (tier) {
    case 'Oro': return '👑';
    case 'Plata': return '⭐';
    default: return '🌱';
  }
}

function getTierProgressMessage(points: number, tierName: string | null): string {
  const cfg = getTierConfig(tierName);
  if (!cfg.next) return '🎉 ¡Has alcanzado el nivel máximo! Disfruta de tus beneficios exclusivos.';
  const needed = cfg.nextMin - points;
  if (needed <= 0) return `⭐ ¡Estás listo para subir a ${cfg.next}!`;
  if (needed < 200) return `🔥 ¡Te faltan solo ${needed} pts para llegar a ${cfg.next}!`;
  if (needed < 500) return `💪 Sigue así, te faltan ${needed} pts para alcanzar ${cfg.next}.`;
  return `📈 Acumula ${needed} pts más y llega a ${cfg.next}`;
}

// ─── Page ────────────────────────────────────────────────────────────

export default function ProfilePage() {
  const router = useRouter();
  const { customer, logout, isLoading: authLoading } = useAuth();
  const [profile, setProfile] = useState<CustomerProfile | null>(null);
  const [fetching, setFetching] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [animatePoints, setAnimatePoints] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!authLoading && !customer) {
      router.replace('/login');
    }
  }, [authLoading, customer, router]);

  useEffect(() => {
    if (!customer) return;

    setFetching(true);
    api
      .getProfile()
      .then((data) => {
        setProfile(data);
        localStorage.setItem(CID_KEY, data.id);
        // Trigger number animation after render
        setTimeout(() => setAnimatePoints(true), 200);
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setFetching(false));
  }, [customer]);

  // ─── QR generation ───────────────────────────────────────────────

  const generateQr = useCallback(async () => {
    if (qrDataUrl) return;
    if (!profile) return;
    const url = `/c/${profile.globalId}`;
    try {
      const dataUrl = await QRCode.toDataURL(url, {
        width: 200,
        margin: 2,
        color: { dark: '#1c1917', light: '#ffffff' },
      });
      setQrDataUrl(dataUrl);
    } catch {
      // silently fail — QR is non-critical
    }
  }, [profile, qrDataUrl]);

  // Toggle QR section
  const handleQrToggle = useCallback(() => {
    if (!qrOpen) {
      generateQr();
    }
    setQrOpen((prev) => !prev);
  }, [qrOpen, generateQr]);

  // ─── Loading state ───────────────────────────────────────────────

  if (authLoading || fetching) {
    return (
      <div className="page page--centered fade-in">
        <div className="loading-pulse">
          <div className="loading-avatar" />
          <div className="loading-line" style={{ width: 160 }} />
          <div className="loading-line" style={{ width: 120 }} />
        </div>
      </div>
    );
  }

  if (!customer) return null;

  if (error) {
    return (
      <div className="page fade-in">
        <div className="error-box">{error}</div>
        <button type="button" className="btn btn--primary" onClick={() => window.location.reload()}>
          Reintentar
        </button>
      </div>
    );
  }

  const p = profile;
  if (!p) return null;

  const tierCfg = getTierConfig(p.currentTier);
  const progress = tierCfg.nextMin > 0 ? Math.min(100, (p.points / tierCfg.nextMin) * 100) : 100;
  const pointsToNext = tierCfg.nextMin > 0 ? Math.max(0, tierCfg.nextMin - p.points) : 0;
  const memberDate = new Date(p.createdAt);
  const memberSince = memberDate.toLocaleDateString('es-CL', { month: 'long', year: 'numeric' });
  const points30 = p.pointsLast30Days ?? 0;
  // Merge and sort events + transactions into a unified timeline
  type TimelineItem = {
    id: string;
    kind: 'event' | 'tx';
    eventType: string;
    points: number;
    note: string | null;
    createdAt: string;
  };
  const hiddenTypes = ['customer.profile_viewed', 'profile_viewed', 'qr_displayed', 'customer.qr_displayed'];
  const mappedEvents: TimelineItem[] = (p.customer_events ?? [])
    .filter((e) => !hiddenTypes.includes(e.eventType))
    .map((e) => ({
      id: e.id,
      kind: 'event' as const,
      eventType: e.eventType,
      points: (e.payload?.points ?? 0) as number,
      note: null,
      createdAt: e.createdAt,
    }));
  const mappedTxs: TimelineItem[] = (p.recent_transactions ?? []).map((t) => ({
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
    .slice(0, 5);
  const isOro = p.currentTier === 'Oro';

  return (
    <div className="page fade-in">
      {/* ─── Branding bar ─── */}
      <div className="profile-brand-bar">
        <span className="profile-brand-label">Mi Perfil</span>
      </div>

      {/* ─── Avatar & Greeting ─── */}
      <div className="profile-hero">
        <div className={`profile-avatar ${isOro ? 'profile-avatar--oro' : ''}`}>
          {getInitials(p.fullName)}
        </div>
        <h1 className="profile-name">
          {p.fullName.split(' ')[0]}
        </h1>
        <p className="profile-member">Miembro desde {memberSince}</p>
      </div>

      {/* ─── Points hero card ─── */}
      <div className={`profile-points-card ${isOro ? 'profile-points-card--oro' : ''}`}>
        <div className="profile-points-card-bg" />
        <div className="profile-points-tier">
          <span className="profile-tier-badge">
            {getTierEmoji(p.currentTier)} {p.currentTier ?? 'Bronce'}
          </span>
          {p.tier && (
            <span className="profile-tier-mult">{p.tier.multiplier}x multiplicador</span>
          )}
        </div>

        <div className="profile-points-main">
          <span className="profile-points-label">Tus puntos</span>
          <div className={`profile-points-value ${animatePoints ? 'profile-points-animate' : ''}`}>
            {p.points.toLocaleString('es-CL')}
          </div>
        </div>

        <div className="profile-points-meta">
          <div className="profile-points-stat">
            <span className="profile-stat-value">{p.totalPointsEarned.toLocaleString('es-CL')}</span>
            <span className="profile-stat-label">Acumulados</span>
          </div>
          <div className="profile-points-stat">
            <span className="profile-stat-value">
              {points30 > 0 ? `+${points30.toLocaleString('es-CL')} pts` : '—'}
            </span>
            <span className="profile-stat-label">Últimos 30 días</span>
          </div>
        </div>
      </div>

      {/* ─── QR Section ─── */}
      <div className={`profile-qr-card card ${qrOpen ? 'profile-qr-card--open' : ''}`}>
        <button
          type="button"
          className="profile-qr-trigger"
          onClick={handleQrToggle}
          aria-expanded={qrOpen}
        >
          <QrCode size={20} />
          <span>Mi código QR</span>
          {qrOpen ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
        </button>
        {qrOpen && (
          <div className="profile-qr-body">
            <p className="profile-qr-hint">
              Mostrá este código en el local para que te reconozcan
            </p>
            <div className="profile-qr-code">
              {qrDataUrl ? (
                <img src={qrDataUrl} alt="Código QR de perfil" width={200} height={200} />
              ) : (
                <div className="profile-qr-placeholder">
                  <div className="loading-pulse">
                    <div className="loading-line" style={{ width: 180, height: 180 }} />
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* ─── Achievement / Tier Progress ─── */}
      {isOro ? (
        <div className="profile-achievement-card">
          <div className="profile-achievement-glow" />
          <Sparkles size={24} className="profile-achievement-icon" />
          <h3 className="profile-achievement-title">Nivel Oro</h3>
          <p className="profile-achievement-desc">
            ¡Sos nuestro cliente más valioso! Disfrutá de todos los beneficios exclusivos.
          </p>
          <div className="profile-achievement-badge">
            {getTierEmoji(p.currentTier)} Oro
          </div>
        </div>
      ) : (
        tierCfg.next && (
          <div className="profile-progress-card card">
            <div className="profile-progress-header">
              <span className="profile-progress-title">
                Progreso a {tierCfg.next}
              </span>
              <span className="profile-progress-points">
                {pointsToNext > 0 ? `${pointsToNext.toLocaleString()} pts` : '¡Listo!'}
              </span>
            </div>
            <div className="profile-progress-bar-track">
              <div
                className="profile-progress-bar-fill"
                style={{ width: `${Math.min(100, progress)}%` }}
              />
            </div>
            <p className="profile-progress-msg">
              {getTierProgressMessage(p.points, p.currentTier)}
            </p>
          </div>
        )
      )}

      {/* ─── Recent Activity / Empty State ─── */}
      {timelineItems.length > 0 ? (
        <div className="profile-section">
          <h2 className="section-title">Actividad Reciente</h2>
          <div className="profile-timeline">
            {timelineItems.map((ev) => {
              const isEarn = ev.eventType === 'points.earned';
              const isRedeem = ev.eventType === 'points.redeemed';
              const isVisit = ev.eventType === 'visit';
              const isRegister = ev.eventType === 'customer.registered';

              let icon: string;
              let label: string;
              let colorValue: string;

              if (isEarn) {
                icon = '+';
                label = ev.note ?? 'Puntos ganados';
                colorValue = '#16a34a';
              } else if (isRedeem) {
                icon = '−';
                label = ev.note ?? 'Puntos canjeados';
                colorValue = '#dc2626';
              } else if (isVisit) {
                icon = '→';
                label = 'Visita al local';
                colorValue = '#2563eb';
              } else if (isRegister) {
                icon = '✓';
                label = 'Registro';
                colorValue = 'var(--brand-500)';
              } else {
                icon = '•';
                label = ev.eventType;
                colorValue = 'var(--text-muted)';
              }

              const pts = ev.points;

              return (
                <div key={ev.id} className="profile-timeline-item">
                  <div className="profile-timeline-icon" style={{ background: `color-mix(in srgb, ${colorValue} 10%, transparent)`, color: colorValue }}>
                    {icon}
                  </div>
                  <div className="profile-timeline-body">
                    <span className="profile-timeline-label">{label}</span>
                    {pts > 0 && (
                      <span className="profile-timeline-pts" style={{ color: isRedeem ? colorValue : '#16a34a' }}>
                        {isRedeem ? '-' : '+'}{pts.toLocaleString('es-CL')} pts
                      </span>
                    )}
                  </div>
                  <span className="profile-timeline-date">{formatRelative(ev.createdAt)}</span>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="profile-empty-state">
          <div className="profile-empty-icon">
            <Gift size={32} />
          </div>
          <h3 className="profile-empty-title">Todavía no tenés actividad</h3>
          <p className="profile-empty-desc">
            Visitá el local para empezar a acumular puntos y acceder a beneficios exclusivos.
          </p>
        </div>
      )}

      {/* ─── Actions row ─── */}
      <div className="profile-actions">
        <Link href="/profile/history" className="btn btn--secondary">
          <Clock size={18} />
          Ver historial
        </Link>
        <Link href="/profile/rewards" className="btn btn--primary">
          <Gift size={18} />
          Canjear puntos
        </Link>
      </div>

      {/* ─── Logout ─── */}
      <button
        type="button"
        className="logout-btn"
        onClick={() => {
          localStorage.removeItem(CID_KEY);
          logout();
          router.push('/');
        }}
      >
        Cerrar sesión
      </button>
    </div>
  );
}
