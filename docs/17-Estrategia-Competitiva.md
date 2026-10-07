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

## 1. Pricing — decisión, y por qué

### 1.1 El diagnóstico

El pricing anterior cobraba **por sucursal**, y eso lo dejaba 25x arriba del competidor en el único segmento que nos convaría.

| | Vyloop (antes) | Loyalia |
|---|---|---|
| Free | 150 clientes | 1 programa · 1 sucursal · 100 clientes |
| Pro | 2.000 clientes · **1 sucursal** · ~$32/mes | 3 programas · 2 sucursales · 3 usuarios · **$14/mes** |
| Business | 10.000 clientes · 5 sucursales · ~$65/mes **por sucursal** | 8 programas · 8 sucursales · 15 usuarios · **$24/mes** |
| Enterprise | Ilimitado · desde ~$160/mes | 15 programas · 15 sucursales · 25 usuarios · **$39/mes** |

Costo por sucursal: Loyalia Negocio **~$2,60** ($39 / 15). Vyloop Business **~$65**. Una cadena de 5 locales pagaba $325/mes con nosotros y $39/mes con ellos.

### 1.2 La causa: la unidad de cobro estaba equivocada

Cobrar por sucursales asume que el valor crece con el tamaño físico del negocio. Para un café, el valor es tener **un** programa de sellos. Para una cadena de 5 locales, el valor es tener **cinco programas distintos** — uno por línea de negocio — más analítica consolidada y roles por local.

El programa es el negocio. La sucursal es el punto de venta.

Loyalia ya cobra por programas (1 / 3 / 8 / 15) y no por clientes. El **"el límite de los planes es de programas de lealtad activos, no de clientes"** de su FAQ no es un truco de copy: es la consecuencia de haber elegido la misma unidad.

### 1.3 Decisión: cobrar por programas

| Plan | Programas | Sucursales | Usuarios | Clientes | Precio |
|---|---|---|---|---|---|
| **Free** | 1 | 1 | 1 | 100 | $0 |
| **Starter** | 3 | 2 | 3 | ilimitados | **~$14** |
| **Pro** | 8 | 8 | 15 | ilimitados | **~$24** |
| **Business** | 15 | 15 | 25 | ilimitados | **~$39** |
| **Coalition** | 1 programa compartido, N comercios miembros | — | por miembro | ilimitados | a definir (§6.5) |
| **Enterprise** | ilimitados | ilimitadas | ilimitados | ilimitados | a definir |

Features de los tres pagados: `push` · `geo_notifications` · `advanced_analytics` · `reports` · `customer_deletion`.

### 1.4 Qué compra y qué pierde cada decisión

| | Efecto |
|---|---|
| **Le gana al SMB al competitor en su propio precio** | Starter a ~$14 con 3 programas. Donde antes Lose de precio, ahora empatan |
| **Arregla el tier Business para cadenas** | 15 programas a ~$39. Una cadena de 5 locales con 5 programas paga $39, no $325 |
| **Deja espacio para coalitions** | Un programa compartido es el producto. Se cobra aparte, y a un precio que hoy nadie puede poner porque nadie lo ofrece |
| **Deja de castigar crecimiento** | Un comercio con 3 sucursales y 1 programa paga lo mismo que uno con 1. Antes pagaba 3x |

### 1.5 La regla que acompaña el pricing

> **El precio sigue a la capacidad entregada, no al revés.**

Con coalitions + API + multi-sucursal entregados, el precio correcto es **claramente más alto** que el del competidor, porque no hay sustituto. Matchear su precio le dice al comprador "somos intercambiables", y ahí elige por el POS integrado y el SEO, y perdemos.

Lo que no se puede hacer es cobrar por features futuras. Hoy no cobramos premium por coalitions porque coalitions no existen (§8, Etapa 8).

### 1.6 Tres decisiones que acompañan

1. **No gatear la analítica en free.** El competidor sí lo hace y es argumento en su contra. Un free tier que **sí sirve** convierte; uno que no sirve, solo captura.
2. **Moneda base USD, MXN en la capa de config.** Ya decidido en `docs/03-Business-Model.md:29`, y la regla "nunca un fork por país" (`docs/17-Developer-Onboarding.md:33`) lo prohíbe en el código.
3. **Sin límite de clientes desde Starter.** Es lo que hace Loyalia y es lo que hace que el free tier convierta. El costo lo pagamos en soporte, no en el plan.

### 1.7 Impacto en schema

El pricing por programas **exige** N programas por comercio. Hoy `loyalty_programs.business_id` es `UNIQUE` (`packages/db/src/schema.ts:226`). Sin esa migración, este pricing no es implementable.

Es el mismo P0 de `docs/analisis-loyalia.md` §16.1 y el mismo prerrequisito de Etapa 8. **No hay precio nuevo sin schema nuevo.**

---

## 2. Tres segmentos, uno defendible

