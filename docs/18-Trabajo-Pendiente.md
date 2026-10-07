# Trabajo pendiente

## Etapa 0b — Registro de una venta ya cobrada: el eslabón roto del mostrador

**Estado:** forma decidida, no empezada.
**Valor:** máximo. El producto no existe sin esto.
**Origen:** `docs/17-Estrategia-Competitiva.md` §7 y Etapa 0.

### El problema

El cliente se registra, pide su pase y lo guarda. **Pero nadie puede acumular nada en el mostrador.**
Hoy el POS cobra y acumula puntos, pero solo para el negocio que ya tiene integración: manda
`points` ya calculados. No existe el canal para el negocio que no la tiene — que es todos.

### El giro que define esta etapa

La versión anterior de este documento describía un flujo distinto: **nosotros** creábamos la orden en
Mercado Pago (`POST /v1/orders` con `external_reference` = UUID del checkin) y el cajero pagaba a
través de nuestra pantalla. Eso nos ponía a nosotros como el que cobra.

**No es el producto.** El producto es el inverso: **la venta la completa el terminal del comercio y
a nosotros solo nos llega el hecho.** Nosotros no tocamos el checkout.

```
1. El cliente muestra su pase. El cajero lo escanea con el lector del terminal.
2. El terminal nos pregunta si ese código existe. → respondemos sí/no para mostrar.
   Nunca rechazamos la venta. (ver "La regla que no se negocia")
3. La venta se cobra, normalmente, en el terminal.
4. Cuando el pago se concreta, el terminal nos manda el hecho:
       { payment_id, member_code, amount_cents }
5. Deduplicamos por payment_id. Si ya lo vimos, no hacemos nada y devolvemos 200.
6. Growth calcula los puntos con la regla del tenant y los asigna con
   reference_id = payment_id.
```

El paso 4 es el que antes no existía. Antes **nosotros** iniciábamos la venta; ahora la venta ya
ocurrió y nosotros la escuchamos.

**Por qué el giro importa, más allá de la implementación:**

- La lealtad que exige poseer el checkout solo crece al ritmo de los comercios que instalan nuestro POS.
  La que escucha al terminal crece al ritmo de todos los demás.
- El monto atado a una identidad de cliente es lo que nos separa del competidor: Loyalia cuenta
  cada ticket como **visita** y tira el monto a la basura. Acumulando **por valor**, el mismo ticket
  vale distinta cosa según quién compró y cuánto gastó.

### La identidad del evento, y por qué la idempotencia sale gratis

En este flujo **el evento ya viene con nombre, y lo emite el propio medio de pago**: el `payment_id`.
No hay que inventar una clave, y no hay que confiar en que un cliente se comporte.

```
unique(business_id, payment_id)
```

| Caso | Resultado |
|---|---|
| El terminal reintenta el mismo pago | Mismo `payment_id` → ya existe → no acumula dos veces |
| El cliente compra dos veces | Distinto `payment_id` → se acumula normal, que es lo correcto |

Una **ventana temporal** habría sido peor: no distingue "el terminal reintentó" de "el cliente
compró otra vez", y por eso se come una de las dos. No hace falta.

La capa segunda ya existe y no hay que crearla: `uq_points_tx_reference` sobre
`(customer_id, reference_id)` (`packages/db/src/schema.ts:315`) es la red del ledger. `reference_id`
recibe el mismo `payment_id`.

> Esto reemplaza la decisión que estaba abierta en la versión anterior de este documento. No es la
> opción A (clave del cliente), ni la B (ventana temporal), ni la C (el `order_id` que se guardaba
> *después* de crear la orden): es el identificador de la transacción del medio de pago, disponible
> en el momento en que la venta se cobra.

### Contrato

Dos endpoints, porque son dos momentos distintos y no deben ser un endpoint solo.

**A. Resolver el pase.** Sucede al principio, cuando el cajero escanea. No crea nada.

```
POST /v1/passes/resolve
{ "member_code": "ABC-1234" }

→ 200 { "known": true,  "customer_id": "...", "display_name": "..." }
→ 200 { "known": false }
```

Siempre 200. Un `known: false` es información para el cajero, no un veto.

**B. Registrar la venta.** Sucede al final, cuando el pago se concreta.

```
POST /v1/checkins
{
  "payment_id":    "1234567890",  // opcional — lo manda el terminal. Ausente en la vía manual.
  "member_code":   "ABC-1234",    // obligatorio
  "amount_cents":  12500,         // obligatorio
  "items":         [ ... ],       // opcional — ver "Los productos, más adelante"
  "note":          "..."          // opcional
}

→ 201 { ... }   primera vez
→ 200 { ... }   ya lo habíamos visto (mismo payment_id)
```

El `201` / `200` es la semántica natural de un create idempotente, y le dice al terminal — sin
palabras — si su mensaje fue el que abrió el registro o uno repetido.

### La vía manual (el emulador de hoy)

El mismo núcleo, escrito por una persona. Un cajero autenticado en el dashboard registra
`{ member_code, amount_cents }` sin `payment_id`.

