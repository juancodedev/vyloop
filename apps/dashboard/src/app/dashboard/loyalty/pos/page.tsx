'use client';

import { Html5Qrcode } from 'html5-qrcode';
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
import { resolveEarn } from '@/lib/loyalty-points';
import { parsePassCode } from '@/lib/pass-code';
import { presentPass, type WirePassState } from '@/lib/pass-state';

// ─── Types ──────────────────────────────────────────────────────────

interface MenuItem {
  id: string;
  name: string;
  price: number;
}

interface CartEntry {
  item: MenuItem;
  qty: number;
}

type Status = 'idle' | 'identifying' | 'charging' | 'done' | 'error';

/**
 * Why a lookup failed, as far as the counter is concerned.
 *
 * Kept apart from `errorMsg` because the three need different things from the
 * cashier: a miss is an invitation to register, a duplicate is an escalation,
 * and anything else is a broken system that must not be answered with a form.
 */
type LookupFailure = 'not_registered' | 'ambiguous' | 'system';

// ─── Menu data (realistic café prices) ──────────────────────────────

const MENU: MenuItem[] = [
  { id: 'latte',      name: 'Café Latte',          price: 3.50 },
  { id: 'cappuccino', name: 'Cappuccino',          price: 3.00 },
  { id: 'espresso',   name: 'Espresso',            price: 2.00 },
  { id: 'mocaccino',  name: 'Mocaccino',           price: 4.00 },
  { id: 'americano',  name: 'Americano',           price: 2.50 },
  { id: 'chai',       name: 'Té Chai Latte',       price: 3.50 },
  { id: 'latte-g',    name: 'Latte Grande',        price: 4.50 },
  { id: 'croissant',  name: 'Croissant',           price: 3.00 },
  { id: 'muffin',     name: 'Muffin Arándanos',    price: 2.50 },
  { id: 'cookie',     name: 'Cookie Chocolate',    price: 1.50 },
  { id: 'sandwich',   name: 'Sandwich Pollo',      price: 5.50 },
  { id: 'tostado',    name: 'Tostado JyQ',         price: 5.00 },
  { id: 'alfajor',    name: 'Alfajor',             price: 1.50 },
  { id: 'medialuna',  name: 'Medialuna',           price: 1.00 },
  { id: 'jugo',       name: 'Jugo Naranja',        price: 3.00 },
  { id: 'agua',       name: 'Agua Mineral',        price: 1.50 },
];

// ─── Component ──────────────────────────────────────────────────────