| Segmento | Qué necesita | ¿Loyalia lo sirve? | ¿Lo ganamos? |
|---|---|---|---|
| **A. PyME 1-5 locales, dueño no técnico, quiere premiar** | Sello digital barato, WhatsApp, POS integrado, no pensar | **Sí.** Es su mercado. Precio MXN, Loyverse, 12 verticales SEO | **Empate técnico, no en distribución.** Con el pricing de §1 dejamos de perder por precio. Perdemos por distribución: ~1.000 negocios declarados contra 6 tenants |
| **B. Cadenas 5-50 locales** | Analítica consolidada, roles por local, campañas por sucursal, lealtad que viaja entre locales | **Mal.** Su "sucursal" es lat/lng para geo. No hay vista consolidada ni roles | **Sí, con el pricing de §1.** Solo falta la vista consolidada y los roles (Etapa 6) |
| **C. Integradores, franchises, coalitions** | API, webhooks, SDK, capacidad de componer | **No. No tienen API.** Ni REST, ni GraphQL, ni webhooks, ni SDK | **Sí.** Es el único terreno donde su producto no compite |

**Decisión:** A como marketing de entrada y puerta del free tier. **B y C como foco comercial.** B se abre con la migración de N programas; C se abre con la Etapa 1.

B y C comparten el mismo bloqueante: **N programas por comercio**. Es la migración que desbloquea el pricing, las cadenas y las coalitions. Una sola migración, tres segmentos.

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

Clase aprobada, 3 pases en `issued`, callbacks resueltos (el bug de `ECv2SigningOnly`: prefijo de 2 bytes big-endian en vez de 4 bytes little-endian, `docs/14:254-273`), y **`customer-web` lo pide en mount** — `apps/customer-web/app/components/wallet-card.tsx` llama a `GET /v1/wallet/pass` con `lib/wallet.ts` mapeando cada rechazo a su propio mensaje. Es el único wallet que funciona hoy, y funciona de punta a punta.

> `docs/14-Backlog.md:163-168` afirma que el frontend nunca llama al backend. **Es falso y quedó viejo.** El gap estaba cerrado.

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

| # | Iniciativa | Esfuerzo | Impacto | Etapa | Bloqueada por |
|---|---|---|---|---|---|
| 1 | **API real y documentada** — `PurchaseCompleted`, Swagger, "integrar en 30 min" | **Bajo** (las rutas ya existen) | **Máximo** — único lock-in legítimo | **1** | Nadie publica el evento raíz |
| 2 | **Cross-loyalty / coalitions** | Medio | **Máximo** — nadie lo tiene | **8** | `UNIQUE` en `loyalty_programs` |
| 3 | **Merchant viendo a sus clientes** — por programa, actividad y notas | Bajo-medio | **Alto** — table stakes | **2** | Nada. Ya está en backlog |
| 4 | **Pass en tiempo real** — barrido programado + idempotencia | **Bajo** (`sweep.ts` ya existe) | **Alto** — sin esto el saldo se congela | **3** | Un handler `scheduled` |
| 5 | **Self-serve del comensal** — recompensas e historial | Medio (existe en customer-web) | Alto — canal que ellos no tienen | **4** | Canje en la web |
| 6 | **Multi-sucursal** — vista consolidada, roles por local, `lat`/`lng` | Medio-alto | Medio-alto — abre el segmento B | **6** | RLS |
| 7 | **Migración de datos** — importador de clientes, saldos e historial | Medio | **Alto en ventas** — mata la objeción #1 | transversal | Formato acordable con el cliente |
| 8 | **Geo-notificaciones** | Medio | **Bajo** — el competidor lo promete y no se sostiene | **7** | `lat`/`lng` + un canal de ubicación |

**El orden importa.** Sin #3 no somos una plataforma, somos un pase. Sin #2 no tenemos nada que un comercio solitario no pueda conseguir en otro lado. Sin #1 no hay composición.

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

> Sección reescrita el 7 de octubre de 2026 con documentación oficial de Mercado Pago verificada. Cambia el diseño: `PurchaseCompleted` deja de ser una etapa más y pasa a ser el eje.

### 7.0 Tesis: un contrato, muchos productores

La acumulación no necesita una mecánica nueva — ya existe (`POST /v1/loyalty/points/assign`). Lo que falta es **el canal**. Y la forma correcta de resolverlo es un solo contrato con muchos productores:

```
escáner manual ────┐
orden MP (point)   │
orden MP (qr)      ├─→ PurchaseCompleted ─→ Growth ─→ points_transactions ─→ pase
webhook TUU        │
pedido e-commerce  │
POS emulado        ┘
```

Es la regla *"API interna == API pública"* (`docs/05-System-Design-Document.md:104`) aplicada a la entrada. Un POS es un productor de eventos más, no una integración a parte.

---

### 7.1 Las tres formas de integrar, y cuál hacemos

Mercado Pago, TUU y SumUp ofrecen tres mecanismos distintos. No son equivalentes.

