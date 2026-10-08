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
POST /v1/loyalty/passes/resolve
{ "member_code": "ABC-1234" }

→ 200 { "known": true,  "customer_id": "...", "display_name": "..." }
→ 200 { "known": false }
```

Siempre 200. Un `known: false` es información para el cajero, no un veto.

**B. Registrar la venta.** Sucede al final, cuando el pago se concreta.

```
POST /v1/loyalty/checkins
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

## Hecho — el terminal ya tiene credencial, y el limitador ya sabe qué plan estácobrando

**Estado:** implementado. Dos números de producto sin dueño, señalados abajo.

### Lo que se construyó

| | |
|---|---|
| `pos_terminals` | La credencial que sostiene al mostrador. `key_hash` es el secreto hasheado, `revoked_at` es `NULL` hasta que se revoca. Migración `0012`, **sin aplicar**. |
| `POST /v1/auth/pos/token` | Canjea esa credencial por un JWT con `sub: 'pos:<id>'`. Público, porque una caja no tiene sesión. |
| Claim `plan` | El token lo lleva para que el limitador pueda mirar el plan y no el rol. |
| `DEFAULT_LIMITS` | Ahora son `{ free: 60, premium: 600 }`, y el limitador keyea por plan. |

### El hallazgo: dos claves muertas y un cliente de pago cobrando como gratis

El limitador leía `config.limits[jwt.role]` y la tabla era `{ free, pro, business }`.

| | |
|---|---|
| `role` nunca fue una clave | Los roles reales son `admin`, `staff`, `cashier`, `customer`. El `??` se disparaba en **toda** request autenticada del sistema. |
| `pro` y `business` no existen | Los planes reales en `tenants.plan` son `free` (5 tenants) y `premium` (1 tenant). Ninguna otra fila del país podía tener esos planes. |
| El único tenant de pago pagaba como gratis | Resolvía por el `??` a `free`: **60 req/min, idéntico a un tenant que nunca ha pagado.** |

Eso último es el defecto por el que existe el cambio, y es el que `apps/gateway/src/rate-limit.test.ts`
atrapa por nombre: con el límite de `premium` bajado a 60, la suite se pone roja diciendo
`premium was refused at request 61`.

`premium` ahora tiene su propio número en una constante con nombre,
`PREMIUM_PLAN_LIMIT_PER_WINDOW = 600`, y **no está confirmado**. 600 es defendible — es el mismo
número que `WALLET_CALLBACK_LIMIT_PER_WINDOW`, elegido para una máquina en un comercio de pago, y
un terminal es eso — pero nadie lo decidió. Lo que sí está decidido es que es mayor que 60: cualquier
número mayor cierra el defecto. Si algún día se vende "API sin límite", este número es el que hay
que cambiar.

### Un token sin `plan` no vale más que un plan

`plan` es un claim **opcional**, a propósito. Agregarlo a la lista de claims requeridos de
`apps/gateway/src/middleware/auth.ts` respondería 401 a todos los tokens emitidos antes del deploy
—que son válidos por una hora— con un código de error que dice "token inválido", no "token viejo".

El costo de que sea opcional es que hay que hacerlo seguro en vez de imposible: un plan ausente o
desconocido resuelve a `UNKNOWN_PLAN_LIMIT_PER_WINDOW = 30`, **por debajo** de `free`. Si resolviera a
60, omitir el claim valdría exactamente lo mismo que ser el plan más barato, y omitir es gratis. Nunca
sin límite.

### Un mostrador no comparte contador con una persona

La clave del contador ahora incluye el `sub` para los sujetos `pos:`:

```
contador:     ratelimit:<businessId>:pos:<sub>:<endpoint>
todo lo demás: ratelimit:<businessId>:<endpoint>          ← igual que antes, byte por byte
```

