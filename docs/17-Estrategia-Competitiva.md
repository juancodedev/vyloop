# Estrategia competitiva — Vyloop vs. Loyalia

> **Fecha**: 7 de octubre de 2026
> **Estado**: `[ESTADO]: Draft` — documento de decisión, no de implementación
> **Alcance**: a quién le vendemos, qué nos diferencia, qué construimos como valor agregado, y qué queda en el radar.
> **Depende de**: [`docs/analisis-loyalia.md`](./analisis-loyalia.md) — el levantamiento funcional de Loyalia. Este documento no repite ese levantamiento; lo usa como insumo.
> **Verificación**: todo lo que dice "tenemos" está contrastado contra `packages/db/src/schema.ts`, `workers/*/src/routes.ts` y `apps/`. Varios docs del repo están desactualizados respecto del código; donde importa, se cita el archivo real.

---

## 0. Tesis

> **Loyalia le vende al dueño del café que quiere premiar clientes.**
> **Vyloop tiene que venderle al operador que tiene 40 locales, o al desarrollador que necesita construir encima.**

No es una diferencia de features. Es una diferencia de **qué se vende**. Loyalia es un producto de puntos con buena distribución. Somos una infraestructura con capacidades que todavía no exponemos.

---

## 1. El problema: el pricing está desalineado del segmento

| | Vyloop | Loyalia |
|---|---|---|
| Free | 150 clientes | 1 programa · 1 sucursal · 100 clientes |
| Pro | 2.000 clientes · **1 sucursal** · ~$32/mes | 3 programas · 2 sucursales · 3 usuarios · **$14/mes** |
| Business | 10.000 clientes · 5 sucursales · ~$65/mes **por sucursal** | 8 programas · 8 sucursales · 15 usuarios · **$24/mes** |
| Enterprise / Negocio | Ilimitado · desde ~$160/mes | 15 programas · 15 sucursales · 25 usuarios · **$39/mes** |

Fuente Vyloop: `docs/03-Business-Model.md:22-27`. Fuente Loyalia: panel de `/merchants/plan` y landing.

**Traducción a costo por sucursal:**

| | Costo por sucursal |
|---|---|
| Loyalia Negocio | $39 / 15 = **~$2,60** |
| Vyloop Business | **~$65** |

Estamos **~25x más caros por sucursal**, con menos sucursales incluidas. Y en Pro somos 1,3x más caros con 8x menos sucursales incluidas.

### Consecuencias

1. **No se puede competir en "el sello digital barato" para PyME de 1 local.** Ellos tienen ~1.000 negocios declarados, un POS integrado (Loyverse) y precio en MXN. Nosotros tenemos 6 tenants y precio en USD/CLP.
2. **No se puede competir en cadenas sin re-preciquear.** Si el segmento objetivo es 5-50 locales, el modelo actual cobra 8x lo que cobra Loyalia. O cambia el pricing, o no vamos por ahí.
3. **El pricing por sucursal es punitivo justo en el segmento que más nos conviene.** Una cadena de 5 sucursales paga $325/mes con nosotros y $39/mes con ellos.

Esto no se arregla construyendo. Se arregla decidiendo el segmento y re-preciqueando el tier Business.

---

## 2. Tres segmentos, uno defendible

| Segmento | Qué necesita | ¿Ellos lo sirven? | ¿Lo ganamos? |
|---|---|---|---|
| **A. PyME 1-5 locales, dueño no técnico, quiere premiar** | Sello digital barato, WhatsApp, POS integrado, no pensar | **Sí.** Es su mercado. Precio MXN, Loyverse, 12 verticales SEO | **No.** Perdemos en distribución, precio y integración |
| **B. Cadenas 5-50 locales** | Analítica consolidada, roles por local, campañas por sucursal, lealtad que viaja entre locales | **Mal.** Su "sucursal" es lat/lng para geo. No hay vista consolidada ni roles | **Con re-preciqueo.** Pero hoy cobramos 8x |
| **C. Integradores, franchises, coalitions** | API, webhooks, SDK, capacidad de componer | **No. No tienen API.** Ni REST, ni GraphQL, ni webhooks, ni SDK | **Sí.** Es el único terreno donde su producto no compite |

