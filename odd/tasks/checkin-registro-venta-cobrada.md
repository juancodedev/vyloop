# ODD — Etapa 0b: registro de una venta ya cobrada

> Spec completa y decisiones: `docs/18-Trabajo-Pendiente.md` § Etapa 0b.
> Este archivo es el plan de ejecución y la evidencia. La spec es la fuente de la verdad.

## Objetivo

Que el mostrador pueda acumular. Hoy el POS solo acumula para el negocio que ya tiene integración,
porque manda `points` ya calculados. Falta el canal para el resto.

El giro que define la etapa: **no somos el que cobra.** La venta la completa el terminal del comercio
y a nosotros llega el hecho ya pagado. Nosotros accumulating sobre ese hecho.

## Problema

No existe forma de registrar una venta cerrada atada a una identidad de cliente cuando la cobra un
sistema externo. Sin eso, el pase es un documento sin efecto.

## Por qué esta forma y no la anterior

El documento especificaba un producto invertido (nosotros creábamos la orden en MP con
`external_reference` = UUID del checkin). Eso nos ponía como el que cobra, y la lealtad que exige
poseer el checkout solo crece al ritmo de los comercios que instalan nuestro POS.

Con el giro, la idempotencia sale gratis: **el `payment_id` del medio de pago ya es la identidad del
evento**, disponible en el momento en que la venta se cobra. `unique(business_id, payment_id)`.

## Alcance

| | |
|---|---|
| Tabla | `checkins` en `packages/db/src/schema.ts` |
| Migración | `packages/db/drizzle/0011_checkins.sql` — generada con drizzle-kit, encabezado a mano |
| Rutas | `POST /v1/loyalty/passes/resolve` y `POST /v1/loyalty/checkins` en `workers/growth/src/routes.ts` |
| Refactor | Extraer el cálculo de `POST /v1/loyalty/points/assign` a un helper compartido |
| Tests | `workers/growth/src/index.test.ts` + contrato del dashboard si cambia la ruta del archivo |

## Restricciones

- El auth es por headers inyectados por el gateway (`X-User-Id`, `X-Business-Id`, `X-User-Role`).
  **No existe concepto de credencial de máquina.** Un terminal entra por el mismo gateway. No se
  agrega auth en esta etapa; es otra etapa.
- `AppEnv.Variables.auth` está declarado pero nunca se setea (`helpers.ts:62`, `index.ts:28`).
  **No usar `c.get('auth')`** — typecheckea y devuelve `undefined`.
- La fórmula `Math.floor(base * earnRate * tierMultiplier)` está fijada por un test del dashboard que
  hace `match()` sobre el archivo del worker (`loyalty-points.contract.test.ts:163`). La expresión
  tiene que quedar **idéntica**.
- Las migraciones se aplican **a mano**; `drizzle-kit migrate` contra producción está prohibido
  (`0010_high_kree.sql:72-76`). El archivo se commitea sin aplicar.
- `migration-sql.test.ts` valida que toda tabla se cree antes de cualquier índice que la referencie,
  y que las migraciones no.enableen RLS.
- Índices y constraints van en el **segundo argumento** del `pgTable`, como array.

## Criterio de aceptación

> Una venta real llega por el terminal, la acumulación sube, el pase del cliente lo refleja, y el
> mismo `payment_id` enviado dos veces acumula una sola vez.

## Tareas

### T1 — Tabla `checkins` y migración

`pgTable` con `uuid` PK `defaultRandom()`, FK a `tenants` y a `customers` (ambas `cascade`),
`unique('uq_checkins_business_payment').on(table.businessId, table.paymentId)`, y un `jsonb` para
`items`. `jsonb` ya está importado en el archivo.

Migración con drizzle-kit (`pnpm --filter @vyloop/db db:generate`), luego encabezado con prosa al
estilo de `0010`: qué es, por qué, qué se rechazó, y que **no** se aplica acá.