Un comercio con dos cajas y un operador no tiene un presupuesto: tiene tres clientes distintos. Los
humanos de un mismo comercio **siguen compartiendo un contador**, y eso es deliberado — es un techo por
tenant, y partirlo por usuario multiplicaría por el tamaño del staff la cantidad de presupuesto que un
tenant puede gastar.

### `POS_PLANS` — decisión de producto, no confirmada

Definido en `workers/identity/src/auth.ts` como una constante sola, para que cambiarla sea una línea:

```ts
export const POS_PLANS: readonly string[] = ['premium'];
```

**Sin confirmar.** La hipótesis es la del enunciado: un plan avanzado puede incluir POS, el básico no.
`['premium']` y no `[]` a propósito: una lista vacía sería la respuesta prudente y también volvería
todo el feature inalcanzable — ningún tenant podría emitir un `pos:`, el exchange no se podría probar
de punta a punta, y el guard de las dos rutas de mostrador nunca tendría caso positivo. **Una puerta
que no se puede abrir no se puede probar.**

El gate se evalúa **en cada canje**, no al crear la terminal: un tenant degradado deja de poder renovar
su credencial de inmediato, sin que nadie tenga que acordarse de qué filas revocar.

### Secretos: hasheados, mostrados una vez

`key_hash` se escribe con `hashPassword` y se verifica con `verifyPassword` — **el mismo mecanismo de
`users.password_hash`**, no una segunda implementación. `password.ts` existe exactamente porque tres
copias de un PBKDF2 son tres lugares donde un parámetro se deriva. Canje una credencial cuesta una
PBKDF2 de 100k iteraciones, que es más trabajo del que necesita un secreto aleatorio de alta entropía,
y se paga igual: un esquema de credenciales, no dos.

Un secreto desconocido y una terminal revuelta responden **el mismo status y el mismo código**. Una
respuesta distinta para "revocada" responde también "este id existe", que es la mitad del trabajo de
enumerar terminales. El refusal por plan sí tiene código propio (`POS_PLAN_REQUIRED`), porque no es un
secreto —el comercio sabe en qué plan está— y "por qué no me funciona mi terminal" es una pregunta que
una persona va a hacer en voz alta.

### Lo que NO está, y hay que saber

- **El registro de una terminal no existe.** Nada en el repositorio crea una fila en `pos_terminals`.
  El camino de verificación está completo, así que cuando aparezca el escritor el canje funciona sin
  tocarlo; pero hoy `POST /v1/auth/pos/token` es inalcanzable en la práctica.
- **Una terminal de un tenant degradado conserva su token hasta que expira.** Aceptado. El canje
  siguiente ya es rechazado, así que la ventana es el TTL del token (1 hora), no un agujero. No se
  implementó revocación de tokens ya emitidos, y no se nota: es exactamente lo que ya hace el resto del
  sistema con sus JWT.
- **El exchange no tiene límite anónimo todavía.** `/v1/auth/*` es prefijo público y el limitador no
  limita lo que no está en `ANONYMOUS_LIMITS`, así que esto es un endpoint público que corre una PBKDF2
  por intento. La entrada falta en `apps/gateway/src/index.ts:184`, fuera de la superficie de este
  cambio.
- **`pos_terminals` no tiene índice.** La única consulta es el canje, que busca por primary key. La
  consulta que lo pediría —"qué terminales tiene este comercio"— no la ejecuta nadie todavía. Cuando
  exista, el índice va en `schema.ts` **y** la tabla entra en `INDEXED_TABLES` en `indexes.ts`, en el
  mismo cambio: `migration-sql.test.ts` exige que los `CREATE INDEX` de la historia sean exactamente lo
  que ese registro reporta.
- **Hueco conocido en growth, no arreglado aquí.** `requireOperatorRole` rechazaba solo el rol
  `customer`, así que el token de una terminal lo satisfacía en `POST /v1/loyalty/points/assign`: una
  caja podía asignar puntos directo y saltarse la regla de acumulación que `POST /v1/loyalty/checkins`
  existe para aplicar. **Resuelto** — ver "Un token de mostrador ya no es un operador" más abajo.

