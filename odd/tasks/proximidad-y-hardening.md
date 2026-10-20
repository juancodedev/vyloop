# ODD — F3 (triggers de proximidad) y F4 (hardening y ciclo de vida)

> Spec completa y decisiones: `docs/19-Geolocalizacion-Notificaciones.md` §7.3, §7.4, §10, §11 (F3, F4) y §13.
> Este archivo es el plan de ejecución y la evidencia. La spec de arriba es la fuente de la verdad; este documento la ejecuta.

## Objetivo

Que una notification push pueda dispararse **por un local**, y que el ciclo de vida de las
suscripciones no crezca sin límite ni sobreviva a un cliente borrado.

Rama: `feat/proximity-triggers-and-hardening` (desde `main`).
Estrategia de entrega: `single-pr` — un solo PR, con commits por unidad de trabajo, para que la
revisión sea por commit y no por un diff de dos mil líneas.
Runner de tests: `npx vitest run --root <worker|package>` · typecheck: `npx tsc --noEmit` · drift: `pnpm db:drift`.

## Problema

F2 dejó el transporte de push funcionando: suscripción, cifrado, VAPID, entrega, consentimiento.
Lo que no existe todavía es **qué dispara un push** y **qué pasa con las suscripciones viejas**.

Tres hechos verificados en el código que definen el trabajo:

1. **La association cliente↔local no existe.** `customer_events.branch_id` existe en el esquema y
   **nunca se escribe en producción** (solo el seed, `packages/db/scripts/seed.ts:488`); `checkins`
   no tiene columna de local; `pos_terminals` tampoco. La regla de audiencia del plan
   ("customers with an event tied to that venue") no tiene fuente de datos. Hay que construirla.
2. **La cuenta ya usa los cinco cron triggers** (1 de `automation`, 4 de `wootric-saas-sync-worker`).
   Un cron trigger nuevo sería rechazado por la API de Cloudflare. El barrido de F4 tiene que
   salir del cron que ya existe, y hay precedente: el `automation` ya despacha el sweep de la
   wallet por service binding (`workers/automation/src/index.ts:121`).
3. **El borrado de cliente es lógico, no físico.** `DELETE /v1/customers/:id` hace `UPDATE` de
   `deleted_at` (`workers/customer/src/routes.ts:1391`), así que el `ON DELETE CASCADE` de
   `push_subscriptions.customer_id` **nunca se dispara**: las suscripciones de un cliente borrado
   sobreviven y el push sigue llegándole.

## Alcance

| | F3 — trigger de proximidad | F4 — hardening y ciclo de vida |
|---|---|---|
| Eventos | `PushCampaignRequested`, `CustomerCheckedIn` | — |
| API | `POST /v1/communication/push/campaigns` (operador) | `GET /v1/communication/push/deliveries` (operador) |
| Datos | `checkins.branch_id`, índice de `customer_events.branch_id` | índice de `push_subscriptions.last_seen_at` |
| Worker | `workers/communication` (campaña), `workers/growth` (check-in) | `workers/communication` (barrido), `workers/automation` (cron) |

## Specs

### S1 — La venta conoce el local

`checkins` gana una columna `branch_id` nullable, con FK a `branches`. La ruta
`POST /v1/loyalty/checkins` (`workers/growth/src/routes.ts:2082`) acepta un `branch_id` opcional en
el body.

- Si viene `branch_id`, **debe pertenecer al tenant del llamador**. Un `branch_id` de otro negocio
  es un `404` — no un `403`: no se discloses la existencia de un local ajeno.
- Si no viene, el check-in se acepta igual. El local es opcional, no requerido.
- La columna es nullable y `ON DELETE SET NULL`: una venta sobrevive a la baja de su local.

### S2 — La interacción se registra y se publica

Un check-in **con** local escribe una fila en `customer_events` con
`event_type = 'customer.checked_in'` y el `branch_id` de la venta, y publica el evento
`CustomerCheckedIn` a la cola de entregas.

- El `customer_events` se escribe en la **misma** request que el check-in.
- Un check-in **sin** local no escribe `customer_events` ni publica nada: no hubo interacción con
  un local.
- El evento se publica a la cola de entregas (`vyloop-notification-deliveries`), que es la que
  consume el worker de comunicación.

### S3 — La campaña es un evento, y hay una API para componerla