| Forma | Qué implica | Decisión |
|---|---|---|
| **(a) Instalar nuestra app dentro del terminal** | App Android en el aparato de otro, con su ciclo de revisión y su flota de dispositivos | **No, por ahora.** Investigar en §7.4 |
| **(b) Nosotros le mandamos el cobro al terminal** | Si caemos, el comercio no cobra. Pasamos a estar en el camino del pago | **Sí, pero no es ser procesador de pagos.** Ver la nota |
| **(c) El terminal cobra, nosotros escuchamos el webhook** | Cero dinero moviéndose, cero alcance PCI, cero liquidación | **Sí** |

**Sobre (b).** Crear una orden en Mercado Pago no es procesar pagos: nunca tocamos datos de tarjeta, el cobro ocurre en el terminal o en la app del cliente, y el dinero va a la cuenta del comercio. Es exactamente lo que hace cualquier plugin de PDV.

El riesgo es **operativo, no regulatorio**: si nuestro sistema está caído y el merchant depends de nosotros para generar la orden, no puede cobrar. Mitigación: el merchant siempre tiene su flujo manual y standalone como respaldo (`operating_mode: STANDALONE` existe justamente para eso). No queremos ser el único camino.

**Sobre (c) y la reconciliación.** La documentación de Mercado Pago es explícita: si la conexión se interrumpe antes de que salga el webhook, hay que **consultar el estado por API**. Un webhook solo no alcanza; hace falta un poll de reconciliación. Es la misma arquitectura idempotente que ya exige nuestra regla de trabajo.

---

### 7.2 El problema real no es el pago, es la identidad

El webhook devuelve el **monto** y un token de tarjeta. **No devuelve quién es el cliente.**

Ese es el cuello de botella de toda integración de lealtad, y explica por qué la de Loyalia hace match por el **correo del ticket**: es lo único que un POS entrega gratis.

Históricamente se resolvía con la opción (a) — nuestra app dentro del terminal, pidiendo el RUT en el momento del cobro. Es la mejor calidad de dato y la de mayor fricción.

**Pero Mercado Pago abre una cuarta vía que no exige instalar nada.**

---

### 7.3 La solución: `external_reference`

`POST /v1/orders` acepta un campo `external_reference` que **vuelve en el webhook**. Ese campo es el puente entre un pago y un cliente.

Dos restricciones que hay que respetar y que, por cierto, apuntan en la dirección correcta:

| Restricción | Lectura |
|---|---|
| Máximo 64 caracteres; solo letras, números, `-` y `_` | Cabe de sobra. No mandamos datos legibles |
| **"cannot contain PII data"** | **No podemos mandar el RUT ni el email del cliente.** Hay que mandar un token opaco |
| **Debe ser único por orden** | No sirve el `member_code` directo: es por cliente, no por orden. Hace falta un identificador por transacción |
| `X-Idempotency-Key` es **header obligatorio** | UUID v4 por orden. Encaja con nuestra regla de idempotencia |

#### Flujo completo

```
1. El cliente presenta su pase (o el cajero lo busca por nombre)
2. Nuestra app abre un `checkin` con UUID propio + `member_code` + `amount_cents`, status: pending
3. POST /v1/orders
     external_reference    = <nuestro UUID de checkin>
     X-Idempotency-Key     = <el mismo UUID>
     type                  = "point"   (la maquinita cobra)
                        |  = "qr"      (el cliente escanea un QR dinámico)
     transactions.payments[].amount = "<monto>"
     config.point.terminal_id       = <el terminal, id con formato TIPO__SERIAL>
     config.qr.mode                  = "dynamic" → devuelve qr_data EMVCo para renderizar
4. Guardamos `order_id` de Mercado Pago en el checkin
5. El cliente paga
6. Webhook de MP → buscamos por external_reference → ya sabemos QUIÉN y CUÁNTO
7. Growth calcula los puntos según la regla del tenant y los asigna
8. Poll de reconciliación para los webhooks perdidos
```

**El cajero no escribe nada. El cliente no escribe nada.** Y no necesitamos app dentro del terminal.

#### Por qué esto es mejor que el approach del competidor

La integración de Loyalia dice, textualmente, que "cada ticket cobrado cuente como **visita**". **Tiran el monto a la basura**: una compra de $3.000 y una de $500 dan el mismo sello.

Con `external_reference` tenemos el monto atado a un cliente, así que podemos hacer acumulación **por valor**. Eso es mejor para el comercio, e **imposible de replicar sin rehacer su integración**.

---

### 7.4 El lector del terminal — investigación abierta

> **Pendiente de investigación. Es la pregunta más abierta de esta sección.**