**Decisión recomendada:** A como marketing de entrada (free tier generoso, funil), **C como foco comercial**, B solo después de re-preciquear.

El free tier es la palanca: los suyos dan 1 programa y 100 clientes con analítica bloqueada. El nuestro da 150 clientes. Un free tier que **sí sirve** convierte; uno que no sirve, solo captura.

---

## 3. Qué nos diferencia de verdad

Verificado contra el código, no contra adjetivos.

### 3.1 Somos integrables; ellos no

| | Vyloop | Loyalia |
|---|---|---|
| API REST | Sí, versionada `/v1` | **No** |
| GraphQL | Sí | No |
| Webhooks | 7 eventos, HTTPS, HMAC-SHA256 en `X-Vyloop-Signature`, reintentos 1s/5s/30s/5min/30min (`docs/08:274-288`) | No |
| API keys con scopes | Sí (`read:customers`, `write:loyalty`, `admin:billing`…) | No |
| SDK | Node.js publicado | No |
| Schema de eventos | Schema Registry en KV, valida antes del bus | No |

Un POS, una plataforma de e-commerce o una agencia **no puede construir sobre Loyalia**. Ese es el diferencial más fuerte que tenemos y el más barato de exponer.

### 3.2 Tenemos event sourcing; ellos no

`customer_events` es un log inmutable y fuente de verdad del perfil 360° (`docs/06:35`). El estado actual es una proyección, no una columna mutada.

Eso es lo que permite *derivar* cosas — analítica, cross-merchant, scoring, IA — sin reescribir el sistema. Loyalia muta columnas: cada feature nueva es un `if` más en un monolito Rails.

### 3.3 El comensal es un usuario, no un token

| | Vyloop | Loyalia |
|---|---|---|
| Identidad | `customers` con `global_id`, `member_code`, login por teléfono + `businessSlug` | `qr_token` de 22 chars en la URL y en un QR impreso |
| Consentimiento | Tabla `consents` con tipo, `granted_at`, `revoked_at`, `ip_address` | No hay consentimiento registrado |
| Aislamiento | `business_id` + RLS definido con tests (`packages/db/src/rls.ts`) | Filtro de aplicación, sin nada más |
| Revocación | `deletedAt`, `revokedAt` en consentimientos | No existe. Cookie del comensal con `exp` en 2046 |

Su modelo está bien para el caso de uso que persigue, y es una deuda de seguridad para cualquier cosa mayor.

### 3.4 Ya tenemos cross-merchant en el schema

`cross_loyalty_alliances` (`earn_rate_ab`, `earn_rate_both`, `status`) y `referrals` (`referrer_id`, `referred_id`, `points_awarded`) existen en `packages/db/src/schema.ts`. Modelados, no construidos. Ver §6.

### 3.5 Google Wallet funciona de punta a punta

Clase aprobada, 3 pases en `issued`, callbacks resueltos (el bug de `ECv2SigningOnly`: prefijo de 2 bytes big-endian en vez de 4 bytes little-endian, `docs/14:254-273`). Es el único wallet que funciona hoy.

---

## 4. Dónde Loyalia es estructuralmente inferior