**Es el hermano más débil y conviene decirlo:** sin `payment_id` no hay deduplicación posible
contra un doble registro. `payment_id` es `NULL`, y en Postgres `NULL != NULL`, así que el índice
único no colisiona — no rompe nada, simplemente no protege. Es aceptable porque esta vía es el
emulador; la vía real es el terminal.

### La tabla

```
checkins
  id            uuid        PK — nuestro, siempre
  business_id   uuid        FK — del credencial del terminal, nunca del body
  customer_id   uuid        FK — resuelto por nosotros desde member_code
  member_code   text        lo que recibió el terminal; queda como evidencia de lo escaneado
  payment_id    text        NULL en la vía manual
  amount_cents  integer     autoritativo
  items         jsonb       NULL — ver más abajo
  note          text        NULL
  points        integer     NULL hasta que Growth lo calcule
  created_at    timestamptz
```

`unique(business_id, payment_id)`, índice parcial o no — la semántica de `NULL` de Postgres ya
resuelve el caso manual.

`member_code` se guarda aunque `customer_id` ya esté resuelto: es la evidencia de lo que el cajero
escaneó, y es lo que permite auditar una atribución cuando el código se reasigna.

`business_id` sale del **credencial**, nunca del body. El `member_code` es único por negocio
(`uq_customers_business_member_code`), así que el scope del credencial es lo que impide que un
terminal de un negocio resuelva un pase de otro.

### Criterio de aceptación

> Una venta real llega por el terminal, la acumulación sube, el pase del cliente lo refleja, y el
> mismo `payment_id` enviado dos veces acumula una sola vez.

Las tres partes importan. La tercera es la difícil, y ya está resuelta por diseño.

### La regla que no se negocia

**Nuestro failure no puede costar una venta al comercio.**

Si caemos, si el pase no existe, si el código está vencido: **la venta se cobra igual.** El paso 2
responde siempre "seguí cobrando". Un `500` en esa pantalla significa que le negamos el café a un
cliente porque nuestro lado tuvo un problema, y eso no es un bug tolerable.

Por eso el registro de una venta nunca puede depender de que la validación haya funcionado.

### Los productos, más adelante (decidido, no en esta etapa)

`items` es un `jsonb` opcional, y su forma está decidida aunque la etapa no lo implemente:

```
[ { product_ref, name, qty, unit_price_cents }, ... ]
```

Tres reglas:

1. **`product_ref` es un string opaco del comercio o del medio de pago.** No es FK.
2. **Los valores van inlineados porque es un snapshot.** Si mañana el producto se renombra o se
   borra del catálogo, la estadística histórica tiene que seguir diciendo lo que realmente se vendió.
   Un registro vivo miente sobre el pasado.
3. **`amount_cents` es autoritativo y `items` es best-effort.** Si la suma no cuadra, la venta no
   se cae. Son datos auxiliares; no se rechaza una venta real por metadata.

**No habrá tabla `products` por tenant.** La identidad del producto es del comercio, y copiarla es
copiar algo que ya existe y que se desactualiza en el instante en que renombran un producto. Un
catálogo nuestro se vuelve mentira con velocidad.

**La expectativa honesta:** el medio de pago transporta el **total**, no el carrito. La línea de
ítems vive en el POS del comercio, que es otro sistema. Es probable que `items` sea `null` la
mayoría de las veces. Por eso se guarda sin construir nada encima: la columna es el experimento, y
el análisis se escribe cuando haya datos reales que miren.

### Fuera de alcance de esta etapa

- El cálculo de puntos por monto ya existe (`earn_by` / `earn_unit_amount`, commit `551b912`). Esta etapa **consume** esa regla, no la crea.
- `points_transactions.program_id` — no existe; es lo que impide N programas por tenant.
- **El otro producto**: nuestro POS creando la orden en Mercado Pago. Comparte el núcleo —misma
  tabla, mismo dedupe por el identificador de la transacción— pero es otra etapa. Ahí sí nace
  `pending`, porque ahí el hueco entre crear la orden y que alguien la pague es real.
- `items` y `ticket_photo` como capturas propias: el terminal no tiene ni una cosa ni la otra.
- El evento `PurchaseCompleted` del Schema Registry — es la Etapa 1.
- Los handlers de webhook de Mercado Pago — Etapa 6b.
- Reconciliación por poll — Etapa 1.

### Abierto a propósito

- **¿El terminal reintenta, y cómo lo sabremos si no lo hizo?** No investigado. Decisión
  explícita: esta etapa define *nuestra* parte y no especula sobre la del otro. Pero queda escrito
  que es la falla más cara del diseño — ver abajo.

#### La falla que esta etapa no cubre

El terminal es el único que sabe que se escaneó un pase. **El webhook de Mercado Pago tiene el monto
y el `payment_id`, pero no sabe que hubo una atribución de lealtad.** Si el mensaje del terminal se
pierde y nunca se reintenta, el cliente pagó y no acumuló nada, y el cajero no tiene forma de ver
por qué.