La intuición — *el terminal tiene lector, y con eso podría identificar al cliente* — **tiene respaldo**: Mercado Pago publica un **Third-Apps Integration Kit** ([`mercadopago/point-smartapp-demo-android`](https://github.com/mercadopago/point-smartapp-demo-android)) que expone hardware del terminal a apps de terceros, incluyendo explícitamente *"camera for barcode reading"*, impresoras y Bluetooth.

Se distribuye como `nativesdk-mainapp-X.X.X.aar` — una **biblioteca Android**, con su documentación y una app demo.

**Si esto funciona como parece, cambia el producto entero:** el lector del terminal **es** el escáner. El cliente muestra su pase de lealtad, la maquinita lo lee, y no hay ni cámara nuestra ni app que instalar ni cajero que tipee nada. El gesto es el intuitivo: "el cajero escanea tu tarjeta".

Pero son preguntas abiertas:

| # | Pregunta | Por qué importa |
|---|---|---|
| 1 | ¿El kit funciona en Chile, o es solo para Brasil? | El repositorio y la documentación consultados son de Brasil |
| 2 | ¿Requiere un proceso de aprobación o acuerdo comercial aparte? | Si hay que negociar, cambia el timeline entero |
| 3 | ¿Es compatible con Point Smart 2, o solo con los terminales de ese repo? | El modelo de terminal es el que usa el mercado chileno |
| 4 | ¿El terminal devuelve el contenido leído a nuestra app, o solo permite imprimir? | Si solo imprime, no sirve para identificar |
| 5 | ¿Se puede usar sin que nuestra app se haga cargo del flujo de cobro? | Si tenemos que manejar el cobro, volvemos a (b) con todos sus riesgos |
| 6 | ¿Cuánto cuesta mantener un `.aar` en el build? | Complejidad permanente de build y release |

Mientras no se respondan, **el plan no depende de esto**: `external_reference` (§7.3) funciona sin kit, y el escáner manual (Etapa 0) cubre el resto. El kit sería una mejora, no un requisito.

---

### 7.5 Mecánica de acumulación: `earn_by`, y quién calcula

Loyalia separa en su config `earn_by: "purchase" | "visit"`. Es la distinción correcta y hay que adoptarla, pero **como dos estrategias dentro de un motor**, no como dos modelos.

| Estrategia | Qué acumula | Para quién | Qué necesita |
|---|---|---|---|
| `visit` | Contador. "9 cafés y el 10 gratis" | Dueño de café, peluquería, gimnasio | Solo saber que hubo una visita |
| `purchase` | Puntos ∝ monto | Retail, restaurantes con ticket alto | Saber cuánto se gastó |

El canal determina la mecánica: **con integración de POS tenés el monto, así que `purchase` es el natural.** Con escáner manual solo sabés que hubo una visita, así que `visit` es lo honesto.

#### El hueco que hay que cerrar

Hoy la regla **no existe**:

```ts
// workers/growth/src/routes.ts:553
const effectivePoints = Math.floor(body.points * earnRate * tierMultiplier);
```

`earnRate` es un multiplicador escalar sobre un `points` que **calcula el caller**. No hay ninguna lógica de monto→puntos en ninguna parte del sistema.

La decisión a tomar es **quién la calcula**:

| | Quién calcula | Consecuencia |
|---|---|---|
| **A. El Growth, con la regla en config del tenant** | Nosotros | El merchant controla su programa. La regla es **configuración**, no fork de código — cumple la regla #3 |
| B. El POS manda puntos ya calculados | El integrador | El merchant pierde el control. Un TUU y un MP darían programas distintos |

**A es la correcta.** Y requiere, en `loyalty_programs`: `earn_by` y una regla del tipo `points_per_unit_amount` con su unidad.

---

### 7.6 Orden de vendors

**Mercado Pago primero**, aunque TUU sea técnicamente más flexible.

| | Mercado Pago | TUU | SumUp |
|---|---|---|---|
| App dentro del terminal | No (cerrado) | **Sí** — Inter-App en Android | No (cerrado) |
| Documentación | **Completa y pública** | Por.application | Global, orientada a nube |
| Autenticación multi-comercio | **OAuth para terceros** | — | — |
| `external_reference` | **Sí** | Sin verificar | Sin verificar |
| Volumen en Chile | Alto | Alto | Por confirmar |

**Por qué MP:** terminal cerrada significa que somos webhook puro — cero PCI, cero flota de dispositivos, cero revisión de app. Es server-to-server, que es exactamente nuestra forma (Cloudflare Workers). Y el **OAuth para integraciones de terceros** es el modelo que necesitamos: un SaaS multi-merchant opera *en nombre de cada comercio*, con sus propias credenciales.

**TUU es el de mejor dato y peor fricción.** Si ganamos una cadena que ya corre TUU, ahí sí tiene sentido el Inter-App.

**No elegir vendor todavía.** `PurchaseCompleted` debe ser neutral, con un envelope de vendor. Cuando llegue el webhook de MP es un problema de mapeo, no un rediseño. Es la regla #3 aplicada a vendors: si diseñamos alrededor del shape de Mercado Pago, TUU y SumUp se vuelven mapeos.

---

### 7.7 Estado verificado en nuestro repo

| Hallazgo | Dónde |
|---|---|
| `PurchaseCompleted` **no existe** en el Schema Registry | El registry tiene 6: `CustomerRegistered`, `PointsAssigned`, `RewardAutoGranted`, `RewardRedeemed`, `WhatsAppOutboundRequested`, `WorkflowTriggered` |
| **No hay endpoint entrante** para eventos externos | — |
| `points/assign` no tiene regla monto→puntos | `growth/src/routes.ts:553` |
| El Growth toma el **primer** programa con `limit(1)` | `routes.ts:522-524` — multi-programa ausente también en el código |
| `points_transactions` sin `programId` ni `amount_cents` | INSERT: business/customer/type/points/balance_after/reference_id/note |
| **El puente de identidad ya existe** | `customers.identityDoc` + `identityType` (`schema.ts:123-124`) |
| `branches` sin `lat`/`lng` | `schema.ts:80-90` — un webhook con dirección de tienda no se puede geocodificar |

`customers.identityDoc` es lo que cubre el approach (a) — el RUT que pide la app en el terminal.

---

### 7.8 Lo que NO hacemos

| No | Por qué |
|---|---|
| Procesar pagos | No movemos dinero ni tocamos datos de tarjeta. Crear una orden no es ser procesador |
| Ser el único camino de cobro del comercio | Downtime nuestro = merchant no cobra. `STANDALONE` siempre disponible |
| Diseñar `PurchaseCompleted` alrededor del payload de un vendor | El registry es nuestro contrato, no el de ellos |
| Depender del Third-Apps Kit | Está sin verificar en Chile (§7.4). Si funciona, es mejora, no requisito |
| Webhook sin poll de reconciliación | La propia doc de MP lo dice: si se cae la conexión, consultás por API |

---

### 7.9 Preguntas abiertas

1. **¿El Third-Apps Kit funciona en Chile?** (§7.4) — biggest unknown
2. **¿Cuál es el costo y el timeline de `merchant = OAuth` en Mercado Pago?** Multi-merchant sin esto es una integración por comercio
3. **¿Cómo se concilia un pago que our sistema nunca vio?** El poll de reconciliación es un endpoint nuestro que todavía no existe
4. **¿RUT o teléfono como llave de match en el flujo manual?** El RUT identifica a la persona; el teléfono, al contacto. Son cosas distintas y no deben mezclarse
5. **¿La regla `earn_by` se configura por programa o por merchant?** Si es por programa, es N programas primero
6. **¿SumUp tiene `external_reference`?** Sin verificar. Si no, el contrato neutral lo resuelve

---

## 8. Plan de trabajo — etapas futuras

> Ordenado por **valor**, no por esfuerzo. Donde el esfuerzo es bajo y el valor es alto, está marcado, porque esas se pueden adelantar.

### Cómo leer el plan

Cada etapa declara **por qué vale**, **qué desbloquea**, **qué falta**, y **cómo se sabe que terminó**.

Criterio de terminado (`docs/14-Backlog.md:330-336`): tests del caso principal y de los errores relevantes, endpoint documentado en Schema Registry, el comportamiento explicable en términos de valor, y revisión de un segundo par de ojos antes del merge.

**El orden tiene una restricción ganada:** el ítem más valioso (Cross-loyalty) es el último, porque está bloqueado por una decisión de schema que todavía no tomamos. Ver Etapa 8.

---

### Etapa 0 — El eslabón roto: acumular en el mostrador

**Valor: máximo.** El producto no existe sin esto.

| | |
|---|---|
| **Por qué** | El cliente registra ✅, pide su pase ✅, lo guarda ✅. **Pero nadie puede acumular nada en el mostrador.** Hoy solo existe `POST /v1/loyalty/points/assign`, que es una llamada de API. Todos los competidores compiten en "el cajero toca una vez" |
| **Reencuadre** | Con la arquitectura de §7, esta etapa es **el canal para negocios sin integración**, no el motor. Sigue siendo P0 porque la mayoría de las PyM tiene el terminal como simple lector de tarjeta y no hay API detrás. Pero la vía principal es la Etapa 1 |
| **Qué falta** | `POST /v1/checkins` con `{member_code, amount_cents, note, ticket_photo?}`. Generación de `member_code` en el alta. UI de escáner con búsqueda + cámara. Idempotencia de la mutación |
| **Esfuerzo** | Bajo-medio. La cámara es `getUserMedia` y un decoder; el guardado es una tabla y un evento |
| **Desbloquea** | El gatillo "compra" de la Etapa 4, y el merchant viendo a sus clientes (Etapa 2) |
| **Terminado cuando** | Un cajero autenticado escanea un pase real, la acumulación sube, el pase del cliente lo refleja, y un segundo escaneo del mismo evento no duplica nada |

Detalle que importa: en Loyalia el `barcode.message` del pase **es** el `qr_token` — un solo identificador para pase, membresía y escaneo. El equivalente más seguro acá es `member_code` con pepper (`MEMBER_CODE_PEPPER`, `docs/17-Developer-Onboarding.md:115-119`), porque un token adivinable impreso en un pase físico es robable.

---

### Etapa 1 — `PurchaseCompleted`: el contrato que abre el segmento C

**Valor: máximo. Abre integradores, coaliciones y el canal de agencias.**

| | |
|---|---|
| **Por qué** | Es lo único que el competidor **no tiene**: cero API. Y es el único lock-in legítimo: si el POS del cliente emite `PurchaseCompleted` a nuestro bus, cambiar de proveedor es un proyecto, no un click |
| **Diseño** | §7.3 — `external_reference` como puente de identidad, sin app en el terminal y sin que nadie escriba nada |
| **Qué falta** | ① Definir `PurchaseCompleted` en el Schema Registry **con un publicador**. Hoy `docs/06` lo consume y `docs/01:56` ("no somos POS") implica que nadie lo emite. ② Endpoint entrante de webhooks. ③ `programId` en `points_transactions`. ④ `checkins` con `mp_order_id` y `external_reference`. ⑤ Poll de reconciliación. ⑥ La regla `earn_by` (§7.5). ⑦ Swagger + ejemplos. ⑧ SDK Python |
| **Esfuerzo** | **Bajo-medio.** Las rutas y el motor ya existen; lo que falta es contrato, tabla y handlers. Es la etapa más grande de las baratas, y la que más desbloquea |
| **Desbloquea** | Mercado Pago (Etapa 6b), TUU, coaliciones (Etapa 8), el canal de agencies, y el gatillo "compra" |
| **Terminado cuando** | Una orden de Mercado Pago creada con `external_reference` = un checkin, pagada, notificada por webhook, deja el saldo del cliente correcto en el pase — y una notificación perdida se recupera por el poll sin duplicar puntos |

**Prerrequisito de esta etapa:** quitar el `UNIQUE` de `loyalty_programs.business_id`. Sin N programas no hay `programId` que resolver, y el pricing de §1.3 no existe.

---

### Etapa 1b — La regla de acumulación

**Valor: alto. Es lo que define el programa.**

| | |
|---|---|
| **Qué falta** | `earn_by` (`visit` \| `purchase`) y la regla de conversión, en `loyalty_programs` como config. Hoy la regla **no existe**: `earnRate` es un multiplicador escalar sobre un `points` que calcula el caller (`growth/src/routes.ts:553`) |
| **Decisión** | **El Growth calcula, con la regla en config del tenant.** Si el POS manda puntos ya calculados, el merchant pierde el control y cada vendor produciría programas distintos |
| **Esfuerzo** | Bajo |
| **Depende de** | N programas (Etapa 1) |
| **Terminado cuando** | Un merchant configura "1 punto por cada $100" y un checkin de $12.500 produce 125 puntos, sin código nuevo |

---

### Etapa 2 — El merchant ve a sus clientes

**Valor: alto. Table stakes. Barata.**

| | |
|---|---|
| **Por qué** | Sin esto no somos una plataforma, somos un pase. El merchant tiene un panel de clientes sin relación con sus programas. Es el circuito principal del competidor (`/merchants/customers` con contadores, ficha con memberships, `/merchants/cards/:id/members`, feed de actividad por tarjeta, notas internas) |
| **Qué falta** | Lista de clientes por programa, ficha con memberships, feed de actividad por programa, notas internas (no existe tabla; hay `points_transactions.note`, que es nota de transacción, no nota de cliente) |
| **Esfuerzo** | Bajo-medio. Son queries sobre tablas que ya existen |
| **Ya está anotado** | `docs/14-Backlog.md:248` |
| **Terminado cuando** | El merchant responde "¿quiénes tienen mi programa, qué gastó cada uno y cuándo fue su última visita" sin salir del panel |

---

### Etapa 3 — Pass en tiempo real

**Valor: alto. Barata.**

| | |
|---|---|
| **Por qué** | Hoy el pase solo se reconcilia cuando alguien pide `GET /v1/wallet/pass`. Un cliente que agrega el pase y nunca vuelve a abrir la web ve un saldo congelado. En una tarjeta de lealtad, **el valor es abrir el teléfono y ver el sello**. Si está viejo, la tarjeta está muerta |
| **Qué falta** | Handler `scheduled`. **Cero en el repo** — verificado, no hay ningún `worker.scheduled`. La lógica de barrido ya existe en `workers/wallet/src/sweep.ts` |
| **Esfuerzo** | **Bajo.** Es un cron sobre código que ya existe y que ya está diseñado para idempotencia |
| **Nota** | Es de las pocas donde el esfuerzo es bajo y el valor alto. Si hay que adelantar algo, es esto |
| **Terminado cuando** | Un sello registrado desde el escáner aparece en el pase del cliente sin que el cliente abra nada |

---

### Etapa 4 — Automatizaciones por programa

**Valor: alto. Es el motor de retención.**

| | |
|---|---|
| **Por qué** | El competidor tiene 7 gatillos por tarjeta, cada uno con su mensaje default escrito y vista previa del push. Es su promesa central ("haz que vuelvan") |
| **Qué falta** | `workers/automation/src/routes.ts` expone **solo `/health`**. Las tablas `workflows` y `workflow_executions` ya existen |
| **Esfuerzo** | Medio. No es greenfield: es query y handlers sobre el modelo de workflows que ya está |
| **Los 7 gatillos** | Cumpleaños (N días antes) · Win-back (N días sin visita) · Por vencer · Vencida · Compra/gracias · Recompensa lista · Geo (depende de Etapa 6) |
| **Terminado cuando** | Un workflow de cumpleaños dispara solo, registra su ejecución en `workflow_executions`, y es idempotente si se reprocesa |

Dos detalles del competidor que hay que copiar porque son baratos y valen: **el mensaje por defecto está escrito** (no es placeholder), y **la vista previa renderiza el push real** al editar. Un comercio que activa "Cumpleaños" y no toca nada debe mandar algo que suena a persona.

---

### Etapa 5 — RLS desplegado

**Valor: medio en features, máximo en riesgo.**

| | |
|---|---|
| **Por qué** | No es una feature, es deuda que se está pagando en riesgo. El aislamiento multi-tenant es **una promesa comercial** — `docs/03-Business-Model.md:46` vende Data Residency y aislamiento a Enterprise — y hoy depende de que cada handler se acuerde de filtrar por `businessId` |
| **Qué falta** | ① Llamar `createRlsPolicies()` en producción. Hoy solo se referencia en tests (`packages/db/src/rls.ts:91`). ② **Arreglar `packages/db/src/migration-sql.test.ts:215`, que falla si la migración contiene `ENABLE ROW LEVEL SECURITY`** — el test está bloqueando el aislamiento que el diseño declara. ③ Resolver las dos variables (`app.current_business_id` y `app.current_tenant_id`) que existen porque `customer_wallet_passes` y `tenant_wallet_programs` no tienen `business_id` |
| **Esfuerzo** | **Bajo**, pero hay que tocar el test primero y eso requiere criterio |
| **Desbloquea** | Enterprise, coalitions (un tenant que lee varios `business_id` choca con el diseño actual) |
| **Terminado cuando** | Un handler sin filtro explícito de `businessId` no puede devolver filas de otro comercio, y hay un test que lo demuestra |

---

### Etapa 6 — Multi-sucursal

**Valor: medio-alto. Abre el segmento B. El más caro de los medianos.**

| | |
|---|---|
| **Por qué** | El tier Business del pricing nuevo promete 15 programas y 15 sucursales. Sin vista consolidada ni roles por local, es un número en una tabla. Y el competidor escala mal acá: su "sucursal" es lat/lng para geo |
| **Qué falta** | ① **`lat`/`lng` en `branches`** — hoy son `id, businessId, name, address, city, country, timezone, isActive` (`schema.ts:80-90`). Habilita geocerca, geocodificación de integraciones y "restricción por sucursal". ② Vista consolidada de clientes y actividad. ③ Roles por local (el rol `cashier` existe en `users.role` sin superficie HTTP). ④ Campañas por sucursal |
| **Esfuerzo** | Medio-alto. Es la etapa más grande de las median |
| **Depende de** | Etapa 5 (RLS), para que un operador solo vea su local |
| **Terminado cuando** | Un operador de una sucursal ve solo sus clientes, y el dueño ve el consolidado con corte por local |

**Etapa 6b — Integraciones POS.** Va después de 6, no antes: una integración real necesita `branches` para geocodificar la tienda y `programId` para atribuir. Primera integración: la del mercado objetivo (Chile: Flow o Bsale; México: iPos o Bling). La ruta larga es genérica: cualquier POS postea `PurchaseCompleted` (Etapa 1).

---

### Etapa 7 — Geo-notificaciones

**Valor: bajo. Es la más honesta del plan.**

| | |
|---|---|
| **Por qué es baja** | El competidor la vende como su diferenciador principal en la landing, y **no se sostiene con lo que se puede verificar**: `vapidPublicKey: null` en todas sus páginas, y el `pass.json` no trae `locations` ni `relevantDate`. Un pase de Apple o Google Wallet **no reporta la ubicación del cliente al servidor**. El único camino es la app nativa del cliente — y su landing dice "Tus clientes no instalan apps" |
| **Qué falta** | `lat`/`lng` en `branches` (Etapa 6) · un canal que reporte ubicación · radio configurable · medición de visitas atribuidas |
| **Esfuerzo** | Medio, y el resultado depende de una app nativa que no tenemos |
| **Terminado cuando** | Un cliente dentro del radio recibe un aviso y la visita se atribuye a una sucursal, con la medición que la landing promete |

**Recomendación: no liderar con esto.** El competidor lo lidera y no se puede demostrar. Es terreno donde perder.

---

### Etapa 8 — Cross-loyalty / coalitions

**Valor máximo. Es la última porque está bloqueada por una decisión que no hemos tomado.**

| | |
|---|---|
| **Por qué es la mayor** | Nadie lo tiene. LoyaltyLion es single-merchant; Captain's Co-op (EEUU) lo hizo como red cerrada de franchises, no como infraestructura; Loyalia no tiene nada. Y mueve el buyer: quien onboardea 40 comercios es el *organizador* de la coalition — un mall, una asociación, una franchise, una agencia. Ticket mayor, presupuesto distinto |
| **Qué la bloquea** | **`loyalty_programs.business_id` es `UNIQUE`** (`schema.ts:226`). Una coalition no cabe en el modelo actual. Y el pricing de §1.3 tampoco: un plan que promete 15 programas con un UNIQUE es un plan que no se puede comprar |
| **Además falta** | `programId` en `points_transactions` (Etapa 1) · RLS que tolere un tenant que lee varios `business_id` (Etapa 5) · analítica por commerce y por coalition · **la economía del reparto**, que es pregunta de negocio, no de código |
| **Secuencia** | **Opción B primero**: activar `cross_loyalty_alliances` (`earn_rate_ab`, `earn_rate_both`), que ya existe. Da cross-earn entre dos tenants sin balance compartido. Migración chica, caso de uso real. **Opción A después**: la coalition como tenant, con balance compartido, un pase y un QR |
| **Esfuerzo** | B: bajo-medio. A: alto |
| **Terminado cuando** | Un comensal gana en un comercio de la alliance y puede canjear en el otro, y el saldo es correcto en ambos pase |

Diseño completo en [docs/analisis-loyalia.md §15](./analisis-loyalia.md) y aquí en §6.

---

### Etapa 9 — Apple Wallet

**No es una etapa de ingeniería. Es una decisión de negocio.**

Hay un **contract test que lo prohíbe explícitamente**: `apps/customer-web/app/delivery.contract.test.ts:6` — *"The Stage 7 checklist asks for confirmation that there is no Apple Wallet or..."*. El competidor construye todo su posicionamiento sobre Apple Wallet.

La parte difícil ya se resolvió en el lado de ellos y es razonable: firma PKCS#7, assets a `@1x/@2x/@3x`, `webServiceURL` + `authenticationToken`, barcode = token del cliente. Costo de entrada: la revisión del pass type (días) y una cuenta de Apple Developer ($99/año). Costo de seguir sin él: quedar fuera del wallet que usa la mayoría del mercado Latinoamericano en iPhone.

Conviene resolverlo antes de la Etapa 8, porque Google Wallet ya está aprobada y el emisor ya está creado. Agregar un segundo provider después de conseguir el acceso de publicación es más lento.

---

## 8.1 Resumen del plan

| Etapa | Qué | Valor | Esfuerzo | Bloquea |
|---|---|---|---|---|
| **0** | Escáner / check-in | máximo | bajo-medio | Todo |
| **1** | `PurchaseCompleted` + `external_reference` + Swagger | máximo | bajo-medio | 1b, 6b, 8 |
| **1b** | Regla de acumulación (`earn_by`) | alto | bajo | 4 |
| **2** | Merchant ve sus clientes | alto | bajo-medio | — |
| **3** | Pass en tiempo real | alto | **bajo** | — |
| **4** | Automatizaciones por programa | alto | medio | — |
| **5** | RLS desplegado | riesgo | **bajo** | 6, 8 |
| **6** | Multi-sucursal + lat/lng | medio-alto | medio-alto | 6b, 7 |
| **6b** | Primer POS real | medio | medio | 8 |
| **7** | Geo-notificaciones | bajo | medio | — |
| **8** | Cross-loyalty (B → A) | máximo | medio-alto | 1, 5 |
| **9** | Apple Wallet | decisión | — | — |

**Las dos que hay que adelantar** porque son baratas y de alto valor: **Etapa 3** (pass en tiempo real) y **Etapa 5** (RLS). Ninguna desbloquea otras, pero ambas se pagan solas.

**La primera decisión, antes de la Etapa 1:** quitar el `UNIQUE` de `loyalty_programs.business_id`. Sin esa migración no hay `programId` que resolver, no hay coalitions, y el pricing de §1.3 no existe.

---

### Higiene que bloquea cualquier etapa

| Ítem | Por qué bloquea |
|---|---|
| Ningún job de CI aplica migraciones. Se aplican a mano (`docs/17:45-46`) | Toda etapa que migra depende de una operación manual sin red de seguridad |
| El build no es un gate. Un flag de compatibility inventado pasó lint, typecheck y tests enteros, y el deploy lo rechazó (`TASKS.md:181-187`) | El CI verde no significa que el código sirva |
| `customer-web` sin tests end-to-end, con `passWithNoTests` activo (`docs/11:832`) | Cualquier regresión en la web del comensal es invisible |
| `request_id` se corta en el borde gateway/worker (`docs/14:301-307`) | Un 500 nacido en un worker llega al cliente sin correlación con el log |
| Docs desactualizados: `docs/09` no lista `rewards`/`reward_grants` (sí existen), `docs/17` tiene el nombre de la base de producción equivocado, `docs/14:163-168` afirma que la web nunca llama al wallet y **es falso** | Y ya se cayó en la trampa tres veces, verificando contra el backlog en lugar de contra el código |

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