| Debilidad | Evidencia |
|---|---|
| **Cero API.** Nada de REST, GraphQL, webhooks o SDK. Nada. | `loyalia.app` expone `/merchants/*` solo con sesión de cookie |
| **Un solo POS, hardcodeado** | `Merchants/Integrations/Loyverse` es la única integración de POS. OAuth contra un proveedor |
| **No hay coalitions** | Nada en el producto ni en el schema que comparta balance entre comercios |
| **No hay cliente final** | El comensal recibe un pase y un QR en el mostrador. No tiene perfil, historial, ni lugar al que volver |
| **Geo-notificación no se sostiene** | `vapidPublicKey: null` en todas las páginas; el `pass.json` no trae `locations` ni `relevantDate`. PassKit no puede geofencear. La landing lo promete igual |
| **Multi-sucursal decorativo** | `branches` en su schema es nombre + dirección. No hay vista consolidada, ni roles por local, ni campañas por sucursal |
| **Analítica bloqueada en free** | `/merchants/insights` y `/merchants/reports` devuelven `locked: true` |
| **Soporte = formulario** | 5 categorías, email y WhatsApp. Sin base de conocimiento |
| **Motor rígido** | 5 motores hardcodeados en un JSON blob. El cambio de motor en un borrador no commitea (`docs/analisis-loyalia.md` §14.4) |
| **Sin API de integradores = sin clientes de plataforma** | Consecuencia directa de lo anterior |

---

## 5. Iniciativas de valor agregado

Una línea cada una. El diseño de las dos más importantes está en §6 y §7.

| # | Iniciativa | Esfuerzo | Impacto | Bloqueada por |
|---|---|---|---|---|
| 1 | **API real y documentada** — Swagger, ejemplos, "integrar en 30 min" | **Bajo** (la base ya existe) | **Alto** — único lock-in legítimo | Falta `POST /v1/events/purchase` (§7) |
| 2 | **Cross-loyalty / coalitions** | Medio (tabla existe, falta motor) | **Muy alto** — nadie lo tiene | Modelo de tenant (§6) |
| 3 | **Migración de datos** — importador de clientes, saldos e historial | Medio | **Alto en ventas** — mata la objeción #1 | Formato de import acordable con el cliente |
| 4 | **Merchant viendo a sus clientes** — por programa, con actividad y notas | Bajo-medio | **Alto** — es table stakes | Ya está en backlog: `docs/14:248` |
| 5 | **Self-serve del comensal** — perfil, recompensas, historial | Medio (existe en customer-web) | Alto — canal de retención que ellos no tienen | Que el botón de wallet se conecte al backend |
| 6 | **Pass en tiempo real** — barrido programado + idempotencia | Bajo (diseño listo) | Medio — diferencia, no transforma | Decisión de Apple Wallet |

**El orden importa.** Sin #4 no somos una plataforma, somos un pase. Sin #2 no tenemos nada que un comercio solitario no pueda conseguir en otro lado. Sin #1 no hay composición.

---

## 6. Cross-loyalty / coalitions

> **El diferenciador estructural más fuerte que tenemos.** Ya está la tabla. No lo tiene nadie.

### 6.1 Qué es

Una coalition es **N comercios que comparten un solo programa de lealtad**. El comensal gana en cualquiera de los 40 y canjea en cualquiera de los 40. Una sola tarjeta, un solo QR, un solo pase.

Ejemplo: una asociación de barberías de un barrio, un centro comercial, una franchise, una cooperativa de cafeterías. Todos compiten entre ellos por el mismo cliente; la coalition los alinea.

### 6.2 Por qué es la jugada

1. **No lo tiene nadie.** LoyaltyLion es single-merchant. Captain's Co-op (EEUU) lo hizo como red cerrada de franchises, no como infraestructura abierta. Loyalia, tampoco.
2. **Ata al comprador correcto.** Quien onboardea 40 comercios es el *organizador* de la coalition — un mall, una asociación, una franchise, una agencia. Es un buyer distinto al dueño del café, con ticket mucho mayor y con presupuesto.
3. **Lock-in por proyecto.** Onboardear 40 comercios es un proyecto de meses. Salir es otro igual. Es el switching cost más honesto que existe.
4. **Activa el flywheel que ya declaramos.** `docs/02-Market-Research.md` §3 define la estrategia como "más negocios → más datos → mejores modelos → más retención → más cross-loyalty". Cross-loyalty es el eslabón que convierte el flywheel en algo que se auto-sostiene.
5. **Ataca nuestra parte plana.** Hoy no tenemos nada que un comercio solitario no pueda conseguir de otro lado.