`PushCampaignRequested` es un evento de dominio. `POST /v1/communication/push/campaigns` es
una ruta de operador que acepta:

```jsonc
{
  "target": { "branch_id": "…" },
  // o
  "target": { "latitude": -12.05, "longitude": -77.04, "radius_m": 1500 },
  "title": "…",
  "body": "…",
  "url": "/…",              // opcional
  "reference_id": "…"      // opcional; la idempotencia del operador
}
```

- El `target` es **exactamente** una de las dos formas. Ambas a la vez es `422 VALIDATION_ERROR`.
- `radius_m` es un entero positivo y acotado (máximo 50 000 m). Un radio mayor es `422`.
- La ruta responde `202` con el `reference_id` y el conteo de la audiencia **resuelta** en el
  servidor. Nunca acepta una lista de clientes del cliente: el público se resuelve en el servidor,
  siempre.
- La ruta es de operador (`requireCounterSubject` / guard de rol). Un cliente no compone campañas.
- Es idempotente por `reference_id`: la misma campaña con el mismo `reference_id` no vuelve a
  enviar.

### S4 — El radio se resuelve con geohash y se afina con la distancia exacta

El worker resuelve los locales dentro de `radius_m` de un centro en dos pasos:

1. **Filtro grueso, por prefijo de geohash.** La celda de precisión 6 es de ~1.2 km × 0.6 km. Un
   radio de hasta 50 km puede abarcar varias celdas, así que el prefijo se calcula sobre la
   precisión que cubre el radio, y se toman **las celdas vecinas** (no solo la celda del centro:
   un local a 900 m del borde cae en la celda de al lado).
2. **Filtro fino, por distancia exacta.** La distancia haversine en metros contra el radio. Un
   local que cae en la celda pero fuera del radio **no** entra.

- Un local sin coordenadas (`latitude`/`longitude` en `NULL`) **nunca** aparece en el resultado de
  un radio. "Sin posición" no es "en todas partes".
- Un local de **otro tenant** nunca aparece: la consulta filtra por `business_id`.
- La distancia se calcula sobre los valores en grados, no sobre el geohash.

### S5 — La audiencia

- Campaña por local → los clientes con una interacción en ese local.
- Campaña por radio → los clientes con una interacción en **cualquiera** de los locales resueltos.
- Cada objetivo **debe** tener consentimiento `nearby_notifications` **y** al menos una
  suscripción de push. Un objetivo sin consent o sin suscripción se saltea y se cuenta como
  `skipped`.
- Un mismo cliente con interacciones en dos locales de la campaña se cuenta **una vez**.

### S6 — La entrega

Cada suscriptor de la audiencia recibe el push por el camino de entrega que ya existe
(`deliverPushNotification`), con la revalidación de consentimiento en el momento del envío.

- La fila de `message_log` lleva `content.reference_id` = `<reference_id de la campaña>:<id de la
  suscripción>`. Así la deduplicación es por campaña **y** suscriptor, y el mismo `reference_id`
  de campaña no bloquea a los demás suscriptores de esa campaña.
- La entrega por suscriptor se comporta como la de push de hoy: `201` enviado, `404`/`410` borra la
  suscripción, `429` reintenta, `401`/`403` es terminal.

### S7 — Una suscripción viva se refresca

Cada intento de entrega actualiza el `last_seen_at` de la suscripción. Una suscripción que se
entrega sigue viva; una que no se ve desde hace meses es candidata a borrarse.

### S8 — El barrido

Un barrido de mantenimiento:

- Borra las suscripciones cuyo `last_seen_at` sea anterior a **180 días**.
- Borra las suscripciones cuyo `last_seen_at` sea `NULL` y cuya creación sea anterior a **180
  días**. Una suscripción reciente sin `last_seen_at` **no** se borra.
- Borra las suscripciones de clientes con `deleted_at` Informado (S12).
- **Nunca** lanza. Un cron que lanza reintenta la invocación entera; cada sub-tarea captura y
  registra su error.
- Reporta los conteos: `pruned_stale`, `pruned_deleted_customer`, `reaped`, `errors`.

### S9 — El barrido corre en el cron que ya existe

La cuenta tiene los cinco cron triggers ocupados. El barrido **no** crea uno nuevo:

- El worker de comunicación expone el barrido como un handler `scheduled`.
- El worker de automation lo despacha desde su cron existente (`0 6 * * *`) por un service binding,
  exactamente como hace con el sweep de la wallet.

