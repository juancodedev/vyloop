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
y tira el monto a la basura. Con el monto atado a un cliente, acumulamos **por valor**.

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

## Resuelto — bajo `visit`, una visita es un conteo (no un monto en pesos)

> Estado: cerrado. Se conserva el registro de la decisión, no la pregunta.

**Origen:** commit `551b912` (la regla pesos→puntos).

El worker de `551b912` endureció el guard de `points`:

```ts
if (!Number.isInteger(body.points)) → 400 VALIDATION_ERROR
```

El guard anterior era `body.points < 1`. El POS, bajo `earn_by: 'visit'` (que es el default, y donde
están todos los tenants hoy), mandaba el **subtotal en pesos como `points`**:

```
venta de $4.00  → points: 4     → entero     → ✅
venta de $3.50  → points: 3.5   → no entero  → ❌ 400
```

**Todos los precios del menú terminan en .50.** Es decir: la mitad de las ventas fallaban.

### Qué se decidió

**Opción B.** No A: `Math.round(subtotal)` no arreglaba el bug, lo escondía. Un café de $3.50
contando como 4 visitas es una mentira en la única dirección que el cajero puede ver en el ticket,
y deja el `NaN` reintroducido por la puerta de atrás. No C: revertir el guard deshace la protección
del `NaN` y devuelve el 400 sin explicación.

La pregunta que había que responder antes de escribir código era *"¿qué es una visita?"*, y la
respuesta es un hecho sobre el **evento**, no sobre su precio: **una venta cobrada o un check-in es
una visita.** El cliente vino una vez, haya gastado $1 o $99.999. Un monto en pesos no es un conteo
— y por eso el POS lo estaba mandando donde el worker exige un entero.

### De dónde sale el número

De un solo lugar con nombre: `VISITS_PER_CHARGE` en `apps/dashboard/src/lib/loyalty-points.ts`.

No es `Math.round`, no es `Math.ceil`, no es el largo del carrito. `earnBase` ahora recibe los dos
hechos de una venta por separado — `pesos` y `visits` — y **la mecánica elige cuál lee**:

```
purchase → pesos / earn_unit_amount   (cuánta unidad se compró)
visit    → visits                     (cuántas visitas, tal cual)
```

Bajo `visit` el dinero no se lee en absoluto, que es exactamente lo que hace que una venta de $3.50
sea vendible otra vez: la base es entera por construcción, no por redondeo.

### Consecuencias aceptadas

- **Cambia el comportamiento de todos los tenants**, porque `visit` es el default. Aceptado: la
  alternativa era que la mitad del menú no se vendiera.
- **Los saldos que ya están en `points_transactions` se quedan como están.** Son datos de prueba
  escritos bajo la lectura vieja. Sin migración, sin backfill, sin limpieza.
- La etiqueta del modal "Registrar Venta" en `customers/[id]` pasa a decir **Visitas / conteos**
  con `step="1"` bajo `visit`: el operador ya no tiene que escribir pesos donde va un conteo.

### Qué NO se tocó (y por qué está bien así)

| | |
|---|---|
| `workers/growth/src/routes.ts` | El contrato del servidor ya era correcto. `Number.isInteger` está bien: un conteo de visitas es un entero. Los **llamadores** estaban mal. |
| `packages/db/**` | No hay nada que migrar. |
| `MAX_EARN_RATE` / `MAX_EARN_UNIT_AMOUNT` | Los techos siguen siendo una pregunta abierta, en otro work unit. |

### Sigue abierto

- Los ceilings (`MAX_EARN_RATE`, `MAX_EARN_UNIT_AMOUNT`) — decisión aparte, sin dueño todavía.
- La **Etapa 0b** de arriba (`POST /v1/checkins`) y su decisión de idempotencia, sin cambios.