Registrar el `checkins` en los re-exports de `packages/db/src/index.ts` y ajustar los contadores de
`packages/db/src/index.test.ts` (hoy dicen 15 y ya hay 22 tablas — están stale, y esta tarea los
toca igual).

### T2 — Extraer el cálculo de puntos a un helper compartido

`POST /v1/loyalty/points/assign` tiene la aritmética **inline** (`routes.ts:698-943`) y no es
reutilizable. Extraer a `helpers.ts` una función que tome lo que ya está resuelto y devuelva los
puntos acreditados, dejando `const effectivePoints = Math.floor(base * earnRate * tierMultiplier);`
con esa forma exacta dentro del helper.

El endpoint existente queda como auth + validación + llamada. La fórmula no se toca.

**Consecuencia a verificar:** el test de contrato del dashboard hace match sobre
`workers/growth/src/routes.ts`. Si la fórmula se mueve a `helpers.ts`, ese match deja de encontrar y
el test falla. Hay que actualizar la ruta que lee el test — **sin cambiar qué afirma**.

`reference_id` ya es caller-supplied y obligatorio en `assign` (`routes.ts:715`), con dedupe en
`uq_points_tx_reference` y 409 `DUPLICATE_REFERENCE`. El checkin reusa ese patrón con
`reference_id = payment_id`.

### T3 — `POST /v1/loyalty/passes/resolve`

Resuelve `member_code` → cliente. **Siempre 200**, con `known: true|false`. No crea filas, no tiene
estado. Nunca veta una venta: un `known: false` es información para el cajero, no un rechazo.

`business_id` sale del header, nunca del body.

### T4 — `POST /v1/loyalty/checkins`

1. Resolver `business_id` del header.
2. Resolver `member_code` → `customer_id`. Si no existe, `404` y no se escribe nada.
3. Insertar el checkin con `onConflictDoNothing` sobre `(business_id, payment_id)`.
4. Si la fila **ya existía** y `points IS NULL`, reintentar la acreditación y devolver `200`.
   Si ya tenía puntos, devolver `200` sin tocar nada.
5. Si se insertó, acreditar y devolver `201`.

El paso 4 es el que hace que esto sea correcto: **el reintento tiene que acreditar los puntos que
quedaron pendientes**, o un terminal que reintenta después de un error parcial nunca termina de
acreditar.

`points IS NULL` es la señal observable de "venta registrada, acreditación pendiente". Eso convierte
el hueco del doc en un backlog visible en vez de una pérdida silenciosa.

### T5 — Tests

- `checkins` tiene que entrar en el `vi.mock('@vyloop/db')` (`index.test.ts:5-52`) o los
  predicados cross-tenant se renderizan opacos y la aserción pasa sola.
- Igualar `member_code` conocido y desconocido en `/v1/loyalty/passes/resolve`; ambos 200.
- `POST /v1/loyalty/checkins` primera vez → 201. Mismo `payment_id` de nuevo → 200, sin segundo insert.
- Mismo `payment_id` con `points IS NULL` → 200 **y** reintenta la acreditación.
- `amount_cents` ausente o inválido → 400, sin escribir.
- `member_code` inexistente → 404, sin escribir.

## Progreso

**T1 — Tabla y migración.** ✅ `packages/db/src/schema.ts:420`, unique en el segundo callback arg.
Migración `0011_material_odin.sql` generada con drizzle-kit + encabezado con prosa al estilo de
`0010`. Re-exports en `index.ts`. Los contadores stale de `index.test.ts` pasaron de "15 tablas" a
assertions por nombre, que es lo que debieron ser siempre.

**T2 — Fórmula compartida.** ✅ `routes.ts:184` `computeEarnedPoints`, con
`const effectivePoints = Math.floor(base * earnRate * tierMultiplier);` en `:189`.
`assign` la usa en `:939`, el checkin en `:1899`.

> **El plan estaba mal en una cosa.** La fórmula no podía ir a `helpers.ts`: un segundo test de
> contrato del dashboard (`pos-earn-mechanic.contract.test.ts:273`) también lee `routes.ts` y hace
> match de la misma declaración. Moverla rompía un archivo fuera de las superficies autorizadas.
> Quedó en `routes.ts`, junto a `resolveEarnRate` / `parseEarnUnitAmount` / `isEarnBy` — donde ya
> están sus otras tres entradas.