Es la única falla del sistema que le cuesta plata al usuario final. Reconciliar eso depende de
saber la semántica de reintento del otro lado, así que **no se diseña todavía** — pero tampoco
debe olvidarse: si aparece, es una etapa propia y va antes que las estadísticas.

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
| `MAX_EARN_RATE` / `MAX_EARN_UNIT_AMOUNT` | Resueltos abajo — no estaban sin fundamento, y el defecto no era el número. |

### Los ceilings: resueltos, y no eran lo que parecía

Este documento decía que los techos estaban *"sin fundamento, decisión aparte sin dueño"*. Era un
diagnóstico incorrecto.

**Están derivados de las columnas.** `earn_rate` es `numeric(10,4)` (`packages/db/src/schema.ts:229`)
→ tope real `999999.9999`. `earn_unit_amount` es `numeric(12,2)` (`schema.ts:265`) → tope real
`9.999.999.999,99`. Ambos valores caen dentro, que es lo que dice el comentario en `routes.ts:47-48`.

**Y no son reglas de negocio, son guardas de sensatez.** El propio código lo dice: *"earnRate past
this is a typo, not a promotion"* (`routes.ts:42`). Nada calcula puntos **en** el techo. El valor
exacto es arbitrario **por diseño**: tiene que estar arriba de todo valor real y dentro de la
columna, y nada más. Fundamentarlo como número de negocio era la pregunta equivocada.

**El defecto real era otro.** El número está duplicado a mano en dos runtimes —
`apps/dashboard/src/lib/loyalty-earn-rule.ts:51,54` lo copia, y su comentario lo admite: *"Mirrors
`MAX_EARN_RATE` in `workers/growth/src/routes.ts`"*. Y la divergencia es asimétrica en la dirección
peligrosa:

| | Si el valor es inservible |
|---|---|
| Worker (`parseEarnUnitAmount`, `routes.ts:108`) | devuelve `null` → **rechaza la venta** con `INVALID_EARN_UNIT_AMOUNT` |
| Dashboard (`usableUnitAmount`, `loyalty-earn-rule.ts:115`) | cae a `1000` → **renderiza un número igual** |

Si alguien baja el techo del worker, el POS sigue prometiendo un programa que el worker ya rechaza.
El preview promete, el cargo revienta.

**La fix no es elegir otro número: es derivar el predicado de un solo lugar.** La columna sigue siendo
la fuente de la verdad, y los dos runtimes la leen.

---

## Pendiente — `sslmode=require` se va a debilitar en silencio cuando bumpee `pg`

**Estado:** anotado, sin acción. No es urgente: no hay clientes reales y la configuración actual es
más estricta de lo que su nombre dice.

### Qué pasa

Todas las connection strings del repo —las de `.dev.vars` y la que usa `deploy.yml`— terminan en
`sslmode=require`. El driver de Postgres advierte en cada ejecución:

```
Warning: The SSL modes 'prefer', 'require', and 'verify-ca' are treated as
aliases for 'verify-full'. In the next major version (pg-connection-string v3.0.0
and pg v9.0.0), these modes will adopt standard libpq semantics, which have
weaker security guarantees.
```

**Hoy `require` es un alias de `verify-full`**: se cifra *y* se verifica el certificado del servidor
contra la CA del sistema. En `pg` v9, `require` pasa a significar lo que siempre significo en libpq:
cifrado, **sin verificar el certificado**.

O sea: la línea que hoy dice `require` está más segura de lo que se lee. Al bumpear `pg` a v9
deja de estarlo, y nada en el código va a avisar — el warning es del driver, y sigue apareciendo.

### Por qué no se arregla ahora

Porque arreglarlo hoy es cambiar la cadena de conexión por algo que ya funciona. Las dos salidas son
válidas y la decisión se toma junto con el bumpee:

| | Cuándo |
|---|---|
| Poner `sslmode=verify-full` explícito | Ahora, si se quiere que el nombre diga lo que hace |
| Dejarlo y revisarlo al bumpear `pg` a v9 | Cuando toque; el warning sigue visible hasta entonces |

Ninguna de las dos rompe nada hoy. Lo que **no** hay que hacer es bumpear `pg` a v9 y seguir leyendo
`require` como si significara lo que significa hoy.

### Cómo se detecta

`node scripts/check-migration-drift.mjs` y cualquier worker que imprima el warning. Si desaparece
el warning sin que haya cambiado la cadena, alguien ya lo migro — volver a revisar acá.

### Sigue abierto

- La **Etapa 0b**: implementada y en `main` (PR #202). Migración `0011` aplicada a mano en la rama
  `production` de Neon, con su fila en `drizzle.__drizzle_migrations`. Gate de drift en verde.
- La semántica de reintento del terminal, y la reconciliación que depende de ella — diferida a
  propósito en la Etapa 0b, con el riesgo anotado ahí. **Sigue siendo la falla más cara del diseño.**
- `sslmode=require` y el bumpee a `pg` v9 — lo de arriba.
- Los límites logísticos del `verify` — sin relación con lo anterior.