### S10 — Los deliveries de push se ven

`GET /v1/communication/push/deliveries` (operador) devuelve, sobre `message_log` con
`channel = 'push'`:

- Los conteos por estado (`queued`, `sent`, `failed`).
- Los deliveries más recientes, paginados como la ruta de historial existente.

La ruta de historial existente (`GET /v1/communication/history`) hoy filtra `channel = 'whatsapp'`
en hardcode: un delivery de push es **invisible** en ella. La ruta de historial debe poder
filtrar por canal, y el filtro por defecto debe incluir `push`.

### S11 — Los endpoints de suscripción son input de atacante

La ruta de suscripción (`POST /v1/communication/push/subscribe`):

- Rechaza un `endpoint` más largo que el tope (2048 caracteres). `text` no acota, y un endpoint de
  10 MB es un vector de abuso de almacenamiento.
- Rechaza un `endpoint` que no sea una URL `https`.
- Rechaza la suscripción cuando el cliente ya tiene más de **10** suscripciones.
- El rechazo es un `4xx` con la forma `{ error: { code, message } }` y **no escribe nada**.

### S12 — Un cliente borrado no recibe push

- La entrega **no** alcanza a un cliente con `deleted_at` informado: la resolución del cliente en
  la entrega excluye los borrados lógicos.
- El barrido elimina las suscripciones de los clientes con `deleted_at` informado.

## Restricciones

- **Un trigger de cron nuevo no es posible** (S9). Nada de este trabajo agrega `triggers.crons`.
- **No se toca `workers/automation/src/index.ts` ni `workers/communication/src/index.ts` desde las
  unidades**: son del padre (el cableado).
- **No se corre `prettier --write`** sobre ningún archivo tocado. 270 archivos del repo violan
  prettier y CI no lo exige; aplicarlo infla el diff y rompe un test de contrato.
- Las migraciones son manuales y se registran en
  `packages/db/drizzle/meta/_applied-outside-drizzle.json` con su `hash` y sus evidencias.
- `drizzle-kit migrate` está prohibido en este repo.
- Todo índice nuevo va en el callback extra-config de su tabla **y** en `INDEXED_TABLES` +
  `INDEX_NAMES` + el export nombrado de `packages/db/src/indexes.ts` + el re-export de
  `packages/db/src/index.ts` + el par binding→nombre en `packages/db/src/index.test.ts`.
- Todo artefacto técnico en inglés. Este documento está en español porque los documentos ODD del
  repo lo están.

## Criterio de aceptación

- **F3 (targeting correctness)**: una campaña para el local A **nunca** alcanza a un suscriptor del
  local B. Una campaña por radio incluye los locales previstos y excluye los adyacentes que quedan
  fuera del radio. Un local de otro tenant nunca aparece. Un local sin coordenadas nunca aparece.
- **F4**: un `message_log` de push es visible en el historial y en el dashboard. Una suscripción
  entrega y su `last_seen_at` avanza. Una suscripción de 200 días se borra; una de 10 días no. Un
  cliente borrado no recibe push y su suscripción desaparece en el barrido. Un endpoint de 3000
  caracteres es rechazado sin escribir nada.

## Tareas

| ID | Specs | Ruta | Descripción |
|---|---|---|---|
| T1 | S1 | inline (padre) | Migración `0017`: `checkins.branch_id`, índice de `customer_events.branch_id`, índice de `push_subscriptions.last_seen_at`; esquema, registro de índices, `_journal.json`, `_applied-outside-drizzle.json` |
| T2 | S3 | inline (padre) | Constantes `PUSH_CAMPAIGN_REQUESTED` y `CUSTOMER_CHECKED_IN` en `@vyloop/event-bus` + los dos schemas en el schema-registry + sus tests |
| T3 | S3, S5 | delegada | `workers/communication/src/campaign-routes.ts` + test: la API de campañas |
| T4 | S4 | delegada | `packages/db/src/proximity.ts` + test: haversine, celdas vecinas, locales en radio |
| T5 | S5, S6 | delegada | `workers/communication/src/push-campaigns.ts` + test: resolución de la audiencia y entrega |
| T6 | S1, S2 | delegada | `workers/growth`: `branch_id` en el check-in, `customer_events` con local, publicación de `CustomerCheckedIn` |
| T7 | S7 | delegada | `workers/communication/src/push-delivery.ts`: `last_seen_at` al entregar |
| T8 | S8, S12 | delegada | `workers/communication/src/subscription-maintenance.ts` + test: el barrido |
| T9 | S9 | inline (padre) | Cableado: binding de service en `automation`, dispatch desde su cron, export `scheduled` en comunicación |
| T10 | S10 | delegada | `workers/communication/src/delivery-stats.ts` + test: el dashboard; y el filtro por canal del historial |
| T11 | S11 | delegada | `workers/communication/src/push-routes.ts`: topes y validaciones de la suscripción |
| T12 | S12 | delegada | La entrega no alcanza clientes con `deleted_at` |
| T13 | — | inline (padre) | Cableado de rutas y eventos, verificación completa, commits por unidad, PR |