## Resuelto — un token de mostrador ya no es un operador

> Estado: cerrado. Se conserva el registro de la decisión, no la pregunta.

**Origen:** el hueco que `POST /v1/auth/pos/token` dejó abierto al emitir `sub: 'pos:<terminalId>'`.

`requireOperatorRole` denegaba por **exclusión**: rechazaba `isCustomerRole(auth)` y pasaba todo lo
demás. Un sujeto mostrador no es un customer, así que pasaba. Con el canje de token ya existente, ese
token no era hipotético — una caja se autenticaba una vez por arranque y quedaba con una credencial
que `POST /v1/loyalty/points/assign` aceptaba. El resultado era una escalada de privilegio: la
terminal mandaba `points` y el saldo se acreditaba sin pasar por la regla de acumulación del tenant.

### Qué se decidió

**Dos preguntas, no una lista de roles permitidos.** `requireOperatorRole` ahora pregunta dos cosas —
`isCustomerRole(auth) || isCounterSubject(auth)`— y sigue sin ser una allow-list.

Eso es lo que hay que justificar, porque "preguntar en vez de listar" era el argumento del guard
original y ahora hay dos preguntas. La segunda no lo debiuta:

- **El marcador es el subject, no el rol.** `role` es texto libre que `issueToken` nunca enumera, así
  que preguntar por `role === 'pos'` sería exactamente la allow-list que este archivo evita. Se usa el
  `isCounterSubject` que ya existe, tal cual: una segunda definición de "qué es un mostrador" escrita
  al lado sería la forma de que las dos mitades del archivo dejen de coincidir.
- **La respuesta es idéntica para las dos clases de sujeto.** Mismo status, mismo
  `OPERATOR_ROLE_REQUIRED`, mismo mensaje. Un código por clase de sujeto convertiría el rechazo en un
  inventario de qué clases existen y cuáles no — lo único que una guarda sobre una credencial que no
  reconoce no puede filtrar. Se lee cero, se escribe cero, y el guard corre antes del parseo del body.
- **Dos preguntas siguen fallando *abiertas*.** Un cuarto tipo de sujeto que nadie pensó en preguntar
  pasa, donde una lista fallaría *cerrada*. Es un costo real y se paga a propósito: un tipo nuevo
  necesita su pregunta agregada, y el mostrador es lo que ese costo compró.

### Lo que NO cambió

`requireCounterSubject`, `isCounterSubject`, `COUNTER_SUBJECT_PREFIX` y `COUNTER_SUBJECT_REQUIRED`
intactos, y `POST /v1/loyalty/checkins` y `POST /v1/loyalty/passes/resolve` siguen aceptando
mostradores con sus status codes de siempre. La negación es en las rutas de operador; las dos rutas
de mostrador no se tocan.

### Lo que hay que arreglar aparte

El docblock de `POS_SCOPES` en `workers/identity/src/index.ts` sigue describiendo este hueco como
"deliberadamente no resuelto aquí". Ya es falso y ningún test lo detecta, porque nadie lo afirma.

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

---

## Hecho — el backlog de créditos ya se puede ver

**Estado:** `scripts/check-checkin-backlog.mjs` + `pnpm db:checkin-backlog`.

Mientras haya una venta registrada sin acreditar, el número existía en la base pero nadie lo miraba.
Ahora es un comando.

```
  Vyloop checkin credit backlog
  ------------------------------------------------------------
  [PENDING] 3 sale(s) recorded without points
     oldest: 2 d
     money on hold: $259.00

     terminal path (self-heals on retry): 2
     manual path  (nothing retries it)  : 1

     by merchant
       Café Central                3 pending     1 stuck  $259.00  oldest 2 d

     manual entries needing a human (no retry will ever arrive)
       177f463a-…  Café Central  BK-MANUAL-1  $99.00  40 min
```

