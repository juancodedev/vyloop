'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';

import { ClubShell } from '../../components/club-shell';
import { ClubError, ClubStatus } from '../../components/club-status';
import { MovementList } from '../../components/movement-list';
import { api, type CustomerProfile, type Transaction } from '../../lib/api';
import { useAuth } from '../../lib/auth';

const ERROR_TITLE = 'No pudimos cargar tu historial';
const ERROR_DESCRIPTION =
  'Hubo un problema al traer tus movimientos. Podés reintentar; no modificamos nada en tu cuenta.';

const HISTORY_LABEL = 'Tus movimientos de puntos';

type Filter = 'all' | 'earn' | 'redeem';

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'Todos' },
  { key: 'earn', label: 'Ganados' },
  { key: 'redeem', label: 'Canjeados' },
];

const EMPTY_COPY: Record<Filter, string> = {
  all: 'Todavía no tenés movimientos. Cuando acumules o canjees puntos, los vas a ver acá.',
  earn: 'Todavía no tené movimientos de puntos ganados.',
  redeem: 'Todavía no canjeaste ninguna recompensa.',
};

const FILTER_QUERY: Record<Filter, 'earn' | 'redeem' | undefined> = {
  all: undefined,
  earn: 'earn',
  redeem: 'redeem',
};

export default function HistoryPage() {
  const router = useRouter();
  const { customer, isLoading } = useAuth();

  const [filter, setFilter] = useState<Filter>('all');
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [profile, setProfile] = useState<CustomerProfile | null>(null);
  const [fetching, setFetching] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Whether a first answer has arrived. Without it, changing a filter would
  // tear down the whole page — tabs included — for the length of a round trip,
  // so the control the user just pressed would vanish under their finger.
  const [answered, setAnswered] = useState(false);

  /**
   * Orders the responses.
   *
   * Two filters pressed in quick succession put two reads in flight, and
   * nothing guarantees they come back in order. Without this the slower first
   * response can land last and repopulate the list with the rows for a filter
   * the customer has already moved off, under the heading of the one they
   * pressed last. Each call takes a ticket and only the newest may write.
   */
  const latestRequest = useRef(0);

  useEffect(() => {
    if (!isLoading && !customer) {
      router.replace('/login');
    }
  }, [isLoading, customer, router]);

  /**
   * The one history call this page makes.
   *
   * No `customer_id` is sent, because there is nothing to send it from: the
   * previous version read a stored customer id out of localStorage and refused
   * to call the API at all when it was missing. That made the page unreachable
   * on a fresh device, and on a shared one it would have named whoever used the
   * device last. The server narrows a customer to their own rows from the
   * token, so omitting the parameter is not a shortcut — it is the correct call.
   *
   * `getProfile` runs alongside purely for the tenant's points label, so the
   * unit on screen is the merchant's own word and not a hardcoded one.
   */
  const load = useCallback((next: Filter) => {
    latestRequest.current += 1;
    const ticket = latestRequest.current;

    setFetching(true);
    setError(null);

    return Promise.all([api.getOwnTransactions({ type: FILTER_QUERY[next], limit: 50 }), api.getProfile()])
      .then(([result, me]) => {
        if (ticket !== latestRequest.current) return;
        setTransactions(result.data);
        setProfile(me);
      })
      .catch((err: Error) => {
        if (ticket !== latestRequest.current) return;
        setError(err.message);
      })
      .finally(() => {
        if (ticket !== latestRequest.current) return;
        setAnswered(true);
        setFetching(false);
      });
  }, []);

  useEffect(() => {
    if (!customer) return;
    void load(filter);
  }, [customer, filter, load]);

  if (isLoading || (fetching && !answered)) {
    return (
      <ClubShell backLink={{ href: '/profile', label: 'Volver a mi pase' }}>
        <ClubStatus variant="loading">
          <span className="club-status__description">Cargando tu historial…</span>
        </ClubStatus>
      </ClubShell>
    );
  }

  if (!customer) return null;

  if (error) {
    return (
      <ClubShell backLink={{ href: '/profile', label: 'Volver a mi pase' }}>
        <ClubError
          title={ERROR_TITLE}
          description={ERROR_DESCRIPTION}
          action={
            <button type="button" className="btn btn--outline" onClick={() => void load(filter)}>
              Reintentar
            </button>
          }
        />
      </ClubShell>
    );
  }

  const currency = profile?.program?.pointsCurrency ?? null;

  return (
    <ClubShell backLink={{ href: '/profile', label: 'Volver a mi pase' }}>
      <h1 className="title title--sm">Historial</h1>

      <div className="filter-tabs" role="group" aria-label="Filtrar movimientos">
        {FILTERS.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            className={`filter-tab${filter === key ? ' filter-tab--active' : ''}`}
            aria-pressed={filter === key}
            onClick={() => setFilter(key)}
          >
            {label}
          </button>
        ))}
      </div>

      {/*
        The list slot is what swaps while re-filtering, not the whole page, so
        the tab the customer just pressed stays under their finger. The previous
        rows are never left on screen under a new filter: they are the answer to
        a different question, and showing them would mislabel the list.
      */}
      {fetching ? (
        <ClubStatus variant="loading">
          <span className="club-status__description">Cargando tu historial…</span>
        </ClubStatus>
      ) : transactions.length === 0 ? (
        // Announced rather than left as an empty card: the user has to be told
        // that zero movements is the answer, not shown a blank panel and left
        // to guess whether the page failed.
        <ClubStatus variant="empty">
          <p className="club-status__title">Sin movimientos</p>
          <p className="club-status__description">{EMPTY_COPY[filter]}</p>
        </ClubStatus>
      ) : (
        <MovementList transactions={transactions} currency={currency} label={HISTORY_LABEL} />
      )}
    </ClubShell>
  );
}