## Superficies de edición (disjuntas entre unidades)

**Padre (T1, T2, T9, T13)** — nadie más los toca:
`packages/db/src/schema.ts` · `packages/db/src/indexes.ts` · `packages/db/src/index.ts` ·
`packages/db/src/index.test.ts` · `packages/db/drizzle/0017_*.sql` ·
`packages/db/drizzle/meta/_journal.json` · `packages/db/drizzle/meta/_applied-outside-drizzle.json` ·
`packages/event-bus/src/index.ts` · `packages/event-bus/src/index.test.ts` ·
`packages/schema-registry/src/index.ts` · `packages/schema-registry/scripts/register-schemas.ts` ·
`workers/communication/src/index.ts` · `workers/communication/src/event-handler.ts` ·
`workers/automation/wrangler.jsonc` · `workers/automation/src/helpers.ts` ·
`workers/automation/src/index.ts` · `workers/automation/src/cron-handler.ts` ·
`workers/growth/wrangler.jsonc` · `workers/growth/src/helpers.ts`

**Unidad F3 (T3, T4, T5, T6)**:
`workers/communication/src/campaign-routes.ts` (+ test) · `workers/communication/src/push-campaigns.ts`
(+ test) · `packages/db/src/proximity.ts` (+ test) · `workers/growth/src/routes.ts` (+ test)

**Unidad F4 (T7, T8, T10, T11, T12)**:
`workers/communication/src/push-delivery.ts` (+ test) ·
`workers/communication/src/subscription-maintenance.ts` (+ test) ·
`workers/communication/src/delivery-stats.ts` (+ test) · `workers/communication/src/push-routes.ts`
(+ test) · `workers/communication/src/routes.ts` (+ test)

## Log

### L1 — 2026-10-20 (petición del usuario, verbatim)

> "lo de "F3 (triggers de proximidad) y F4 (hardening)", puedes aplicarlo sin mi intervension?,
> te autorizo a hacer la implementacion, recuerda dejarlo en un PR, cosa de yo revisarlo antes de
> lanzarlo a produccion"

> "te dejo en automatico corriendo, voy a dormir"

**Consecuencia operativa:** la implementación se hace sin preguntas al usuario. Las decisiones
abiertas del plan (§13) se resuelven con su default documentado: Q1 no (los triggers son los de
§3, sin geofencing en background), Q2 branch-targeted **y** radius (el radio se resuelve sobre
locales, nunca sobre la posición del cliente), Q3 no (las rutas de push no entran al contrato
OpenAPI público), Q4 180 días, Q5 fuera de alcance.

**Desviaciones respecto del plan, y por qué** (verificadas contra el código, nosupuestas):

1. `RewardAvailableAtBranch` **no** se implementa en este lote. `rewards` no tiene dimensión de
   local (`packages/db/src/schema.ts:853`), así que el trigger necesita otra vertical —una columna
   de local en `rewards` y un productor en el camino de auto-otorgamiento— que no es la proximidad
   que F3 tiene que demostrar, y su gate (targeting correctness) no la cubre. Queda anotado en
   *Deferred*.
2. La audiencia por local **no** existía como dato. El plan asumía que `customer_events.branch_id`
   "ya existe"; existe la columna, pero nadie la escribe. Por eso S1 y S2 **construyen** la
   asociación en lugar de consultarla. Sin eso, la campaña de F3 no llegaría a nadie.
3. El barrido de F4 **no** usa un cron trigger propio: la cuenta está en 5/5. Se despacha desde
   el cron del `automation`, con el precedente del sweep de la wallet.