### 6.3 El problema de diseño: hoy no se puede expresar

`loyalty_programs.business_id` es `UNIQUE` (`packages/db/src/schema.ts:226`). Un comercio = un programa = una clase de Google Wallet. **Una coalition no cabe en el modelo actual.**

Dos formas de resolverlo:

| Opción | Qué es | Qué habilita | Costo |
|---|---|---|---|
| **A. Tenant tipo "coalition"** | La coalition es un `tenant` con su propio programa y su propia clase de wallet. Los comercios miembros se unen con una tabla de pertenencia | Balance compartido, un pase, un QR. **Es el cross-loyalty real** | Alto: nuevo tipo de tenant, tabla `coalition_members`, analytics por coalición y por comercio, repartición del canje |
| **B. `cross_loyalty_alliances` entre tenants** | Dos tenants independientes que se cruzan puntos, cada uno con su propio saldo | Cross-earn sin balance compartido | Bajo — la tabla ya existe |

**Opción B es lo que el schema modela hoy** (`earn_rate_ab`, `earn_rate_both`). Es cross-earn, no cross-loyalty. Es más débil pero es un primer paso real y barato.

**Recomendación: B ahora, A después.** B da un caso de uso real (cafetería A + panadería B de mismo dueño, o alliance entre dos negocios que ya se conocen) con una migración chica. A es el producto completo y necesita la decisión de pricing de §1 resuelta antes.

### 6.4 Requisitos técnicos que B y A necesitan

| Requisito | Estado actual |
|---|---|
| `programId` en la transacción de puntos | **No existe.** `points_transactions` no tiene columna de programa — solo `business_id`. Con un programa por tenant no hacía falta; con varios, sí |
| Atribución por comercio emisor | `points_transactions.branchId` existe. Bien. Falta el programa destino |
| Un pase por coalition | `tenantWalletPrograms.tenantId` es PK → una clase por tenant. Si la coalition es el tenant, funciona |
| Analítica por commerce **y** por coalition | Todo el analytics actual es por tenant |
| Economía del reparto | **Sin definir.** ¿Qué porcentaje del canje va al comercio que lo emite? Sin esto la coalition no se cierra. Es pregunta de negocio, no de código |
| RLS | Una coalition tiene que poder leer clientes de varios `business_id` sin romper el aislamiento. Choca con el diseño actual de una variable por query |

### 6.5 Preguntas abiertas de Cross-loyalty

1. ¿Quién es el tenant: la coalition o cada comercio?
2. ¿Cómo se reparte el canje entre los miembros?
3. ¿Un comensal puede estar en una coalition y en el programa propio de un comercio a la vez?
4. ¿La coalition paga suscripción, o cada miembro?
5. ¿Quién es el responsable de la soporte cuando un comensal dice "no meIMATE credited"?

---

## 7. Integraciones

> **Una integración no es una feature. Es un arma de ventas y un mecanismo de switching cost.**

### 7.1 Los dos sentidos, y solo uno nos diferencia

| Sentido | Qué es | Loyalia | Vyloop |
|---|---|---|---|
| **Inbound** (consumimos) | El negocio conecta su POS / e-commerce y la lealtad se vuelve automática | 1: Loyverse, OAuth, match por el email del ticket | Ninguna. Hay un POS emulado |
| **Outbound** (nos consumen) | Otros construyen sobre nuestra API | **Nada. Cero.** | REST + GraphQL + webhooks HMAC + API keys + SDK |

El inbound es table stakes del SMB. El outbound es el terreno vacío.

### 7.2 Por qué una integración es el mejor argumento de venta

