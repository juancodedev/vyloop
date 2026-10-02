'use client';

import { Html5Qrcode } from 'html5-qrcode';
import { useCallback, useEffect, useRef, useState } from 'react';

import styles from './pos.module.css';

import { api } from '@/lib/api';
import { previewPoints } from '@/lib/loyalty-points';

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

  // Earn rate (fetched)
  const [earnRate, setEarnRate] = useState(1);

  // Customer
  const [customer, setCustomer] = useState<{
    id: string;
    globalId: string;
    fullName: string;
    points: number;
    currentTier: string | null;
    multiplier: number;
  } | null>(null);

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

  // ─── Fetch earn rate on mount ─────────────────────────────────────

  useEffect(() => {
    api.getLoyaltyConfig()
      .then((c) => setEarnRate(c.earnRate))
      .catch(() => setEarnRate(1));
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

  // An ESTIMATE, shown to the cashier before the charge.
  //
  // `pointsToEarn` is never sent to the server. `POST /v1/loyalty/points/assign`
  // takes the base amount and applies `earnRate × tierMultiplier` itself, so
  // sending this number would apply the tier a second time: a Gold customer
  // (`×2`) would be credited `subtotal × earnRate × 2 × 2`. Because that number
  // is what lands in `points_transactions.points`, with `balance_after`
  // accumulated from it, the inflated balance would be permanent.
  const pointsToEarn = previewPoints(subtotal, earnRate, customer?.multiplier ?? 1);
  // Canje máximo: no más de lo que tiene el cliente, ni más que el subtotal (1 pt = $1)
  const maxRedeem = customer ? Math.min(customer.points, Math.ceil(subtotal)) : 0;
  const redeemValue = Math.min(Number(redeemInput) || 0, maxRedeem);
  const discount = redeemResult?.discount ?? 0;
  const total = Math.max(0, subtotal - discount);

  // ─── QR Scanner ───────────────────────────────────────────────────

  const startScanner = useCallback(async () => {
    setShowScanner(true);
    // Small delay so the DOM element is rendered
    await new Promise((r) => setTimeout(r, 200));

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

          // Extract globalId from URL like /c/<uuid> or just plain uuid
          const match = decodedText.match(/\/c\/([a-f0-9-]+)/i) || decodedText.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);
          const globalId = match ? match[1] : decodedText.trim();

          if (!globalId || globalId.length < 10) {
            setErrorMsg('No se pudo leer el código QR');
            return;
          }

          setStatus('identifying');
          setErrorMsg('');

          try {
            const data = await api.getCustomerByGlobalId(globalId);
            setCustomer({
              id: data.id,
              globalId: data.globalId,
              fullName: data.fullName,
              points: data.points,
              currentTier: data.currentTier,
              multiplier: data.tier?.multiplier ?? 1,
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
    } catch {
      setErrorMsg('Error al acceder a la cámara');
      setShowScanner(false);
    }
  }, []);

  const stopScanner = useCallback(async () => {
    if (scannerRef.current) {
      try { await scannerRef.current.stop(); } catch { /* ignore */ }
      scannerRef.current = null;
    }
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
      // 1. Assign points. The `subtotal` is the BASE amount: the server resolves
      // the earn rate and the tier from it, at the moment of the charge. The
      // preview above is not sent — see `pointsToEarn`.
      const earned = await api.assignPoints(
        customer.id,
        subtotal,
        `Venta POS: ${cart.map((e) => `${e.item.name} x${e.qty}`).join(', ')}`,
      );

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
  }, [cart, customer, pointsToEarn, redeemResult, discount, total, subtotal]);

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
                      📷 Identificar Cliente
                    </>
                  )}
                </button>
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
            <p>Mostrale el código QR al cliente para identificarlo</p>
            <div id={scannerContainerId} className={styles.scannerReader} />
            <button type="button" className={styles.closeBtn} onClick={stopScanner}>
              Cancelar
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