export default function PosPage() {
  // Cart
  const [cart, setCart] = useState<CartEntry[]>([]);

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
    items: CartEntry[];
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
    api.getLoyaltyConfig()
      .then((c) =>
        setEarnRule({
          earnBy: c.earnBy,
          earnRate: c.earnRate,
          earnUnitAmount: c.earnUnitAmount,
        }),
      )
      .catch(() => setEarnRule(DEFAULT_EARN_RULE));
  }, []);

  // ─── Cart helpers ─────────────────────────────────────────────────

  const addToCart = useCallback((item: MenuItem) => {
    setCart((prev) => {
      const existing = prev.find((e) => e.item.id === item.id);
      if (existing) {
        return prev.map((e) =>
          e.item.id === item.id ? { ...e, qty: e.qty + 1 } : e,
        );
      }
      return [...prev, { item, qty: 1 }];
    });
  }, []);

  const updateQty = useCallback((itemId: string, delta: number) => {
    setCart((prev) =>
      prev
        .map((e) =>
          e.item.id === itemId ? { ...e, qty: Math.max(0, e.qty + delta) } : e,
        )
        .filter((e) => e.qty > 0),
    );
  }, []);

  const clearCart = useCallback(() => {
    setCart([]);
    setCustomer(null);
    setRedeemInput('');
    setRedeemResult(null);
    setStatus('idle');
    setErrorMsg('');
    setReceipt(null);
  }, []);

  const subtotal = cart.reduce((sum, e) => sum + e.item.price * e.qty, 0);

  // ─── Points calculation ───────────────────────────────────────────

  // ONE decision, resolved once per render, for both things the page needs:
  // which field this sale has to travel in, and what to show for it. They used to
  // be two separate ones — `previewPoints(subtotal, …)` for the screen and a hard
  // `points: subtotal` for the request — and that is how pesos ended up being
  // displayed as a visit count while a `purchase` program refused the body as
  // `AMOUNT_REQUIRED`. Neither number is sent: the worker derives the base from the
  // field the program actually reads, and applies the rate and the tier itself.
  const earn = resolveEarn(earnRule, subtotal, customer?.multiplier ?? 1);
  const pointsToEarn = earn.preview;
  // The rule that produced it, in the mechanic's own terms. Shared with the config
  // screen, so a purchase program says what it pays per $X of purchase and a visit
  // program says nothing about money at all — it has no money rule.
  const earnRuleText = describeEarnRule(earnRule);
  // Canje máximo: no más de lo que tiene el cliente, ni más que el subtotal (1 pt = $1)
  const maxRedeem = customer ? Math.min(customer.points, Math.ceil(subtotal)) : 0;
  const redeemValue = Math.min(Number(redeemInput) || 0, maxRedeem);
  const discount = redeemResult?.discount ?? 0;
  const total = Math.max(0, subtotal - discount);

  // ─── Search box ───────────────────────────────────────────────────

  const handleLookup = useCallback(async (event: FormEvent<HTMLFormElement>) => {
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
        setErrorMsg(
          err instanceof Error ? err.message : 'No se pudo consultar el cliente',
        );
      }
    }
  }, [lookupInput]);

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
      try { await scannerRef.current.stop(); } catch { /* ignore */ }
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
    // redeemValue ya está capoteado a maxRedeem (≤ subtotal, ≤ customer.points)
    const value = Math.floor(redeemValue);
    if (!customer || value <= 0) return;
    setErrorMsg('');

    try {
      const result = await api.redeemPoints(customer.id, value, 'Descuento POS');
      setRedeemResult({ used: Math.abs(result.points), discount: Math.abs(result.points) });
      setCustomer((prev) => prev ? { ...prev, points: result.balance_after } : prev);
      setRedeemInput('');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Error al canjear puntos');
    }
  }, [customer, redeemValue]);

  // ─── Charge ───────────────────────────────────────────────────────

  const handleCharge = useCallback(async () => {
    if (cart.length === 0) return;
    if (!customer) {
      setErrorMsg('Identificá al cliente antes de cobrar');
      return;
    }

    setStatus('charging');
    setErrorMsg('');

    try {
      const note = `Venta POS: ${cart.map((e) => `${e.item.name} x${e.qty}`).join(', ')}`;

      // 1. Accumulate. Which field the sale travels in is the PROGRAM's fact, so it
      // is read from the config rather than guessed here: a `purchase` program
      // refuses a caller-supplied count with `AMOUNT_REQUIRED`, and a `visit`
      // program refuses a money amount with `VISIT_COUNT_REQUIRED`. Either way the
      // value is the same raw subtotal — what the sale is worth is the cashier's
      // business, which field it is filed under is the merchant's. The estimate
      // above is never sent: see `earn`.
      const earned =
        earn.inputField === 'amount_pesos'
          ? await api.assignPurchasePoints(customer.id, subtotal, note)
          : await api.assignPoints(customer.id, subtotal, note);

      const receiptData = {
        items: [...cart],
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
      setErrorMsg(err instanceof Error ? err.message : 'Error al procesar el cobro');
      setStatus('idle');
    }
  }, [cart, customer, earn, redeemResult, discount, total, subtotal]);

  // ─── New sale after receipt ───────────────────────────────────────

  const handleNewSale = useCallback(() => {
    setCart([]);
    setCustomer(null);
    setRedeemInput('');
    setRedeemResult(null);
    setStatus('idle');
    setErrorMsg('');
    setReceipt(null);
  }, []);

  // ─── Render ───────────────────────────────────────────────────────

  // Which camera failure this is, and what to say about it, are one decision
  // made in `lib/camera-permission.ts`. The page only places it.
  const cameraMessage = cameraFailure ? presentCameraFailure(cameraFailure) : null;

  return (
    <div className={styles.container}>
      {/* Header */}
      <div className={styles.header}>
        <h1>POS</h1>
        <span className={styles.headerBadge}>Emulado</span>
      </div>

      {/* Error */}
      {errorMsg && (
        <div className={styles.errorMsg} style={{ marginBottom: 16, textAlign: 'center' }}>
          {errorMsg}
        </div>
      )}

      {!receipt ? (
        <div className={styles.layout}>
          {/* ─── Menu ─── */}
          <div className={styles.menuSection}>
            <h2>Menú</h2>
            <div className={styles.menuGrid}>
              {MENU.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={styles.menuItem}
                  onClick={() => addToCart(item)}
                >
                  <div className={styles.menuItemName}>{item.name}</div>
                  <div className={styles.menuItemPrice}>${item.price.toFixed(2)}</div>
                </button>
              ))}
            </div>
          </div>

          {/* ─── Cart ─── */}
          <div className={styles.cartCard}>
            <div className={styles.cartHeader}>
              Carrito ({cart.reduce((s, e) => s + e.qty, 0)} items)
            </div>

            {cart.length === 0 ? (
              <div className={styles.cartEmpty}>
                Seleccioná productos del menú
              </div>
            ) : (
              <>
                <div className={styles.cartList}>
                  {cart.map((entry) => (
                    <div key={entry.item.id} className={styles.cartItem}>
                      <div className={styles.cartItemInfo}>
                        <div className={styles.cartItemName}>{entry.item.name}</div>
                      </div>
                      <div className={styles.cartItemQty}>
                        <button
                          type="button"
                          className={styles.qtyBtn}
                          onClick={() => updateQty(entry.item.id, -1)}
                        >
                          −
                        </button>
                        <span className={styles.qtyValue}>{entry.qty}</span>
                        <button
                          type="button"
                          className={styles.qtyBtn}
                          onClick={() => updateQty(entry.item.id, 1)}
                        >
                          +
                        </button>
                      </div>
                      <span className={styles.cartItemTotal}>
                        ${(entry.item.price * entry.qty).toFixed(2)}
                      </span>
                    </div>
                  ))}
                </div>

                <div className={styles.cartSummary}>
                  <div className={styles.cartTotal}>
                    <span>Total</span>
                    <span>${subtotal.toFixed(2)}</span>
                  </div>
                  {discount > 0 && (
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--text-sm)', color: 'var(--error)' }}>
                      <span>Descuento</span>
                      <span>−${discount.toFixed(2)}</span>
                    </div>
                  )}
                </div>
              </>
            )}

            {/* ─── Customer section ─── */}
            <div className={styles.customerSection}>
              {!customer ? (
                <>
                  {/* Search first: a cashier without the QR in front of them
                      still has to identify the person. */}
                  <form className={styles.lookupForm} onSubmit={handleLookup}>
                    <input
                      type="text"
                      className={styles.lookupInput}
                      placeholder="Teléfono, correo o código del pase…"
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
                      className={styles.lookupBtn}
                      disabled={status === 'identifying' || lookupInput.trim() === ''}
                    >
                      Buscar
                    </button>
                  </form>

                  {lookupFailure === 'not_registered' && (
                    <p className={styles.lookupNote}>
                      No encontramos a ningún cliente con ese dato.{' '}
                      <a href="/dashboard/customers">Registralo desde Clientes</a>.
                    </p>
                  )}

                  {lookupFailure === 'ambiguous' && (
                    <p className={styles.lookupWarn}>
                      Hay más de un cliente con ese dato. No es algo que se pueda
                      resolver en el mostrador: anotá el caso y escalalo.
                    </p>
                  )}

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
                        📷 Escanear QR
                      </>
                    )}
                  </button>
                </>
              ) : (
                <div className={styles.customerInfo}>
                  <div className={styles.customerRow}>
                    <span className={styles.customerLabel}>Cliente</span>
                    <span className={styles.customerValue}>{customer.fullName}</span>
                  </div>
                  <div className={styles.customerRow}>
                    <span className={styles.customerLabel}>Puntos</span>
                    <span className={styles.customerValue}>
                      {customer.points.toLocaleString()}
                      {' '}
                      {customer.currentTier && (
                        <span className={styles.customerTier}>{customer.currentTier}</span>
                      )}
                    </span>
                  </div>

                  {/* The pass badge, and the sentence under it that says what is
                      actually known. Both come from `lib/pass-state.ts`: the label
                      and the detail are one decision, and a `not_issued` row is
                      rendered as work still to do on our side rather than as a
                      customer who turned out to have no card. */}
                  {customer.pass && (() => {
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

                  {pointsToEarn > 0 && (
                    <>
                      <div className={styles.earnRow}>
                        <span>Puntos a ganar (estimado)</span>
                        <span>+{pointsToEarn}</span>
                      </div>
                      {/* The number above cannot be the charge. The server resolves
                          the tier when it charges, and the tier can change between
                          this estimate and the sale, so the receipt shows what the
                          server decided instead. An estimate dressed as a final
                          figure is worse than showing none. */}
                      <p className={styles.earnNote}>
                        Estimado con la tasa y el nivel actuales. El cobro real lo calcula el
                        servidor, que resuelve el nivel en el momento del cobro.
                      </p>
                      {/* Which rule produced it. Without this the estimate is a number
                          the cashier can only take on faith; with it, and only for a
                          `purchase` program, it is checkable against the cart's own
                          total. The wording is the config screen's, so the two cannot
                          describe one program two different ways. */}
                      <p className={styles.earnNote}>{earnRuleText.headline}</p>
                    </>
                  )}

                  {customer.points > 0 && !redeemResult && subtotal > 0 && (
                    <div className={styles.redeemRow}>
                      <div className={styles.redeemInputGroup}>
                        <input
                          type="number"
                          className={styles.redeemInput}
                          placeholder={`Máx ${Math.min(customer.points, Math.ceil(subtotal))} pts`}
                          min={0}
                          max={Math.min(customer.points, Math.ceil(subtotal))}
                          value={redeemInput}
                          onChange={(e) => setRedeemInput(e.target.value)}
                        />
                        <button
                          type="button"
                          className={styles.redeemBtn}
                          onClick={handleRedeem}
                          disabled={!redeemInput || Number(redeemInput) <= 0}
                        >
                          Canjear
                        </button>
                      </div>
                      <span className={styles.redeemResult}>
                        Disponibles: {customer.points.toLocaleString()}
                      </span>
                    </div>
                  )}

                  {redeemResult && (
                    <div className={styles.redeemRow}>
                      <span className={styles.redeemResult} style={{ color: 'var(--error)' }}>
                        ✓ {redeemResult.used.toLocaleString()} pts canjeados — ${redeemResult.discount.toFixed(2)} de descuento
                      </span>
                    </div>
                  )}

                  {cart.length > 0 && (
                    <button
                      type="button"
                      className={styles.chargeBtn}
                      onClick={handleCharge}
                      disabled={status === 'charging'}
                      style={{ marginTop: 10 }}
                    >
                      {status === 'charging' ? (
                        <>
                          <span className={styles.spinner} />
                          Procesando…
                        </>
                      ) : (
                        `Cobrar $${total.toFixed(2)}`
                      )}
                    </button>
                  )}

                  <div style={{ display: 'flex', justifyContent: 'center', marginTop: 8 }}>
                    <button
                      type="button"
                      className={styles.clearBtn}
                      onClick={() => setCustomer(null)}
                    >
                      Cambiar cliente
                    </button>
                  </div>
                </div>
              )}

              {cart.length > 0 && (
                <div style={{ display: 'flex', justifyContent: 'center', marginTop: 8 }}>
                  <button type="button" className={styles.clearBtn} onClick={clearCart}>
                    Vaciar carrito
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      ) : (
        /* ─── Receipt ─── */
        <div className={styles.receipt} style={{ margin: '0 auto' }}>
          <div className={styles.receiptIcon}>🧾</div>
          <h2>Venta completada</h2>
          <p className={styles.receiptSub}>Cliente: {receipt.customerName}</p>

          {receipt.items.map((entry) => (
            <div key={entry.item.id} className={styles.receiptDetail}>
              <span>{entry.item.name} x{entry.qty}</span>
              <span>${(entry.item.price * entry.qty).toFixed(2)}</span>
            </div>
          ))}

          <div className={styles.receiptTotal}>
            <span>Total</span>
            <span>${receipt.total.toFixed(2)}</span>
          </div>

          {receipt.pointsEarned > 0 && (
            <div className={styles.receiptPoints}>
              +{receipt.pointsEarned.toLocaleString()} puntos acumulados
            </div>
          )}
          {receipt.pointsRedeemed > 0 && (
            <div className={styles.receiptRedeem}>
              −{receipt.pointsRedeemed.toLocaleString()} puntos canjeados (${receipt.discount.toFixed(2)})
            </div>
          )}

          <div className={styles.receiptActions}>
            <button
              type="button"
              className={`${styles.receiptBtn} ${styles.receiptBtnPrimary}`}
              onClick={handleNewSale}
            >
              Nueva venta
            </button>
            <button
              type="button"
              className={`${styles.receiptBtn} ${styles.receiptBtnSecondary}`}
              onClick={() => setReceipt(null)}
            >
              Ver detalle
            </button>
          </div>
        </div>
      )}

      {/* ─── QR Scanner Modal ─── */}
      {showScanner && (
        <div className={styles.overlay} onClick={stopScanner}>
          <div className={styles.scannerModal} onClick={(e) => e.stopPropagation()}>
            <h3>Escanear QR</h3>

            {/* The failure replaces the reader instead of hiding behind it: a
                black rectangle where the video should be tells the cashier
                nothing, and an error shown outside this modal was the reason the
                previous version looked like it did nothing at all. */}
            {cameraMessage ? (
              <>
                <div role="alert" className={styles.lookupWarn}>
                  <strong>{cameraMessage.title}</strong>
                  <p style={{ margin: '6px 0 0' }}>{cameraMessage.detail}</p>
                </div>
                <button
                  type="button"
                  className={styles.scanBtn}
                  onClick={startScanner}
                  style={{ marginTop: 12 }}
                >
                  Reintentar
                </button>
              </>
            ) : (
              <>
                <p>Mostrale el código QR al cliente para identificarlo</p>
                <div id={scannerContainerId} className={styles.scannerReader} />
              </>
            )}

            <button type="button" className={styles.closeBtn} onClick={stopScanner}>
              Cerrar
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
