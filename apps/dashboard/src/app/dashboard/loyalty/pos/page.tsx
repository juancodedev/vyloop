'use client';

import { Html5Qrcode } from 'html5-qrcode';
import { Camera, ScanLine } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';

import styles from './pos.module.css';

import { ApiError, api } from '@/lib/api';
import {
  classifyCameraError,
  presentCameraFailure,
  requestCameraAccess,
  type CameraFailure,
} from '@/lib/camera-permission';
import { resolveLookupTarget } from '@/lib/lookup-identifier';
import { DEFAULT_EARN_RULE, describeEarnRule, type EarnRule } from '@/lib/loyalty-earn-rule';
import { resolveEarn, VISITS_PER_CHARGE } from '@/lib/loyalty-points';
import { parsePassCode } from '@/lib/pass-code';
import { presentPass, type WirePassState } from '@/lib/pass-state';

// ─── Types ──────────────────────────────────────────────────────────

type Status = 'idle' | 'identifying' | 'charging' | 'done' | 'error';

/**
 * Why a lookup failed, as far as the counter is concerned.
 *
 * Kept apart from `errorMsg` because the three need different things from the
 * cashier: a miss is an invitation to register, a duplicate is an escalation,
 * and anything else is a broken system that must not be answered with a form.
 */
type LookupFailure = 'not_registered' | 'ambiguous' | 'system';

// ─── Money ──────────────────────────────────────────────────────────

/** Whole pesos, the way a Chilean receipt prints them: `$4.500`. */
function clp(amount: number): string {
  return `$${Math.round(amount).toLocaleString('es-CL')}`;
}

/**
 * The amount the cashier typed, in whole pesos.
 *
 * Only the digits count, so "4.500", "4500" and "$4.500" are the same sale. A
 * peso has no cents, which is why a comma is not read as a decimal separator.
 */
function parseClp(typed: string): number {
  const digits = typed.replace(/\D/g, '');
  return digits === '' ? 0 : Number(digits);
}

// ─── Component ──────────────────────────────────────────────────────

