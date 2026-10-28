'use client';

import { Cake } from 'lucide-react';
import { useParams, useRouter } from 'next/navigation';
import { useState, useEffect } from 'react';

import { api, type CustomerDetail } from '@/lib/api';
import {
  buildCustomerPatch,
  draftFromCustomer,
  formatBirthDate,
  formatCalendarDate,
  patchErrorFor,
  type CustomerDraft,
} from '@/lib/customer-edit';
import { DEFAULT_EARN_RULE, type EarnRule } from '@/lib/loyalty-earn-rule';
import { resolveEarn } from '@/lib/loyalty-points';

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
  return colors[tierName] || 'var(--text-muted)';
}

// ---------------------------------------------------------------------------
// The edit form
// ---------------------------------------------------------------------------

/**
 * Labels and input types for the four editable fields.
 *
 * Rendered from one table rather than four hand-written inputs so the form
 * cannot grow a field the server refuses: the allowlist in `@vyloop/types` is
 * the single source, and a key with no entry here would fail loudly rather than
 * render an input the operator can fill in and have rejected on save.
 */
const EDITABLE_FIELDS = [
  { key: 'fullName', label: 'Nombre', type: 'text', autoComplete: 'name' },
  { key: 'phone', label: 'Teléfono', type: 'tel', autoComplete: 'tel' },
  { key: 'email', label: 'Correo', type: 'email', autoComplete: 'email' },
  { key: 'birthDate', label: 'Fecha de nacimiento', type: 'date', autoComplete: 'bday' },
] as const satisfies ReadonlyArray<{
  key: keyof CustomerDraft;
  label: string;
  type: string;
  autoComplete: string;
}>;


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
  // The whole program, not just the rate: which field the worker reads is a
  // property of the tenant's mechanic, and this modal records sales the same way the
  // POS does. `DEFAULT_EARN_RULE` is `visit`, which is the mechanic the worker falls
  // back to, so a failed config load leaves every existing tenant behaving as it did.
  const [earnRule, setEarnRule] = useState<EarnRule>(DEFAULT_EARN_RULE);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [amount, setAmount] = useState(0);
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ type: string; message: string } | null>(null);

  // --- Edit state -----------------------------------------------------------
  //
  // `customer` is the server's answer and is the ONLY thing any read-only
  // surface renders from. It moves when the server says so and never before:
  // an edit applied optimistically and never rolled back leaves a merchant
  // looking at a phone number that was rejected, and nothing on screen says so.
  //
  // `draft` is separate, and holding it is not a claim about anything. It is the
  // operator's unsaved typing; it survives a refusal, because making them retype
  // a value the server just rejected is the other half of the same bug.
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<CustomerDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<{ field: string | null; message: string } | null>(null);

  function showToast(type: string, message: string) {
    setToast({ type, message });
    setTimeout(() => setToast(null), 3500);
  }

  function handleOpenEditor() {
    if (!customer) return;
    setDraft(draftFromCustomer(customer));
    setSaveError(null);
    setEditing(true);
  }

  function handleCancelEdit() {
    // Discards the draft on purpose: the operator chose to leave, and the card
    // above is already showing the server's values.
    setDraft(null);
    setSaveError(null);
    setEditing(false);
  }

  async function handleSaveEdit() {
    if (!customer || !draft) return;

    // Compared against the server's copy, never against the draft as it was when
    // the editor opened, so a field the server refused last time is not resent
    // unchanged and rejected again.
    const patch = buildCustomerPatch(draftFromCustomer(customer), draft);

    if (Object.keys(patch).length === 0) {
      setSaveError({ field: null, message: 'No hay cambios que guardar.' });
      return;
    }

    setSaving(true);
    setSaveError(null);
    try {
      await api.updateCustomer(customer.id, patch);
      const cust = await api.getCustomer(customer.id);
      // The server has answered. Now, and only now, does the card move.
      setCustomer(cust);
      setDraft(null);
      setEditing(false);
      showToast('success', 'Datos actualizados');
    } catch (err) {
      // The draft stays exactly as typed. `customer` is untouched, so every
      // read-only surface still shows what the server actually holds.
      setSaveError(patchErrorFor(err));
    } finally {
      setSaving(false);
    }
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
      // Which field this sale travels in, and what value travels in it, are the
      // tenant's mechanic — not this page's guess. `purchase` reads money, so the
      // raw amount goes; `visit` reads a count, so the count does. The previous
      // single call always sent `amount` as `points`, which a `purchase` tenant
      // refuses with `AMOUNT_REQUIRED` and a fractional amount refuses on `visit`
      // because the worker requires a whole number of visits.
      await (earn.inputField === 'amount_pesos'
        ? api.assignPurchasePoints(customer.id, amount, note || undefined)
        : api.assignPoints(customer.id, earn.base, note || undefined));
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
        setTierName(match?.name ?? '—');
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
      // eslint-disable-next-line react-hooks/set-state-in-effect
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
      // The whole rule, and `DEFAULT_EARN_RULE` on failure: `earn_by` defaults to
      // `visit` in the worker, so a load error must not leave this page sending
      // money to a program that counts visits.
      api.getLoyaltyConfig().catch(() => DEFAULT_EARN_RULE),
    ])
      .then(([cust, tiers, config]) => {
        setCustomer(cust);
        setEarnRule({
          earnBy: config.earnBy,
          earnRate: config.earnRate,
          earnUnitAmount: config.earnUnitAmount,
        });

        // Map tier ID to name + multiplier
        if (cust.currentTierId) {
          const match = tiers.find((t) => t.id === cust.currentTierId);
          setTierName(match?.name ?? '—');
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
        <p style={{ color: 'var(--error)', marginBottom: '1rem' }}>{error || 'Cliente no encontrado'}</p>
        <button className="btn btn-secondary" onClick={() => router.push('/dashboard/customers')}>
          Volver a clientes
        </button>
      </div>
    );
  }

  const tierBaseColor = tierColor(tierName);

  // What this modal sends — the same single decision the POS makes, through the same
  // helper. `amount` is a peso amount under `purchase` and a count of visits under
  // `visit`, so the field's label and its step follow the mechanic instead of
  // assuming pesos: the worker refuses a non-integer count, and an operator told to
  // "type the sale amount" would type 3.50.
  const earn = resolveEarn(earnRule, { pesos: amount, visits: amount }, tierMultiplier);
  const earnRate = earnRule.earnRate;
  const saleAmountLabel = earnRule.earnBy === 'purchase' ? 'Monto de venta ($)' : 'Visitas / conteos';
  // What one unit of the base is. Under `purchase` the base is the sale over the
  // tenant's unit, not the sale itself, so the input's label would misname it.
  const baseUnitLabel =
    earnRule.earnBy === 'purchase'
      ? `× $${earnRule.earnUnitAmount.toLocaleString('es-CL')} de compra`
      : 'visitas';
  const saleAmountStep = earnRule.earnBy === 'purchase' ? '0.01' : '1';
  const saleAmountPlaceholder = earnRule.earnBy === 'purchase' ? 'Ej: 1500' : 'Ej: 1';

  // Derived with the same function the save uses, so the marker cannot disagree
  // with what would actually be sent.
  const hasUnsavedChanges =
    editing && draft !== null
      ? Object.keys(buildCustomerPatch(draftFromCustomer(customer), draft)).length > 0
      : false;

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
              : t.type === 'redeem' ? 'points.redeemed' : 'points.adjusted',
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
      'points.adjusted': 'Ajuste de puntos',
      'customer.registered': 'Registro',
      'customer.checked_in': 'Visitó el local',
      'visit': 'Visita al local',
      'CUSTOMER_REGISTERED': 'Registro',
      'POINTS_EARNED': 'Puntos ganados',
      'POINTS_REDEEMED': 'Puntos canjeados',
      'TIER_CHANGED': 'Cambio de nivel',
      'VISIT_RECORDED': 'Visita registrada',
    };
    // An event this page does not know yet is still activity; its code is not
    // something to show a merchant.
    return labels[item.eventType] ?? 'Actividad';
  }

  function timelineColor(type: string): string {
    if (type === 'points.earned') return 'var(--success)';
    if (type === 'points.redeemed') return 'var(--error)';
    if (type === 'visit') return '#2563eb';
    if (type === 'customer.registered') return '#7c3aed';
    return 'var(--text-muted)';
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
              <Cake size={16} aria-hidden="true" /> {formatBirthDate(customer.birthDate)}
            </p>
          )}
          <p className="customer-hero-since">
            Cliente desde {formatCalendarDate(customer.createdAt)}
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

        <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem', alignSelf: 'flex-start' }}>
          <button className="btn btn-secondary" onClick={handleOpenEditor}>
            Editar datos
          </button>
          <button className="btn btn-primary" onClick={handleOpenModal}>
            Registrar Venta
          </button>
        </div>
      </div>

      {/* ---------- Edit form ---------- */}
      {/*
        On this page and not inline in the customers table, because that table
        re-fetches on every keystroke of its search box (`customers/page.tsx`
        runs the effect on `[search]`). An inline editor there is rewritten by a
        refetch that cannot tell "the operator is typing in this cell" from "the
        operator is filtering", and the fix for that would be to stop the search
        being live — a product change nobody asked for. This page loads one
        customer and refreshes only on an explicit action.
      */}
      {editing && draft && (
        <div className="card" style={{ marginTop: '1.5rem' }}>
          <h2 className="card-title">Editar datos del cliente</h2>

          <p className="text-sm text-muted" style={{ marginBottom: '1rem' }}>
            Sólo se pueden cambiar el nombre, el teléfono, el correo y la fecha de nacimiento.
            El resto de los datos los calcula el sistema.
          </p>

          {hasUnsavedChanges && (
            <p className="text-sm" style={{ color: '#b45309', marginBottom: '1rem' }}>
              Cambios sin guardar
            </p>
          )}

          {saveError?.field === null && (
            <p style={{ color: 'var(--error)', fontSize: '0.875rem', marginBottom: '1rem' }}>
              {saveError.message}
            </p>
          )}

          <div className="form-group">
            {EDITABLE_FIELDS.map((field) => (
              // The wrapper carries `data-field` so a refusal can be rendered
              // beside the input it is about: "the email is taken" next to the
              // phone box sends the operator to change the wrong thing.
              <div key={field.key} data-field={field.key} style={{ marginBottom: '1rem' }}>
                <label htmlFor={`edit-${field.key}`}>{field.label}</label>
                <input
                  id={`edit-${field.key}`}
                  type={field.type}
                  className="form-control"
                  autoComplete={field.autoComplete}
                  value={draft[field.key]}
                  disabled={saving}
                  onChange={(e) =>
                    setDraft({ ...draft, [field.key]: e.currentTarget.value })
                  }
                />
                {saveError?.field === field.key && (
                  <p style={{ color: 'var(--error)', fontSize: '0.875rem', marginTop: '0.25rem' }}>
                    {saveError.message}
                  </p>
                )}
              </div>
            ))}
          </div>

          {/* Read-only, and deliberately not inputs. */}
          <dl className="text-sm text-muted" style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '0.35rem 1rem', marginBottom: '1.25rem' }}>
            <dt>ID de cliente</dt>
            <dd style={{ margin: 0, fontFamily: 'monospace' }}>{customer.id}</dd>
            <dt>Nivel</dt>
            <dd style={{ margin: 0 }}>{tierName}</dd>
            <dt>Puntos</dt>
            <dd style={{ margin: 0 }}>{customer.points.toLocaleString()}</dd>
            <dt>Miembro desde</dt>
            <dd style={{ margin: 0 }}>{formatCalendarDate(customer.createdAt)}</dd>
          </dl>

          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button className="btn btn-secondary" onClick={handleCancelEdit} disabled={saving}>
              Cancelar
            </button>
            <button className="btn btn-primary" onClick={handleSaveEdit} disabled={saving}>
              {saving ? 'Guardando…' : 'Guardar'}
            </button>
          </div>
        </div>
      )}

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
                        style={{ color: isRedeem ? color : 'var(--success)' }}
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
                <label htmlFor="sale-amount">{saleAmountLabel}</label>
                <input
                  id="sale-amount"
                  type="number"
                  min="1"
                  step={saleAmountStep}
                  className="form-control"
                  placeholder={saleAmountPlaceholder}
                  value={amount || ''}
                  onChange={(e) => setAmount(Number(e.target.value))}
                />
              </div>

              {amount > 0 && (
                <div className="points-preview" style={{ background: 'var(--bg-subtle)', padding: '0.75rem', borderRadius: '6px', marginBottom: '1rem' }}>
                  <p className="text-sm text-muted" style={{ marginBottom: '0.5rem' }}>
                    Desglose de puntos (estimado)
                  </p>
                  {/* Every factor the total multiplies is displayed, and no factor
                      is displayed that it does not. This breakdown used to
                      multiply by `earnRate` while printing only the base and the
                      multiplier, so the equation on screen was false for every
                      program whose rate was not 1 — and exactly true, and so
                      invisible, for the default one.

                      The base is `earn.base`, not the typed amount: under `visit`
                      it is a count of visits and under `purchase` it is the money
                      over the tenant's unit. Printing the raw amount would show an
                      equation for a number this modal does not send — and would
                      call a visit count "pts". The total is `earn.preview`, the same
                      derivation the charge uses, rather than a second floor here. */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.875rem' }}>
                    <span>Base: {earn.base} {baseUnitLabel}</span>
                    <span>&times; Tasa ({earnRate}x)</span>
                    <span>&times; Multiplicador ({tierMultiplier}x)</span>
                    <span><strong>= {earn.preview} pts</strong></span>
                  </div>
                  <p className="text-sm text-muted" style={{ margin: '0.5rem 0 0' }}>
                    El cobro real lo calcula el servidor, que resuelve el nivel en el momento del
                    cobro.
                  </p>
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
                <p style={{ color: 'var(--error)', fontSize: '0.875rem', marginTop: '0.5rem' }}>{modalError}</p>
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