Sale con `1` si hay algo pendiente (`--report` fuerza `0`), así que sirve directo como alarma.

### Lo que el script NO hace, y por qué

**No acredita nada.** No es una omisión: `POST /v1/loyalty/checkins` ya drena el backlog. Cuando una
request choca por `(business_id, payment_id)` y encuentra una fila con `points` en `NULL`, vuelve a
correr el crédito (`workers/growth/src/routes.ts`, rama del retry). Un terminal que cumpla su
contrato de reintento vacía el backlog solo.

Así que la respuesta correcta a un backlog no vacío **no es "drenarlo a mano"** — es
*"averiguar por qué no llegan los reintentos"*.

Agregar un segundo camino de acreditación sería además un riesgo de corrección, no una simple
redundancia: `creditCheckin` resuelve la config del programa y el tier del cliente **en el momento
del cargo**, y una copia se liberaría a divergir del original igual que el preview del POS divergió
del cargo una vez. Un camino que es dueño del crédito vale más que dos que cada uno dice serlo.

### Las dos clases de pendiente no son la misma falla

| | Qué la resuelve |
|---|---|
| `payment_id IS NOT NULL` — el terminal reportó una venta cobrada | Un reintento, por contrato |
| `payment_id IS NULL` — una persona la registró desde el dashboard | **Nada.** No hay parte externo que reenvíe, y la vía manual tampoco tiene clave de dedupe |

La segunda es la que justifica que el script exista: la primera se cura sola, así que contarla como
problema entrenaría al operador a ignorar el reporte.

### Read-only como hecho, no como supuesto

Mismo contrato que el gate de drift: pone `default_transaction_read_only = on` y después lo
**verifica** con `SHOW`, porque una sesión que aceptara escrituras en silencio volvería "este script
nunca escribe" una suposición en vez de un hecho. Y una base inalcanzable es un **fallo**, no un
reporte vacío: un backlog limpio leído de una base que no se pudo abrir es indistinguible de uno
real.

### Lo que falta para cerrar esto del todo

El script ve los créditos que **no se acreditaron**. No ve las ventas que **nunca llegaron** — para eso
haría falta un poll contra Mercado Pago, y **no hay cliente de MP en el repo todavía**: eso depende
de la integración que se está haciendo aparte. Es la mitad que falta, y es la que hace falta.

---

### Corregido — los endpoints eran inalcanzables por el gateway

**Estado:** cerrado. Los dos endpoints se movieron bajo `/v1/loyalty/`.

La primera versión de esta etapa los registró como `POST /v1/checkins` y `POST /v1/passes/resolve`.
Funcionaban — handler completo, 24 tests en verde, deploy a producción — y **no los llamaba nadie**,
porque `routerMiddleware` responde **404** para cualquier `/v1/*` que ningún prefijo de `ROUTE_MAP`
reclame. No hace fall-through: es un 404 duro servido por el gateway. `ROUTE_MAP` solo tenía
`/v1/loyalty` y `/v1/growth`, así que ninguna de las dos rutas matcheaba.

El síntoma es indistinguible de "la ruta no existe", que es por lo que el worker no lo puede ver:
**sus tests pasan igual.**

Es la tercera vez que esta clase de bug aparece en este repo, y las dos anteriores están escritas en
`apps/gateway/src/router.ts:39-43` y `apps/gateway/src/support.ts:126`.

**Decisión:** mover bajo el prefijo existente, no agregar entradas a `ROUTE_MAP`. Agregarlas habría
sido un arreglo que deja la fragilidad intacta y suma dos prefijos más donde esconderse.

**Guard:** `apps/gateway/src/wrangler-route-reachability.contract.test.ts` lee
`workers/growth/src/routes.ts` como texto y exige que toda ruta registrada resuelva a `growth` vía
`matchRoute`. Falla nombrando el path y el motivo, porque "inalcanzable" a secas manda al próximo a
mirar el worker en vez de `ROUTE_MAP`.

