'use client';

import { Clock, Gift } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import { api, type CustomerProfile, type CustomerEvent } from '../lib/api';
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

function getVisitStreak(events: CustomerEvent[]): number {
  const visits = events.filter(e => e.eventType === 'visit');
  if (visits.length === 0) return 0;
  // Count recent visits (within last 30 days)
  const thirtyDays = 30 * 24 * 60 * 60 * 1000;
  return visits.filter(e => (Date.now() - new Date(e.createdAt).getTime()) < thirtyDays).length;
}

// ─── Page ────────────────────────────────────────────────────────────

export default function ProfilePage() {
  const router = useRouter();
  const { customer, logout, isLoading: authLoading } = useAuth();
  const [profile, setProfile] = useState<CustomerProfile | null>(null);
  const [fetching, setFetching] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [animatePoints, setAnimatePoints] = useState(false);

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
  const streak = getVisitStreak(p.customer_events ?? []);
  const recentEvents = (p.customer_events ?? []).slice(0, 6);

  return (
    <div className="page fade-in">
      {/* ─── Avatar & Greeting ─── */}
      <div className="profile-hero">
        <div className="profile-avatar">{getInitials(p.fullName)}</div>
        <h1 className="profile-name">
          {p.fullName.split(' ')[0]}
        </h1>
        <p className="profile-member">Miembro desde {memberSince}</p>
      </div>

      {/* ─── Points hero card ─── */}
      <div className="profile-points-card">
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
              {streak > 0 ? `${streak} visitas` : '—'}
            </span>
            <span className="profile-stat-label">Últimos 30 días</span>
          </div>
        </div>
      </div>

      {/* ─── Tier Progress ─── */}
      {tierCfg.next && (
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
      )}

      {/* ─── Recent Activity ─── */}
      {recentEvents.length > 0 && (
        <div className="profile-section">
          <h2 className="section-title">Actividad Reciente</h2>
          <div className="profile-timeline">
            {recentEvents.map((ev) => {
              const isEarn = ev.eventType === 'points.earned';
              const isRedeem = ev.eventType === 'points.redeemed';
              const isVisit = ev.eventType === 'visit';
              const isRegister = ev.eventType === 'customer.registered';

              let icon: string;
              let label: string;
              let color: string;

              if (isEarn) {
                icon = '+';
                label = 'Puntos ganados';
                color = '#16a34a';
              } else if (isRedeem) {
                icon = '−';
                label = 'Puntos canjeados';
                color = '#dc2626';
              } else if (isVisit) {
                icon = '→';
                label = 'Visita al local';
                color = '#2563eb';
              } else if (isRegister) {
                icon = '✓';
                label = 'Registro';
                color = 'var(--brand-500)';
              } else {
                icon = '•';
                label = ev.eventType;
                color = 'var(--text-muted)';
              }

              const pts = (ev.payload?.points ?? 0) as number;

              return (
                <div key={ev.id} className="profile-timeline-item">
                  <div className="profile-timeline-icon" style={{ background: `color-mix(in srgb, ${color} 10%, transparent)`, color }}>
                    {icon}
                  </div>
                  <div className="profile-timeline-body">
                    <span className="profile-timeline-label">{label}</span>
                    {pts > 0 && (
                      <span className="profile-timeline-pts" style={{ color: isRedeem ? color : '#16a34a' }}>
                        {isRedeem ? '-' : '+'}{pts} pts
                      </span>
                    )}
                  </div>
                  <span className="profile-timeline-date">{formatRelative(ev.createdAt)}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ─── Actions ─── */}
      <div className="profile-actions">
        <Link href="/profile/history" className="btn btn--secondary">
          <Clock size={18} />
          Ver historial completo
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
