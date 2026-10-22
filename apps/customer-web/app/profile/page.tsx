'use client';

import { Clock, Gift } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

import { ClubShell } from '../components/club-shell';
import { ClubError, ClubStatus } from '../components/club-status';
import { ConsentList } from '../components/consent-list';
import { ActivitySkeleton, MemberPass } from '../components/member-pass';
import { MemberQr } from '../components/member-qr';
import { WalletCard } from '../components/wallet-card';
import { api, type CustomerProfile } from '../lib/api';
import { useAuth } from '../lib/auth';
import { pushSupported, subscribeToPush } from '../lib/push';

const ERROR_TITLE = 'No pudimos cargar tu pase';
const ERROR_DESCRIPTION =
  'Hubo un problema al traer tus datos. Podés reintentar; no modificamos nada en tu cuenta.';

const HIDDEN_TYPES = [
  'customer.profile_viewed',
  'profile_viewed',
  'qr_displayed',
  'customer.qr_displayed',
];

interface TimelineItem {
  id: string;
  eventType: string;
  points: number;
  note: string | null;
  createdAt: string;
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

function describeEvent(eventType: string, note: string | null): string {
  if (note) return note;
  if (eventType === 'points.earned') return 'Puntos ganados';
  if (eventType === 'points.redeemed') return 'Puntos canjeados';
  if (eventType === 'visit') return 'Visita al local';
  if (eventType === 'customer.registered') return 'Registro';
  return eventType;
}

function eventSign(eventType: string): '+' | '−' | '•' {
  if (eventType === 'points.earned') return '+';
  if (eventType === 'points.redeemed') return '−';
  return '•';
}

/**
 * Merges the two real activity sources into one chronological list.
 *
 * Events and transactions overlap, so both are read and de-duplicated by id
 * rather than picking a source and pretending the other does not exist.
 */
function buildTimeline(profile: CustomerProfile): TimelineItem[] {
  const fromEvents: TimelineItem[] = (profile.customer_events ?? [])
    .filter((event) => !HIDDEN_TYPES.includes(event.eventType))
    .map((event) => ({
      id: event.id,
      eventType: event.eventType,
      points: Number(event.payload?.points ?? 0),
      note: null,
      createdAt: event.createdAt,
    }));

  const fromTransactions: TimelineItem[] = (profile.recent_transactions ?? []).map((tx) => ({
    id: tx.id,
    eventType:
      tx.type === 'earn' || tx.type === 'earned'
        ? 'points.earned'
        : tx.type === 'redeem'
          ? 'points.redeemed'
          : tx.type,
    points: tx.points,
    note: tx.note ?? null,
    createdAt: tx.createdAt,
  }));

  const byId = new Map<string, TimelineItem>();
  for (const item of [...fromEvents, ...fromTransactions]) {
    if (!byId.has(item.id)) byId.set(item.id, item);
  }

  return [...byId.values()]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 5);
}

function PassSkeleton() {
  return (
    <section className="club-pass" aria-label="Cargando tu pase">
      <div className="club-pass__skeleton-head" aria-hidden="true">
        <span className="club-pass__skeleton-line club-pass__skeleton-line--short" />
        <span className="club-pass__skeleton-line club-pass__skeleton-line--title" />
      </div>

      <div className="club-pass__balance" aria-hidden="true">
        <span className="club-pass__skeleton-line club-pass__skeleton-line--tiny" />
        <span className="club-pass__skeleton-line club-pass__skeleton-line--hero" />
      </div>

      <div className="club-pass__meta" aria-hidden="true">
        <span className="club-pass__skeleton-line" />
        <span className="club-pass__skeleton-line" />
        <span className="club-pass__skeleton-line" />
      </div>

      <div className="club-ladder" aria-hidden="true">
        <span className="club-pass__skeleton-line club-pass__skeleton-line--tiny" />
        <span className="club-pass__skeleton-line" />
        <span className="club-pass__skeleton-line" />
        <span className="club-pass__skeleton-line" />
      </div>
    </section>
  );
}

function QrSkeleton() {
  return (
    <div className="club-qr" aria-hidden="true">
      <span className="club-pass__skeleton-line club-pass__skeleton-line--tiny" />
      <span className="club-pass__skeleton-line club-pass__skeleton-line--qr" />
      <span className="club-pass__skeleton-line" />
    </div>
  );
}

/**
 * The loading screen is a skeleton of the real screen, not a spinner and not a
 * word. The pass, the ladder, the QR and the activity each have a shape here,
 * so the page does not jump when the data lands.
 */
function ProfileLoading() {
  return (
    <ClubShell className="club-pass-shell">
      <ClubStatus variant="loading">
        <span className="club-status__description">Cargando tu pase…</span>
      </ClubStatus>
      <PassSkeleton />
      <QrSkeleton />
      <ActivitySkeleton />
    </ClubShell>
  );
}