Verificado: reintroducir el bug pone el guard en rojo nombrando `/v1/checkins`; restaurado, en verde.

#### El guard ahora cubre los siete workers con rutas

La primera versión miraba solo `workers/growth`, que es donde había pasado el bug. Eso cubre el
siguiente bug **por suerte**, no por diseño — y `identity` tiene **tres** prefijos en `ROUTE_MAP`,
más superficie alcanzable que `growth`.

La regla ahora es por worker: `matchRoute(path)?.binding === <ese worker>`. Si un worker gana un
segundo prefijo después, el guard sigue funcionando sin editarlo.

| Worker | Prefijos en `ROUTE_MAP` | Rutas |
|---|---|---|
| `identity` | `/v1/auth`, `/v1/me`, `/v1/businesses` | 7 |
| `customer` | `/v1/customers` | 8 |
| `growth` | `/v1/loyalty`, `/v1/growth` | 16 |
| `wallet` | `/v1/wallet` | 5 |
| `communication` | `/v1/communication` | 6 |
| `analytics` | `/v1/analytics` | 2 |
| `automation` | `/v1/automation` | 1 |

`compliance` tiene worker y binding pero **cero rutas** — queda fuera de la tabla, no afirmado como
vacío, porque un conjunto vacío vuelve verdadero cualquier "todo es alcanzable" sin comprobar nada.

#### Tres cosas que aparecieron al generalizarlo

**El registro se hace con dos nombres distintos.** `identity` y `analytics` registran con
`app.<method>`, el resto con `router.<method>`. Un extractor que matchee un solo nombre lee **cero
rutas** en la mitad de la flota — y un guard que lee cero rutas pasa en verde. Por eso hay una
asercion que verifica que el extractor leyó algo, por worker.

**Dos rutas quedan fuera de `/v1/` y no están rotas.** `/health` de `automation` y dos `/webhook` de
`communication`. `routerMiddleware` se monta en `app.use('/v1/*', …)`, así que nunca llegan a
`matchRoute` — son endpoints directos del worker. El de Meta tiene que ser la URL con la que se
configuró a Meta, no una ruta del gateway. La regla se limita a `/v1/` y el conjunto excluido se
afirma explícitamente, en vez de filtrarse en silencio.

**El conjunto guardado se re-deriva del disco en cada corrida.** La única forma en que un guard de
alcance se encoge en silencio es una tabla a la que le falta un worker nuevo.

Verificado: inyectar una ruta sin enrutar en `analytics` pone el guard en rojo nombrando el path;
restaurada, en verde. Ninguna ruta de ningún worker falla hoy.

#### Lo que el guard todavía no cubre

| | |
|---|---|
| Colisión de prefijos | `matchRoute` hace `startsWith` **sin frontera de segmento**: `/v1/loyalty-admin` matchea `/v1/loyalty`. Hoy no existe tal ruta y **no hay ningún prefijo que sea prefijo de otro**, así que es riesgo latente, no bug. Endurecer `matchRoute` a frontera de segmento es una decisión aparte: cambiaría el matching de toda la superficie `/v1/`. |
| `/v1/automation` no sirve nada | El prefijo enruta a `automation`, que solo registra `/health`. Un 404 ahí es el `app.notFound` del worker, no el del gateway — mismo código, otro archivo. |

---

### Corregido — las dos rutas del mostrador no tenían guarda

**Estado:** cerrado. `requireCounterSubject` en `workers/growth/src/helpers.ts`, en las dos rutas.

`POST /v1/loyalty/passes/resolve` y `POST /v1/loyalty/checkins` llamaban a **ninguna** guarda. Las otras
ocho rutas de escritura de Growth llaman a `requireOperatorRole`; estas dos, no.