1. **"Conectamos tu POS"** elimina la objeción de tener que escanear. El cajero no hace nada nuevo.
2. **"Integra en 30 minutos"** abre el canal de desarrolladores y agencias, que es el segmento C.
3. **Switching cost.** Si tu POS habla con nuestra API y emite `PurchaseCompleted` a nuestro bus, cambiar de proveedor de lealtad es un proyecto, no un click.
4. **Datos.** Una integración trae el ticket, no solo un número. Trae precio, hora, método de pago. Eso alimenta ticket promedio, RFM y churn.

### 7.3 El bloqueo duro: el evento raíz no tiene dueño

`docs/08-API-Design.md:135` define `POST /v1/events/purchase` como "Compra completada desde POS o sistema externo". Pero:

- El Schema Registry tiene `CustomerRegistered` y `PointsAssigned`. **No `PurchaseCompleted`**.
- Después del fix, **esa ruta devolvió 404** (`docs/14-Backlog.md:41-44, 56-58`).
- `docs/06` consume `PurchaseCompleted` en Growth y lo pone en el mapa de comunicación, pero **ningún dominio lo publica**. "No somos POS" (`docs/01:56`) implica que nadie lo emite.

**Es el evento raíz del sistema y no tiene dueño.** Ninguna integración inbound es posible hasta que exista un contrato de "compra completada" con un publicador definido. Esto es P0 para integraciones y P0 para el modo manual del POS emulado.

### 7.4 Roadmap de integraciones

| Etapa | Qué | Depende de |
|---|---|---|
| **1. Manual** | QR + escáner web + POS emulado. Prueba el flujo end-to-end sin integraciones | `POST /v1/checkins` (no existe). Requiere §8 items P0 |
| **2. Un POS real** | El del mercado objetivo. Chile: Flow, Bsale. México: iPos, Bling | Etapa 1 + `POST /v1/events/purchase` + `programId` |
| **3. Genérica** | Cualquier POS/ecommerce postea `PurchaseCompleted` al webhook de ingesta | Etapa 2 probada |
| **4. Outbound** | Swagger, SDKs (Node, Python), webhooks públicos, programa de partners | Etapa 3 + `docs/14:319-321` |

**Stage 4 es el movimiento de plataforma.** Y es donde se decide si Vyloop es un producto o una infraestructura.

### 7.5 Requisitos técnicos

| Requisito | Estado |
|---|---|
| Contrato `PurchaseCompleted` con publicador definido | **No existe** |
| `POST /v1/events/purchase` funcionando | **404** |
| `programId` en `points_transactions` | **No existe** |
| `member_code` generado en el alta, no al pedir el pase | Solo 4 de 12 clientes lo tienen (`docs/14:170-176`) |
| Email del comensal capturado | **NULL en los 12** de producción (`docs/14:147-159`). Y es la llave del match con el ticket |
| Idempotencia de ingesta (POS reintentando) | La regla existe (`docs/17:39-40`); falta el mecanismo |
| `branches` con lat/lng | **No existe** (`schema.ts:80-90`). Un POS que devuelve ubicación de tienda no se puede geocodificar |
| `customers.metadata` JSONB para lo que no tiene columna | **Existe** (`schema.ts:134`), con índice GIN. Buen punto de landings |
| Outbox para no perder eventos entre DB y bus | **No diseñado** |

---

## 8. Etapa siguiente — radar

> Ningún ítem de abajo tiene fecha. Es el backlog que hay que tener a mano antes de arrancar la siguiente etapa.

### 8.1 P0 — Sin esto no hay producto