function Activity({ items, currency }: { items: TimelineItem[]; currency: string | null }) {
  if (items.length === 0) {
    return (
      <section className="club-activity" aria-label="Actividad reciente">
        <h2 className="club-activity__title">Actividad</h2>
        <p className="club-activity__empty">
          Todavía no hay movimientos. Cuando acumules puntos en el local, los vas a ver acá.
        </p>
      </section>
    );
  }

  return (
    <section className="club-activity" aria-label="Actividad reciente">
      <h2 className="club-activity__title">Actividad</h2>
      <ul className="club-activity__list">
        {items.map((item) => {
          const sign = eventSign(item.eventType);
          const isDebit = item.eventType === 'points.redeemed';

          return (
            <li className="club-activity__item" key={item.id}>
              <span
                className={`club-activity__sign${isDebit ? ' club-activity__sign--debit' : ''}`}
                aria-hidden="true"
              >
                {sign}
              </span>

              <span className="club-activity__body">
                <span className="club-activity__label">{describeEvent(item.eventType, item.note)}</span>
                {/* The sign is decorative, so the spoken text carries the
                    direction too — never colour or glyph alone. */}
                <span className="club-activity__amount">
                  {sign === '+'
                    ? `Ganaste ${item.points.toLocaleString('es-CL')}${currency ? ` ${currency}` : ''}`
                    : sign === '−'
                      ? `Canjeaste ${Math.abs(item.points).toLocaleString('es-CL')}${currency ? ` ${currency}` : ''}`
                      : formatRelative(item.createdAt)}
                </span>
              </span>

              <span className="club-activity__date">{formatRelative(item.createdAt)}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export default function ProfilePage() {
  const router = useRouter();
  const { customer, logout, isLoading: authLoading } = useAuth();

  const [profile, setProfile] = useState<CustomerProfile | null>(null);
  const [fetching, setFetching] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pushState, setPushState] = useState<string | null>(null);
  const [pushLoading, setPushLoading] = useState(false);

  useEffect(() => {
    if (!authLoading && !customer) {
      router.replace('/login');
    }
  }, [authLoading, customer, router]);

  const load = useCallback(() => {
    setFetching(true);
    setError(null);

    return api
      .getProfile()
      .then((data) => {
        setProfile(data);
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setFetching(false));
  }, []);

  useEffect(() => {
    if (!customer) return;
    void Promise.resolve().then(() => load());
  }, [customer, load]);

  if (authLoading || fetching) {
    return <ProfileLoading />;
  }

  // No session: reveal nothing, including whether an error occurred.
  if (!customer) return null;

  // An error is reported as an error. There is deliberately no fallback profile
  // with a borrowed name, tier or balance — a plausible-looking pass is worse
  // than an honest failure, because the user would act on invented numbers.
  if (error || !profile) {
    return (
      <ClubShell className="club-pass-shell">
        <ClubError
          title={ERROR_TITLE}
          description={ERROR_DESCRIPTION}
          action={
            <button type="button" className="btn btn--outline" onClick={() => void load()}>
              Reintentar
            </button>
          }
        />
      </ClubShell>
    );
  }

  const timeline = buildTimeline(profile);
  const currency = profile.program?.pointsCurrency ?? null;

  return (
    <ClubShell className="club-pass-shell">
      <MemberPass profile={profile} />

      <MemberQr globalId={profile.globalId} fullName={profile.fullName} />

      {/*
        The Google Wallet pass, and the third link in the path from the merchant's
        page to a card in the customer's phone. It used to be absent from here
        entirely while the endpoint behind it worked, so a customer could reach
        their profile and never be offered the pass.

        It renders after `MemberQr` because it is the same identity told a second
        way: the QR for a machine at the counter, the card for the customer's own
        phone.

        On the **member code** — the six characters read out at the counter, and
        `LoyaltyObject.accountId`. It appears here and only here, because this is
        the first thing in a customer's life that mints it. It is derived lazily,
        on the pass request, and deliberately not at registration: doing it in
        `workers/customer` would mean handing `MEMBER_CODE_PEPPER` — the secret
        that makes the code non-recomputable by anyone who has scanned a pass — to
        a worker with no other reason to hold it (`workers/wallet/src/issuance.ts`).

        So a profile whose wallet card has not answered yet shows no code, and
        that is the ordinary state rather than a broken account. The card says so
        in as many words while it is asking, which is why this comment is about
        the reader's expectation and not about the rendering.
      */}
      <WalletCard />

      <Activity items={timeline} currency={currency} />

      <nav className="club-pass__actions" aria-label="Tu cuenta">
        <Link href="/profile/history" className="btn btn--secondary">
          <Clock size={18} aria-hidden="true" />
          Ver historial
        </Link>
        <Link href="/profile/rewards" className="btn btn--primary">
          <Gift size={18} aria-hidden="true" />
          Canjear puntos
        </Link>
      </nav>

      {/* The register page states plainly that these controls store nothing, and
          the profile says the same thing in the same words. Two pages
          describing the same unavailable capability must not disagree. */}
      <ConsentList />

      {pushSupported() && (
        <section className="club-activity club-push" aria-label="Notificaciones">
          <h2 className="club-activity__title">Notificaciones</h2>
          <button
            type="button"
            className="btn btn--primary"
            onClick={async () => {
              setPushLoading(true);
              setPushState(null);
              try {
                const result = await subscribeToPush();
                if (result.ok) {
                  setPushState('Notificaciones activadas.');
                } else {
                  setPushState(result.message);
                }
              } catch (e) {
                setPushState(e instanceof Error ? e.message : 'No pudimos activar las notificaciones.');
              } finally {
                setPushLoading(false);
              }
            }}
            disabled={pushLoading}
          >
            {pushLoading ? 'Activando…' : 'Activar notificaciones push'}
          </button>
          {pushState && <p className="club-push__status">{pushState}</p>}
        </section>
      )}

      <button
        type="button"
        className="logout-btn"
        onClick={() => {
          logout();
          router.push('/');
        }}
      >
        Cerrar sesión
      </button>
    </ClubShell>
  );
}
