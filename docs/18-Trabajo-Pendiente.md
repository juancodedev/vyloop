# Trabajo pendiente

## Etapa 0b — `POST /v1/checkins`: el eslabón roto del mostrador

**Estado:** especificada, no empezada.
**Valor:** máximo. El producto no existe sin esto.
**Origen:** `docs/17-Estrategia-Competitiva.md` §7 y Etapa 0.

### El problema

El cliente se registra, pide su pase y lo guarda. **Pero nadie puede acumular nada en el mostrador.**
El POS hoy cobra y acumula puntos, pero solo para el negocio que ya tiene integración: manda
`points` ya calculados. No existe el canal para el negocio sin integración.

### El diseño (§7)

El `checkin` es el **puente de identidad** entre el mostrador y Mercado Pago. El cajero no escribe
nada de lo que el sistema puede saber solo:

```
1. El cliente presenta su pase, o el cajero lo busca por nombre
2. Nuestra app abre un checkin: UUID propio + member_code + amount_cents, status pending
3. POST /v1/orders
       external_reference  = <UUID del checkin>
       X-Idempotency-Key   = <el mismo UUID>
       type                = "point"  (la maquinita cobra)
                          |  = "qr"    (el cliente escanea un QR dinámico)
       transactions.payments[].amount = "<monto>"
       config.point.terminal_id       = TIPO__SERIAL
       config.qr.mode                  = "dynamic" → devuelve qr_data EMVCo
4. Guardamos order_id de Mercado Pago en el checkin
5. El cliente paga
6. Webhook de MP → buscamos por external_reference → ya sabemos QUIÉN y CUÁNTO
7. Growth calcula los puntos según la regla del tenant y los asigna
8. Poll de reconciliación para los webhooks perdidos
```

`external_reference` es lo que nos separa del competidor: Loyalia cuenta cada ticket como **visita**
y tira el monto a la basura.-atado a un cliente, acumulamos **por valor**.

### Contrato del endpoint

```
POST /v1/checkins
{
  "member_code":     "string",   // obligatorio — el pase del cliente
  "amount_cents":    12500,      // obligatorio — monto de la compra
  "note":            "string",   // opcional
  "ticket_photo":    "..."       // opcional
}

→ 201 {
    "id":            "<uuid>",  // también el external_reference
    "member_code":   "...",
    "status":        "pending",
    "order_id":      null,
    "points":        null,       // null hasta que el pago se confirme
    "created_at":    "..."
  }
```

### Alcance

| | |
|---|---|
| Tabla | `checkins`: `id`, `business_id`, `customer_id`, `member_code`, `amount_cents`, `note`, `status`, `order_id`, `created_at` |
| Ruta | `POST /v1/checkins` en `workers/growth/src/routes.ts` |
| UI | botón de check-in en `apps/dashboard/src/app/dashboard/loyalty/pos/` — escáner (`html5-qrcode` ya está) + búsqueda por nombre |
| Migración | `packages/db/drizzle/` — **escrita y aplicada antes del deploy** |

### Criterio de aceptación

> Un cajero autenticado escanea un pase real, la acumulación sube, el pase del cliente lo refleja,
> y un segundo escaneo del mismo evento no duplica nada.

Las tres partes importan. La tercera es la difícil.

### Decisión pendiente ANTES de escribir la tabla

**¿Cómo se implementa la idempotencia?** Determinа las columnas, así que no se puede decidir después.

| | Cómo | Consecuencia en la tabla |
|---|---|---|
| **A** | Clave de idempotencia explícita, `unique(business_id, idempotency_key)` | Una columna más. El cajero o el POS la manda. Semántica clara de "es el mismo evento". |
| **B** | Deduplicación por ventana temporal: mismo `member_code` dentro de N minutos | Índice sobre `(business_id, member_code, created_at)`. Sin columna nueva. Pero **deja pasar** dos check-ins legítimos del mismo cliente en la ventana. |
| **C** | Deduplicación por `order_id` de Mercado Pago | Sin columna extra, pero solo protege **después** de crear la orden en MP. No protege el checkin local, que es donde el doble escaneo ocurre. |

**Recomendación: A**, con **C** como capa segunda. B es la única que no necesita columna y es la
que más riesgo de puntos fantasma arrastra.

### Fuera de alcance de esta etapa

- El cálculo de puntos por monto ya existe (`earn_by` / `earn_unit_amount`, commit `551b912`). Esta etapa **consume** esa regla, no la crea.
- `points_transactions.program_id` — no existe; es lo que impide N programas por tenant.
- El evento `PurchaseCompleted` del Schema Registry — es la Etapa 1.
- Los handlers de webhook de Mercado Pago — Etapa 6b.
- Reconciliación por poll — Etapa 1.

---

## Bug vivo — decisión necesaria antes de seguir

**Origen:** commit `551b912` (la regla pesos→puntos).

El worker de `551b912` endureció el guard de `points`:

```ts
if (!Number.isInteger(body.points)) → 400 VALIDATION_ERROR
```

El guard anterior era `body.points < 1`. El POS, bajo `earn_by: 'visit'` (que es el default, y donde
están todos los tenants hoy), manda el **subtotal en pesos como `points`**:

```
venta de $4.00  → points: 4     → entero     → ✅
venta de $3.50  → points: 3.5   → no entero  → ❌ 400
```

**Todos los precios del menú terminan en .50.** Es decir: la mitad de las ventas fallan.

**Por qué no lo arregló el worker:** cada arreglo posible cruza una frontera de otro work unit.

- El valor honesto bajo `visit` es un **conteo** ("hubo una visita"), no un monto en pesos. Pero eso **cambia el saldo de todos los tenants existentes** y toca `apps/dashboard/src/app/dashboard/customers/[id]/page.tsx`, que comparte el helper.
- `loyalty-points.contract.test.ts` fija `api.assignPoints(customer.id, subtotal, …)` con una aserción explícita de "not floored" cuya razón escrita —*"el server hace el floor del producto"*— ya está desactualizada.

### Opciones

| | Cambio | Costo |
|---|---|---|
| **A** | El POS manda `Math.round(subtotal)` bajo `visit` | Pie de oat. Un café de $3.50 cuenta como 4 puntos. Semánticamente raro pero **no rompe saldo existente**. |
| **B** | `visit` deja de aceptar pesos y el POS manda `1` por check-in | Correcto semánticamente, pero **cambia el saldo de todos los tenants**. Necesita migración de datos y comunicación. |
| **C** | Revertir el guard a `body.points < 1` y filtrar solo no-finitos | Deshace la protección del `NaN`. **No.** |

**Recomendación: A como mitigación inmediata**, y **B como el arreglo de fondo** cuando se defina qué
es una visita. A es un parche; B es la decisión de producto.

Mientras no se elija, **la mitad de las ventas de los tenants en `visit` devuelven 400.**