No es una omisión menor: `POST /v1/auth/customer/token` es **público** y emite `role: 'customer'`, así que
cualquier cliente podía resolver un `member_code` arbitrario y después reportar una venta inventada
contra él — con `amount_cents` elegido por el cliente y convertido en puntos por la regla del tenant. La
misma clase de agujero que `requireOperatorRole` cerró en `points/assign`, cerrado aquí por el mismo
método: en la ruta, no solo en la que se explotó.

#### El mostrador es un tercer sujeto, no "un operador que no es cliente"

`requireOperatorRole` habría sido la guarda equivocada por una razón de producto antes que de seguridad:
el terminal **nunca manda puntos**, manda `amount_cents` y la regla del tenant decide cuánto vale. Y el
dashboard —que sí manda puntos— llama a `points/assign`, no a estas rutas. Así que las dos rutas nunca
tienen un llamador legítimo en el navegador del cajero, y los dos sujetos tienen que quedar distinguibles
en las dos direcciones.

#### La identidad del mostrador es un prefijo en el `sub`, porque el terminal autentica una vez

`issueToken` se reutiliza **sin cambios**: sin claim nuevo, sin tocar `JwtClaims`. El terminal recibe
`sub: 'pos:<uuid>'` y `role: 'terminal'`.

| | |
|---|---|
| Regla | `userId.startsWith('pos:')` **y** el resto no vacío |
| Código | `COUNTER_SUBJECT_REQUIRED` (403) |

El separador es la decisión: un `startsWith('pos')` a secas lo cumplirían `postmaster-3`, `pos-7` y
`POS-2`, así que la guarda le entregaría el sujeto del mostrador a cualquier emisor que por casualidad
eligiera una palabra que empieza con esas tres letras. `:` no puede aparecer en un uuid, y hoy **todo**
sujeto que emite el issuer es un uuid (`customers.global_id` del cliente, `users.id` del staff), así que
el espacio de nombres es inalcanzable por accidente. `pos:` solo, sin terminal detrás, también se
rechaza.

La pregunta es una sola —"¿es un sujeto mostrador?"— y no una lista de roles permitidos, por el motivo
que el docblock de `requireOperatorRole` ya da: `role` es texto libre que el issuer no enumera, así que
preguntar por el rol `terminal` sería inventar un vocabulario y negarle el paso a todo rol que una
integración futura trajera.

Lee cero, escribe cero, y responde igual haya programa o no, exista el `member_code` o no: no hay oráculo
de existencia para sondear el tenant. Va **antes** del parseo del body, así que un llamador no autorizado
no hace que la ruta trabaje en su nombre.

#### Lo que sigue abierto a propósito

- **La tabla `pos_terminals` y el endpoint de identidad no existen todavía.** No hay registro de terminales:
  lo que sigue al prefijo es opaco, no se busca ni se compara con nada. La guarda no puede distinguir un
  terminal real de uno inventado, y por eso el prefijo solo lo emite el issuer. El canje de token por uno
  de mostrador llega cuando existan terminales reales.
- **La vía manual del §"La vía manual (el emulador de hoy)"** dice que un cajero autenticado en el
  dashboard registra un checkin sin `payment_id`. Con esta guarda eso ya no es posible por esta ruta: el
  dashboard llama `points/assign`, que sigue siendo de operador. El texto de arriba describe el diseño
  original, no la superficie actual.

---

---

## Cerrado — docblock obsoleto, y por qué importaba que mintiera

**Estado:** cerrado. `workers/identity/src/index.ts`, el docblock de `POS_SCOPES`.

Decía *"Known gap, deliberately not solved here"*, y que un token de mostrador *"podía asignar puntos
directamente, salteando la regla del tenant"*. Las dos frases eran falsas desde el día anterior, y el
problema no era que estuvieran desactualizadas: era que **no había test que afirmara ese texto**, así
que nada fallaba. Un comentario que miente sin delatar que miente es peor que uno que no existe,
porque el próximo lo lee como estado del sistema.