export default function PosPage() {
  // The receipt amount, as typed. Parsed on every render by `parseClp`.
  const [amountInput, setAmountInput] = useState('');

  // Customer
  const [customer, setCustomer] = useState<{
    id: string;
    globalId: string;
    fullName: string;
    points: number;
    currentTier: string | null;
    multiplier: number;
    /**
     * The pass state, when the customer was identified through the search box.
     *
     * Null for a QR scan: `GET /v1/customers/by-global-id` does not report pass
     * state, so there is nothing to show and nothing to guess. Rendering a badge
     * we did not earn is how a screen starts lying.
     */
    pass: { state: WirePassState; lastSyncedAt: string | null } | null;
  } | null>(null);

  // Search box
  const [lookupInput, setLookupInput] = useState('');
  const [lookupFailure, setLookupFailure] = useState<LookupFailure | null>(null);

  // Redeem
  const [redeemInput, setRedeemInput] = useState('');
  const [redeemResult, setRedeemResult] = useState<{
    used: number;
    discount: number;
  } | null>(null);

  // Status
  const [status, setStatus] = useState<Status>('idle');
  const [errorMsg, setErrorMsg] = useState('');

  // Scanner modal
  const [showScanner, setShowScanner] = useState(false);
  /**
   * Why the camera is unusable, or `null` while it is working.
   *
   * Kept beside `showScanner` rather than inside `errorMsg` because it must NOT
   * close the modal: the previous handler set an error and unmounted the reader
   * in the same breath, so the one message that could have explained the failure
   * appeared on a screen the failure had already been dismissed from.
   */
  const [cameraFailure, setCameraFailure] = useState<CameraFailure | null>(null);
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const scannerContainerId = 'qr-reader';

  // Receipt
  const [receipt, setReceipt] = useState<{
    subtotal: number;
    pointsEarned: number;
    pointsRedeemed: number;
    discount: number;
    total: number;
    customerName: string;
  } | null>(null);

  // ─── Fetch the accumulation program on mount ───────────────────────

  // The whole rule, not just the rate: which body field the worker reads — a
  // qualifying count or a money amount — is a property of the tenant's program,
  // and this page used to assume it was always a count. It defaults to `visit`,
  // which is the mechanic that has been live since before `earn_by` existed, so a
  // failed load leaves every existing tenant behaving exactly as it did.
  const [earnRule, setEarnRule] = useState<EarnRule>(DEFAULT_EARN_RULE);

  useEffect(() => {
    api
      .getLoyaltyConfig()
      .then((c) =>
        setEarnRule({
          earnBy: c.earnBy,
          earnRate: c.earnRate,
          earnUnitAmount: c.earnUnitAmount,
        }),
      )
      .catch(() => setEarnRule(DEFAULT_EARN_RULE));
  }, []);

  // ─── Sale helpers ─────────────────────────────────────────────────

  const resetSale = useCallback(() => {
    setAmountInput('');
    setCustomer(null);
    setRedeemInput('');
    setRedeemResult(null);
    setStatus('idle');
    setErrorMsg('');
    setReceipt(null);
  }, []);

  const subtotal = parseClp(amountInput);

  // ─── Points calculation ───────────────────────────────────────────

  // ONE decision, resolved once per render, for all three things the page needs:
  // which field this sale has to travel in, what to put in it, and what to show for
  // it. They used to be two separate ones — `previewPoints(subtotal, …)` for the
  // screen and a hard `points: subtotal` for the request — and that is how pesos
  // ended up being displayed as a visit count, why a `purchase` program refused the
  // body as `AMOUNT_REQUIRED`, and why fractional prices failed the worker's
  // integer guard on the way out.
  //
  // The two facts go in separately and the mechanic picks the one it pays on: money
  // for `purchase`, a count for `visit`. Neither number is sent — the worker applies
  // the rate and the tier itself, and does the division by the unit.
  const earn = resolveEarn(
    earnRule,
    { pesos: subtotal, visits: VISITS_PER_CHARGE },
    customer?.multiplier ?? 1,
  );
  const pointsToEarn = earn.preview;
  // The rule that produced it, in the mechanic's own terms. Shared with the config
  // screen, so a purchase program says what it pays per $X of purchase and a visit
  // program says nothing about money at all — it has no money rule.
  const earnRuleText = describeEarnRule(earnRule);
  // The most that can be redeemed: no more than the customer holds, nor more than
  // the sale is worth (1 point = $1).
  const maxRedeem = customer ? Math.min(customer.points, Math.ceil(subtotal)) : 0;
  const redeemValue = Math.min(Number(redeemInput) || 0, maxRedeem);
  const discount = redeemResult?.discount ?? 0;
  const total = Math.max(0, subtotal - discount);

  // ─── Search box ───────────────────────────────────────────────────

  const handleLookup = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();

      // One box, three identifiers. The resolver returns the pair together so the
      // value cannot be sent under the wrong parameter.
      const target = resolveLookupTarget(lookupInput);
      if (!target) return;

      setStatus('identifying');
      setErrorMsg('');
      setLookupFailure(null);

      try {
        const found = await api.lookupCustomer({ [target.identifier]: target.value });

        setCustomer({
          id: found.id,
          globalId: found.globalId,
          fullName: found.fullName,
          points: found.points,
          currentTier: found.currentTier,
          multiplier: found.tier?.multiplier ?? 1,
          pass: { state: found.pass.state, lastSyncedAt: found.pass.lastSyncedAt },
        });
        setRedeemInput('');
        setRedeemResult(null);
        setStatus('idle');
      } catch (err) {
        setStatus('idle');

        // The three outcomes are told apart on the server's code, not on the
        // message. "Not registered" invites a registration; a duplicate has to be
        // escalated; anything else is a broken system, and answering that with a
        // registration form would send a real customer into the wrong screen.
        if (err instanceof ApiError && err.code === 'CUSTOMER_NOT_REGISTERED') {
          setLookupFailure('not_registered');
        } else if (err instanceof ApiError && err.status === 409) {
          setLookupFailure('ambiguous');
        } else {
          setLookupFailure('system');
          setErrorMsg(err instanceof Error ? err.message : 'No se pudo consultar el cliente');
        }
      }
    },
    [lookupInput],
  );

  // ─── QR Scanner ───────────────────────────────────────────────────

  const startScanner = useCallback(async () => {
    setShowScanner(true);
    setCameraFailure(null);
    // Small delay so the DOM element is rendered
    await new Promise((r) => setTimeout(r, 200));

    // Ask for the camera BEFORE building the scanner, because this is the call
    // that puts the browser's permission dialog in front of the cashier while
    // they are still looking at the button they pressed. `html5-qrcode` opens a
    // stream of its own, but only once its loop is running, so it produced a
    // modal with no video and no prompt -- the button looked dead.
    //
    // This runs inside the click handler, and it has to: a camera request
    // outside a user gesture is refused outright, which is why an earlier
    // attempt at this from an effect "did nothing" instead of erroring.
    try {
      await requestCameraAccess();
    } catch (err) {
      // The modal stays open and the reason stays on screen. Refusal, absent
      // hardware and a camera another app is holding are three different
      // problems, and the cashier is the only one who can act on which one it
      // is -- so the handler reports and waits rather than closing.
      setCameraFailure(classifyCameraError(err));
      return;
    }

    try {
      const scanner = new Html5Qrcode(scannerContainerId);
      scannerRef.current = scanner;

      await scanner.start(
        { facingMode: 'environment' },
        { fps: 10, qrbox: { width: 250, height: 250 } },
        async (decodedText) => {
          // Stop scanner
          await scanner.stop().catch(() => {});
          setShowScanner(false);

          // Which customer this code is for, decided in `lib/pass-code.ts`.
          // Three formats are live -- the `/c/<id>` link printed on cards that
          // already exist, the Google Wallet `<issuerId>.member-<id>` barcode,
          // and a bare id -- and anything else is reported rather than guessed.
          const parsed = parsePassCode(decodedText);
          if (!parsed.ok) {
            setErrorMsg('No se pudo leer el código QR');
            return;
          }

          setStatus('identifying');
          setErrorMsg('');

          try {
            const data = await api.getCustomerByGlobalId(parsed.globalId);
            setCustomer({
              id: data.id,
              globalId: data.globalId,
              fullName: data.fullName,
              points: data.points,
              currentTier: data.currentTier,
              multiplier: data.tier?.multiplier ?? 1,
              // The QR endpoint does not report pass state. Left null rather than
              // guessed, so no badge appears for something nobody asked Google.
              pass: null,
            });
            setRedeemInput('');
            setRedeemResult(null);
            setStatus('idle');
          } catch {
            setErrorMsg('Cliente no encontrado');
            setStatus('idle');
          }
        },
        () => {},
      );
    } catch (err) {
      // Same rule as above: the reader is not unmounted on the way out, because
      // the reader is where the explanation belongs.
      setCameraFailure(classifyCameraError(err));
    }
  }, []);

  const stopScanner = useCallback(async () => {
    if (scannerRef.current) {
      try {
        await scannerRef.current.stop();
      } catch {
        /* ignore */
      }
      scannerRef.current = null;
    }
    setCameraFailure(null);
    setShowScanner(false);
  }, []);

  // Cleanup scanner on unmount
  useEffect(() => {
    return () => {
      if (scannerRef.current) {
        scannerRef.current.stop().catch(() => {});
      }
    };
  }, []);

  // ─── Redeem points ────────────────────────────────────────────────

  const handleRedeem = useCallback(async () => {
    // redeemValue is already capped at maxRedeem (≤ the sale, ≤ the balance).
    const value = Math.floor(redeemValue);
    if (!customer || value <= 0) return;
    setErrorMsg('');

    try {
      const result = await api.redeemPoints(customer.id, value, 'Descuento POS');
      setRedeemResult({ used: Math.abs(result.points), discount: Math.abs(result.points) });
      setCustomer((prev) => (prev ? { ...prev, points: result.balance_after } : prev));
      setRedeemInput('');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'No se pudieron canjear los puntos');
    }
  }, [customer, redeemValue]);

  // ─── Charge ───────────────────────────────────────────────────────

  const handleCharge = useCallback(async () => {
    if (subtotal <= 0) return;
    if (!customer) {
      setErrorMsg('Identifica al cliente antes de registrar la venta');
      return;
    }

    setStatus('charging');
    setErrorMsg('');

    try {
      const note = `Venta en caja: ${clp(subtotal)}`;

      // 1. Accumulate. Which field the sale travels in, and what value travels in it,
      // are the PROGRAM's facts — so both come from `earn` above, resolved once from
      // the config rather than guessed here: a `purchase` program refuses a
      // caller-supplied count with `AMOUNT_REQUIRED`, and a `visit` program refuses
      // a money amount with `VISIT_COUNT_REQUIRED`.
      //
      // Two values in two units, and the units are the whole point: `purchase` gets
      // the raw money — the division by the tenant's unit is the worker's to do — and
      // `visit` gets the visit count, never the peso subtotal. A money amount sent as
      // a count fails the worker's integer guard on every fractional amount. The
      // estimate is not sent either; see `earn`.
      const earned =
        earn.inputField === 'amount_pesos'
          ? await api.assignPurchasePoints(customer.id, subtotal, note)
          : await api.assignPoints(customer.id, earn.base, note);

      const receiptData = {
        subtotal,
        pointsEarned: earned.points,
        pointsRedeemed: redeemResult?.used ?? 0,
        discount,
        total,
        customerName: customer.fullName,
      };

      setReceipt(receiptData);
      setStatus('done');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'No se pudo registrar la venta');
      setStatus('idle');
    }
  }, [customer, earn, redeemResult, discount, total, subtotal]);

  // ─── Render ───────────────────────────────────────────────────────

  // Which camera failure this is, and what to say about it, are one decision
  // made in `lib/camera-permission.ts`. The page only places it.
  const cameraMessage = cameraFailure ? presentCameraFailure(cameraFailure) : null;

  return (
    <div className={styles.container}>
      {errorMsg && (
        <div role="alert" className={styles.errorMsg}>
          {errorMsg}
        </div>
      )}

      {!receipt ? (
        <div className={styles.layout}>
          {/* ─── Who is buying ─── */}
          <section className={styles.card} aria-labelledby="pos-customer">
            <h2 id="pos-customer" className={styles.cardTitle}>
              Cliente
            </h2>

            {!customer ? (
              <>
                <button
                  type="button"
                  className={styles.scanBtn}
                  onClick={startScanner}
                  disabled={status === 'identifying'}
                >
                  {status === 'identifying' ? (
                    <>
                      <span className={styles.spinner} />
                      Identificando…
                    </>
                  ) : (
                    <>
                      <ScanLine size={20} aria-hidden="true" />
                      Escanear tarjeta
                    </>
                  )}
                </button>

                {/* Search too: a customer without the card at hand still has to
                    be found. */}
                <form className={styles.lookupForm} onSubmit={handleLookup}>
                  <input
                    type="text"
                    className={styles.input}
                    placeholder="Teléfono, correo o código del pase"
                    value={lookupInput}
                    onChange={(e) => {
                      setLookupInput(e.currentTarget.value);
                      setLookupFailure(null);
                    }}
                    aria-label="Buscar cliente por teléfono, correo o código del pase"
                    autoComplete="off"
                  />
                  <button
                    type="submit"
                    className={styles.secondaryBtn}
                    disabled={status === 'identifying' || lookupInput.trim() === ''}
                  >
                    Buscar
                  </button>
                </form>

                {lookupFailure === 'not_registered' && (
                  <p className={styles.lookupNote}>
                    No encontramos a ningún cliente con ese dato.{' '}
                    <a href="/dashboard/customers">Regístralo desde Clientes</a>.
                  </p>
                )}

                {lookupFailure === 'ambiguous' && (
                  <p className={styles.lookupWarn}>
                    Hay más de un cliente con ese dato. No es algo que se pueda resolver en caja:
                    anota el caso y escálalo.
                  </p>
                )}
              </>
            ) : (
              <div className={styles.customerInfo}>
                <div className={styles.customerHead}>
                  <span className={styles.customerName}>{customer.fullName}</span>
                  {customer.currentTier && (
                    <span className={styles.customerTier}>{customer.currentTier}</span>
                  )}
                </div>
                <p className={styles.customerPoints}>
                  {customer.points.toLocaleString('es-CL')} puntos
                </p>

                {/* The pass badge, and the sentence under it that says what is
                    actually known. Both come from `lib/pass-state.ts`: the label
                    and the detail are one decision, and a `not_issued` row is
                    rendered as work still to do on our side rather than as a
                    customer who turned out to have no card. */}
                {customer.pass &&
                  (() => {
                    const pass = presentPass(customer.pass.state, customer.pass.lastSyncedAt);
                    return (
                      <div
                        className={styles.passBox}
                        data-tone={pass.tone}
                        data-unverified={pass.unverified}
                      >
                        <div className={styles.passHead}>
                          <span className={styles.passLabel}>{pass.label}</span>
                          {pass.checkedOn && (
                            <span className={styles.passDate}>
                              última comprobación {pass.checkedOn.slice(0, 10)}
                            </span>
                          )}
                        </div>
                        <p className={styles.passDetail}>{pass.detail}</p>
                      </div>
                    );
                  })()}

                <button
                  type="button"
                  className={styles.linkBtn}
                  onClick={() => {
                    setCustomer(null);
                    setRedeemInput('');
                    setRedeemResult(null);
                  }}
                >
                  Cambiar cliente
                </button>
              </div>
            )}
          </section>

          {/* ─── What they bought ─── */}
          <section className={styles.card} aria-labelledby="pos-sale">
            <h2 id="pos-sale" className={styles.cardTitle}>
              Venta
            </h2>

            <label htmlFor="pos-amount" className={styles.amountLabel}>
              Monto de la boleta
            </label>
            <div className={styles.amountField}>
              <span className={styles.amountPrefix} aria-hidden="true">
                $
              </span>
              <input
                id="pos-amount"
                type="text"
                inputMode="numeric"
                className={styles.amountInput}
                placeholder="0"
                value={subtotal > 0 ? subtotal.toLocaleString('es-CL') : ''}
                onChange={(e) => {
                  setAmountInput(e.currentTarget.value);
                  // A redemption was sized against the old amount.
                  setRedeemInput('');
                }}
                autoComplete="off"
              />
            </div>

            {!customer && (
              <p className={styles.hint}>Escanea o busca al cliente para sumar sus puntos.</p>
            )}

            {customer && pointsToEarn > 0 && (
              <div className={styles.earnBox}>
                <div className={styles.earnRow}>
                  <span>Puntos a sumar (estimado)</span>
                  <span className={styles.earnValue}>+{pointsToEarn}</span>
                </div>
                {/* The number above cannot be the charge. The server resolves the
                    tier when it records the sale, and the tier can change between
                    this estimate and the sale, so the receipt shows what the server
                    decided instead. */}
                <p className={styles.earnNote}>
                  Estimado con la tasa y el nivel actuales. El número final lo calcula el servidor
                  al registrar la venta.
                </p>
                {/* Which rule produced it, in the config screen's own wording, so
                    the two screens cannot describe one program two ways. */}
                <p className={styles.earnNote}>{earnRuleText.headline}</p>
              </div>
            )}

            {customer && customer.points > 0 && !redeemResult && subtotal > 0 && (
              <div className={styles.redeemRow}>
                <label htmlFor="pos-redeem" className={styles.redeemLabel}>
                  Canjear puntos como descuento (máx. {maxRedeem.toLocaleString('es-CL')})
                </label>
                <div className={styles.redeemGroup}>
                  <input
                    id="pos-redeem"
                    type="number"
                    className={styles.input}
                    min={0}
                    max={maxRedeem}
                    value={redeemInput}
                    onChange={(e) => setRedeemInput(e.target.value)}
                  />
                  <button
                    type="button"
                    className={styles.secondaryBtn}
                    onClick={handleRedeem}
                    disabled={!redeemInput || Number(redeemInput) <= 0}
                  >
                    Canjear
                  </button>
                </div>
              </div>
            )}

            {redeemResult && (
              <p className={styles.redeemDone}>
                {redeemResult.used.toLocaleString('es-CL')} puntos canjeados:{' '}
                {clp(redeemResult.discount)} de descuento. Total a pagar {clp(total)}.
              </p>
            )}

            {customer && subtotal > 0 && (
              <button
                type="button"
                className={styles.chargeBtn}
                onClick={handleCharge}
                disabled={status === 'charging'}
              >
                {status === 'charging' ? (
                  <>
                    <span className={styles.spinner} />
                    Registrando…
                  </>
                ) : (
                  `Registrar venta de ${clp(subtotal)}`
                )}
              </button>
            )}

            {(subtotal > 0 || customer) && (
              <button type="button" className={styles.linkBtn} onClick={resetSale}>
                Empezar de nuevo
              </button>
            )}
          </section>
        </div>
      ) : (
        /* ─── Receipt ─── */
        <section className={styles.receipt} aria-labelledby="pos-receipt">
          <h2 id="pos-receipt" className={styles.receiptTitle}>
            Venta registrada
          </h2>
          <p className={styles.receiptSub}>{receipt.customerName}</p>

          <dl className={styles.receiptList}>
            <div className={styles.receiptRow}>
              <dt>Monto de la boleta</dt>
              <dd>{clp(receipt.subtotal)}</dd>
            </div>
            {receipt.discount > 0 && (
              <>
                <div className={styles.receiptRow}>
                  <dt>Descuento con puntos</dt>
                  <dd>−{clp(receipt.discount)}</dd>
                </div>
                <div className={`${styles.receiptRow} ${styles.receiptTotal}`}>
                  <dt>Total pagado</dt>
                  <dd>{clp(receipt.total)}</dd>
                </div>
              </>
            )}
          </dl>

          {receipt.pointsEarned > 0 && (
            <p className={styles.receiptPoints}>
              +{receipt.pointsEarned.toLocaleString('es-CL')} puntos
            </p>
          )}
          {receipt.pointsRedeemed > 0 && (
            <p className={styles.receiptRedeem}>
              {receipt.pointsRedeemed.toLocaleString('es-CL')} puntos canjeados
            </p>
          )}

          <button type="button" className={styles.chargeBtn} onClick={resetSale}>
            Nueva venta
          </button>
        </section>
      )}

      {/* ─── QR Scanner Modal ─── */}
      {showScanner && (
        <div className={styles.overlay} onClick={stopScanner}>
          <div
            className={styles.scannerModal}
            role="dialog"
            aria-modal="true"
            aria-labelledby="pos-scanner"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 id="pos-scanner">Escanear tarjeta</h3>

            {/* The failure replaces the reader instead of hiding behind it: a
                black rectangle where the video should be tells the cashier
                nothing, and an error shown outside this modal was the reason the
                previous version looked like it did nothing at all. */}
            {cameraMessage ? (
              <>
                <div role="alert" className={styles.lookupWarn}>
                  <strong>{cameraMessage.title}</strong>
                  <p className={styles.cameraDetail}>{cameraMessage.detail}</p>
                </div>
                <button type="button" className={styles.scanBtn} onClick={startScanner}>
                  <Camera size={20} aria-hidden="true" />
                  Reintentar
                </button>
              </>
            ) : (
              <>
                <p>Pídele al cliente que muestre el QR de su tarjeta.</p>
                <div id={scannerContainerId} className={styles.scannerReader} />
              </>
            )}

            <button type="button" className={styles.secondaryBtn} onClick={stopScanner}>
              Cerrar
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