- [ ] **N programas por comercio.** `loyalty_programs.businessId` es `UNIQUE` (`schema.ts:226`). El eje del modelo de negocio es N programas con clientes ilimitados
- [ ] **Mecánica de sellos.** `grep -i stamp packages/db/src/schema.ts` → 0 resultados. Hoy el motor es 100% puntos
- [ ] **Tabla de membresía** (cliente × programa): `stamps`, `goal`, `balance`, `expires_at`, `expiration_status`, `reward_ready`, `last_visit_at`. No existe. Solo `customers.currentTierId`
- [ ] **Check-in.** `workers/growth/src/routes.ts` expone config, tiers, points/assign, rewards. **Ningún endpoint de check-in ni de escaneo.** `grep -ri "check_in\|scanner"` → 0 resultados reales
- [ ] **`member_code` en el alta**, no al pedir el pase
- [ ] **El frontend llama a `GET /v1/wallet/pass`.** El backend ya emite 3 pases en `issued` y nadie los pide (`docs/14:163-168`)
- [ ] **Definir y publicar `PurchaseCompleted`.** Ningún dominio lo emite; la ruta devuelve 404
- [ ] **`programId` en `points_transactions`**
- [ ] **RLS desplegado.** `createRlsPolicies()` (`packages/db/src/rls.ts:91`) solo se referencia en tests. Y `packages/db/src/migration-sql.test.ts:215` **falla si la migración contiene `ENABLE ROW LEVEL SECURITY`** — el test bloquea el aislamiento que el diseño declara
- [ ] **Capturar el email del comensal.** Es la llave del match con el ticket de POS, y el único canal de recuperación si el login pasa a OTP

### 8.2 P1 — El producto del merchant

- [ ] **El merchant ve a sus clientes por programa**: lista con contadores, ficha con memberships, feed de actividad, notas internas
- [ ] **Registrar visita con monto, nota y foto de ticket.** Con la foto de ticket como flag por comercio (fraud)
- [ ] **Puerta de entrada pública.** `/p/{slug}` responde 200 y **no tiene un solo link** (`docs/14:180-188`)
- [ ] **`branches` con lat/lng y radio.** Sin esto no hay geo-nada, aunque `docs/10:286,445` ya habla de "radio de notificaciones cercanas"
- [ ] **Automatizaciones por programa.** Cumpleaños, win-back, por vencer, vencida, compra/gracias, recompensa lista, geo. `workers/automation/src/routes.ts` expone **solo `/health`**; las tablas `workflows` y `workflow_executions` ya existen
- [ ] **Onboarding del comercio**: checklist de primeros pasos, countdown de trial, wizard con **vista previa del pase en vivo**
- [ ] **Registrar una compra vía API** con idempotencia y outbox

### 8.3 P2 — Plataforma

- [ ] **Swagger + ejemplos** para `POST /v1/events/purchase` y el resto
- [ ] **SDK Python**
- [ ] **Primer POS real** del mercado objetivo
- [ ] **Pass en tiempo real**: barrido programado + proyección idempotente
- [ ] **Canje de recompensas en customer-web** y push notifications
- [ ] **Apple Wallet** — decisión de negocio, ver §10
- [ ] **Cross-loyalty opción B**: activar `cross_loyalty_alliances` con `programId`
- [ ] **Migración de datos**: importador de clientes y saldos

### 8.4 Higiene que bloquea

- [ ] **Ningún job de CI aplica migraciones.** Se aplican a mano (`docs/17:45-46`)
- [ ] **El build no es un gate.** Un flag de compatibility inventado pasó lint, typecheck y tests enteros, y el deploy lo rechazó (`TASKS.md:181-187`)
- [ ] **`customer-web` sin tests end-to-end**, con `passWithNoTests` activo (`docs/11:832`)
- [ ] **Docs desactualizados**: `docs/09` no lista `rewards`/`reward_grants` (sí existen), `docs/17` tiene el nombre de la base de producción equivocado (`docs/18:231-236` lo corrige)
- [ ] **`request_id` se corta en el borde gateway/worker**: un 500 nacido en un worker llega al cliente sin correlación con el log (`docs/14:301-307`)

---

## 9. Qué NO hacer