**T3 — `/v1/loyalty/passes/resolve`.** ✅ `routes.ts:1753`. Siempre 200. `display_name` es
`customers.fullName`, la columna real.

**T4 — `/v1/loyalty/checkins`.** ✅ `routes.ts:2047`, con `resolveMemberCode` en `:1710` y `creditCheckin`
en `:1822`. `ON CONFLICT DO NOTHING` sobre `(business_id, payment_id)`, read-back, `points IS NULL`
→ re-acredita → 200, ya acreditado → 200 intacto, nuevo → 201.

> **El read-back tiene una salida honesta:** si la fila existe pero no se puede leer, responde
> `500 CONFLICT_WITHOUT_ROW` en lugar de un 200. Devolver 200 ahí le mentiría al terminal — le
> diría que su venta quedó registrada cuando no lo podemos afirmar.

**T5 — Tests.** ✅ 24 tests nuevos en growth. `checkins` entró como `pgTable` real en el
`vi.mock('@vyloop/db')`. El contrato del dashboard se extendido para afirmar que la fórmula es
compartida por ambos llamadores, en vez de solo repuntado.

**Extra (fuera del plan, cerrado en esta sesión).** `checkins` se agregó a `BUSINESS_ID_TABLES` en
`packages/db/src/rls.ts`. No estaba en las superficies autorizadas del writer, y sin eso la tabla no
recibe policy de RLS cuando corra el rollout. Hoy no es una fuga — cada ruta filtra por
`businessId` explícitamente — pero es una bomba de tiempo.

## Verificación

| Comando | Resultado observado |
|---|---|
| `pnpm --filter @vyloop/growth test` | 165 passed (165) |
| `pnpm --filter @vyloop/db test` | 157 passed (157) |
| `pnpm --filter @vyloop/dashboard test` | 283 passed (283) |
| `typecheck` en los tres paquetes | limpio |

Los tres baselines estaban verdes antes de empezar: no hay fallas pre-existentes que nombrar.
La migración está en disco, **sin aplicar**.

## Follow-up

- Aplicar `0011_material_odin.sql` a mano. Las migraciones no corren solas contra producción.
- Credencial de máquina para integraciones. Hoy el gateway es el trust boundary completo y un
  terminal entra por el mismo camino que un operador.
- ¿El terminal reintenta? Sin eso, `points IS NULL` es un backlog observable pero no tiene
  quién lo vacíe.

## Decisiones tomadas antes de escribir código

- **Identidad del evento**: el `payment_id` del medio de pago. No es la opción A (clave del cliente),
  ni la B (ventana temporal), ni la C (el `order_id` guardado después de crear la orden). Es una
  cuarta, y sale gratis porque el evento llega ya nombrado.
- **Sin tabla `products`**: la identidad del producto es del comercio. Copiarla es mantener una
  copia que se vuelve mentira en el instante en que renombran algo.
- **`items` es `jsonb` best-effort**, `amount_cents` autoritativo. El medio de pago transporta el
  total, no el carrito — es probable que `items` sea `null` la mayoría de las veces.
- **Nuestro failure no puede costar una venta al comercio.** Por eso `/v1/loyalty/passes/resolve` nunca
  veta y siempre responde 200.

## Deferred (no en esta etapa, con el riesgo anotado)

- **¿El terminal reintenta, y cómo lo sabremos si no lo hizo?** No investigado. Es la falla más
  cara del diseño: el terminal es el único que sabe que hubo atribución, así que si su mensaje se
  pierde el cliente pagó sin acumular. Reconciliar eso va **antes** que las estadísticas.
- Credencial de máquina para integraciones. Hoy el gateway es el trust boundary completo.
- El otro producto (nuestro POS creando la orden). Comparte tabla y dedupe; ahí sí nace `pending`.