Ahora dice por qué un token de mostrador **no** puede asignar puntos, y por qué emitir el token y
cerrar esa brecha fueron el mismo cambio: la segunda es lo que hace seguro publicar el primero.

---

## Cerrado — `matchRoute` ahora exige frontera de segmento

**Estado:** cerrado. `apps/gateway/src/router.ts` y un `router.test.ts` nuevo.

### La decisión

**Sí, endurecerlo.** El razonamiento:

`/v1/loyalty` es un **namespace**, no la cadena de caracteres que lo abre. Con `startsWith` a secas,
`/v1/loyalty-admin` resolvía a `growth` y se le reenviaba — así que el 404 venía del archivo
equivocado y se leía como *"ese servicio no tiene esa ruta"* en vez de *"nada reclama este path"*.

No existe tal ruta hoy, y por eso dormía: cada ruta de la flota es exactamente su prefijo o sigue con
`/`. Eso es una propiedad de la **lista de rutas de hoy**, no del router. Y el fallo que produciría es
justo el que este módulo ya tiene en su historial — dos ocurrencias documentadas arriba, y la tercera
fue `POST /v1/checkins`.

La frontera se impone en el router en vez de confiar en la lista de rutas.

### Lo que el guard de alcanzabilidad NO cubría

**Este es el punto que hizo que la fix necesitara su propio test.** Revertir `matchRoute` a
`startsWith` deja las 24 aserciones del guard en verde: toda ruta registrada resuelve bajo las dos
reglas. El guard prueba que no	matchee de más**; la frontera es sobre no matchee de más.

Un guard que solo mira el lado que ya funciona es un guard que no puede ver la mitad del problema.

`router.test.ts` afirma las dos direcciones: los paths que la frontera debe rechazar
(`/v1/loyalty-admin`, `/v1/authx/login`, `/v1/customers-v2/me`) y los que debe aceptar, más una
propiedad sobre `ROUTE_MAP` mismo — cada prefijo resuelve en sí y en un hijo, lo que también detecta
un prefijo con barra final. Revertir el código pone **6 tests en rojo**.

---

### Sigue abierto

- La **Etapa 0b**: implementada y en `main` (PR #202 y #203). Migraciones `0011` y `0012` aplicadas a
  mano en la rama `production` de Neon, cada una con su fila en `drizzle.__drizzle_migrations`. Gate
  de drift en verde.
- **El registro de terminales.** El emisor existe (`POST /v1/auth/pos/token`) y la tabla `pos_terminals`
  ya está aplicada, pero **nadie crea filas**. No hay forma de obtener un token `pos:`: falta la
  pantalla o el endpoint donde el comercio registra su terminal y recibe el secreto **una sola vez**
  (queda hasheado en la base). Es lo único que bloquea la prueba de punta a punta.
- **Docblock obsoleto en `workers/identity/src/index.ts`.** Cerrado — ver "Docblock obsoleto,
  corregido" arriba.
- ~~**Decidir si `matchRoute` exige frontera de segmento.~~** Cerrado — ver "`matchRoute` ahora
  exige frontera de segmento" arriba.
- **El poll contra Mercado Pago** — la mitad que falta del backlog. Depende del cliente de MP.
- **Límite de tasa para un sujeto mostrador.** `DEFAULT_LIMITS` tiene `free`/`pro`/`business`, y un rol
  `terminal` cae en `?? config.limits.free ?? 60` — 60 requests/min. Un mostrador real con la cola de
  gente esperando lo supera en un momento. Hay que decidir el límite por rol `terminal` cuando exista el
  emisor, o el rate limiter va a frenar mostradores reales.
- `sslmode=require` y el bumpee a `pg` v9 — lo de arriba.
- Dependabot #198 (vitest 5), #199 (next vs overrides), #201 (pin de react) — esperando decisión.
- Los límites logísticos del `verify` — sin relación con lo anterior.