| No | Por qué |
|---|---|
| Competir en precio por sucursal | Nos mata. 25x su costo por sucursal (§1) |
| Clonar el wizard de 5 pasos | Es UI, no moat. Nos ata a 5 motores rígidos. Mejor: mecánicas tipadas + tabla `program_mechanics`, y agregar motores sin migración |
| 12 verticales SEO ahora | Es canal, no producto. No se gana una carrera de SEO con 6 tenants |
| Clonar kiosco o WhatsApp pushes | Es commodity. Lo hacemos igual, no diferencia |
| Gatear la analítica en free | Conversion killer. Loyalia lo hace y es un argumento en su contra |
| Construir loyalty como "puntos con más features" | Es la posición donde ellos ganan. Cualquier feature de puntos es imitable y nos deja en el mismo terreno |

---

## 10. Decisiones abiertas

Ninguna se resuelve leyendo código. Todas son de producto y negocio.

### 10.1 ¿A quién le vendemos?

Es la primera decisión porque el pricing la fuerza. Si es B (cadenas), el tier Business a $65/sucursal nos deja fuera de su propio juego. Si es C (integradores), el free tier es tool de lead y el tier Business se re-diseña alrededor de programas, no de sucursales.

### 10.2 ¿Entramos a Apple Wallet?

Vyloop tiene un **contract test que lo prohíbe explícitamente** (`apps/customer-web/app/delivery.contract.test.ts:6`: *"The Stage 7 checklist asks for confirmation that there is no Apple Wallet or..."*). Loyalia construye todo su posicionamiento sobre Apple Wallet.

La parte difícil ya se resolvió y es razonable (firma PKCS#7, assets a @1x/@2x/@3x, `webServiceURL` + `authenticationToken`, barcode = token del cliente). El costo de entrada es la revisión del pass type y una cuenta de Apple Developer ($99/año). El costo de seguir sin él es quedarse fuera del wallet que usa la mayoría del mercado Latinoamericano en iPhone.

### 10.3 ¿Cross-loyalty es opción A o B?

A (coalition como tenant) es el producto real. B (cross-earn entre tenants) es el primer paso barato. A necesita el modelo de tenant y el reparto de canje resueltos.

### 10.4 ¿El token del comensal es identidad o credencial?

Loyalia lo trata como credencial: 22 chars, sin rotación, en un QR físico. Si nosotros hacemos lo mismo heredamos el problema. Si es identidad, hay que definir consentimiento, portabilidad y borrado — y `consents` ya da el lugar donde escribirlo.

---

## 11. Documentos relacionados

| Documento | Qué aporta |
|---|---|
| [`docs/analisis-loyalia.md`](./analisis-loyalia.md) | El levantamiento funcional: 5 motores, modelo de datos, el `.pkpass` desarmado, 7 automatizaciones, integraciones, marketing, y los gaps verificados contra nuestro código |
| [`docs/02-Market-Research.md`](./02-Market-Research.md) | El flywheel y las 3 olas de mercado. La §3 de este documento es la versión operativa de su §3 |
| [`docs/03-Business-Model.md`](./03-Business-Model.md) | Tiers y add-ons. Necesita re-preciqueo según §1 |
| [`docs/04-Product-Requirements.md`](./04-Product-Requirements.md) | Qué está fuera de scope. "Integración automática con POS" está fuera del PMV, y es el bloqueante de §7 |
| [`docs/09-Database-Design.md`](./09-Database-Design.md) | DDL documentado. Desactualizado respecto de `packages/db/src/schema.ts` |
| [`docs/14-Backlog.md`](./14-Backlog.md) | El backlog real. Su checklist de fases 1-4 está desactualizado; los bloques "Bloquean la experiencia del comensal" y "Fase 2+" sí vigentes |
| [`docs/17-Developer-Onboarding.md`](./17-Developer-Onboarding.md) | Las 7 reglas de oro. La regla 3 ("nunca un fork por país") y la 6 ("verificá la salida antes de creerla") son las que más aplican a este documento |