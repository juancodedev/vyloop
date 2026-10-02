# 14-Backlog.md
**[DOCUMENTO]:** Vyloop Engineering Backlog | **[VERSIÓN]:** v2.0 | **[ESTADO]:** Planning | **[RESPONSABLE]:** Product Manager

> Este backlog está alineado con el `Vyloop Roadmap PMV v1` (aprobado). Las fases y semanas de este documento son las fuentes de verdad del orden de construcción. Cualquier ítem fuera del alcance del PMV está marcado como `[Fase 2+]`.

---

## Fase 1 — Foundation (Semanas 1 a 3)

Objetivo: infraestructura base corriendo en producción. Sin esta fase, nada más puede construirse.

### Infraestructura y datos
- [ ] Setup del monorepo `vyloop-core` con estructura de Workers por dominio
- [ ] Configuración de entorno de desarrollo local (`wrangler dev` + Neon local)
- [ ] Implementar schema de base de datos PostgreSQL (todos los dominios) con migraciones versionadas
- [ ] Activar Row-Level Security (RLS) en todas las tablas con `business_id`
      — *Estado real: el mecanismo existe, el rollout no.* `packages/db/src/rls.ts` ya expone
      `createRlsPolicies()`, `RLS_POLICY_NAME` (`tenant_isolation`) y las listas `BUSINESS_ID_TABLES`
      (17 tablas) y `TENANT_ID_TABLES` (las 2 de wallet, que no tienen `business_id` y usan
      `app.current_tenant_id`). `workers/wallet` ya consume el mecanismo vía `openTenantSession`.
      Lo que falta es el paso de despliegue: `createRlsPolicies()` no se llama en código de producción,
      y `withRls()` por sí solo solo ejecuta un `SET` — sin políticas creadas y sin
      `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` la sesión sigue viendo todas las filas. El aislamiento
      de hoy descansa en filtros explícitos de `business_id` en los handlers de ruta.
      Siguiente paso: habilitar RLS por tabla, empezando por las de wallet, y recién después
      asumir que el filtro de la ruta es una defensa secundaria y no la única.
- [ ] Configurar Schema Registry en Cloudflare Workers KV con esquemas de eventos iniciales

### Identity y autenticación
- [ ] Implementar IAM (Identity & Access Management) multi-tenant
- [ ] API Gateway base (Cloudflare Workers + Hono) con routing por dominio
- [ ] Auth OIDC — emisión y validación de JWT con scopes granulares
- [ ] Validación de `X-Business-ID` en el gateway — rechazo 403 si no coincide con el token
- [ ] Registro y login de negocio (tenant) — flujo completo

### Bus de eventos
- [ ] Configurar Cloudflare Queues como bus de eventos base
- [ ] Implementar Event Ingestor con validación de Schema Registry
- [ ] Worker de prueba: publicar `TestEvent` y consumirlo desde un Worker suscriptor

---

## Fase 2 — Core Platform (Semanas 4 a 6)

Objetivo: producto vendible desde la semana 6. Un negocio puede registrar clientes, asignar puntos y ver su base de datos.

### Customer Domain
- [ ] CRUD completo de clientes (`/v1/customers`)
- [ ] Registro de cliente vía landing PWA (escaneo de QR → formulario → confirmación)
- [ ] Evento `CustomerRegistered` publicado al bus al completar registro
- [ ] Perfil 360° del cliente: endpoint `/v1/customers/{id}` con `customer_events`
- [ ] Generación de `global_id` en el momento del registro

### Growth Domain
- [ ] Motor de puntos: lógica de earn con tasa configurable y multiplicador por tier
- [ ] CRUD de niveles de membresía (`membership_tiers`)
- [ ] Endpoint de asignación de puntos (`POST /v1/loyalty/points/assign`)
- [ ] Endpoint de canje (`POST /v1/loyalty/rewards/redeem`)
- [ ] Suscripción al evento `CustomerRegistered` → inicializar wallet en Bronze
- [ ] Suscripción al evento `PointsAssigned` → evaluar upgrade de tier

### Dashboard Web (Next.js)
- [ ] Layout base del dashboard con navegación y autenticación
- [ ] Vista de lista de clientes con búsqueda por nombre/teléfono
- [ ] Vista de perfil individual del cliente (puntos, nivel, últimas visitas)
- [ ] Vista de configuración del programa de puntos
- [ ] QR del negocio para el punto de venta (generado y descargable)

### Pagos (suscripción del negocio)
- [ ] Integración de Stripe para mercados fuera de Chile
- [ ] Integración de Flow para el mercado chileno
- [ ] Flujo de upgrade de plan Free a Pro desde el dashboard

---

## Fase 3 — Retención e Inteligencia (Semanas 7 a 9)

Objetivo: el negocio puede actuar sobre clientes en riesgo y medir satisfacción.

### Analytics Domain
- [ ] Segmentación de clientes con operadores AND/OR (`GET /v1/customers` con filtros combinados)
- [ ] Cálculo de score RFM por cliente (recencia, frecuencia, valor)
- [ ] Alerta de clientes en riesgo: vista en dashboard con lista y días de inactividad
- [ ] Evento `ChurnRiskDetected` publicado al bus cuando un cliente supera el umbral

### Communication Domain
- [ ] Integración de Meta Business API (WhatsApp)
- [ ] Templates de WhatsApp: bienvenida, puntos acumulados, beneficio disponible
- [ ] Integración de Resend para email transaccional
- [ ] Templates de email: confirmación de registro, estado de puntos
- [ ] Endpoint `/v1/communication/send` — envío omnicanal basado en template

### Automation Domain
- [ ] Workflows predefinidos activables sin configuración:
  - [ ] Cumpleaños: `CustomerBirthdayToday` → WhatsApp con regalo de puntos
  - [ ] Inactividad: `N días sin visita` → mensaje de retención
  - [ ] Primer canje: `RewardRedeemed` (primera vez) → mensaje de felicitación

### Feedback
- [ ] NPS post-canje: solicitud automática al cliente final tras el primer canje
- [ ] Vista de NPS promedio en el dashboard del negocio
- [ ] Exportación de base de clientes en CSV/Excel

---

## Fase 4 — Validación con Pilotos (Semanas 10 a 13)

Objetivo: 10 a 15 negocios reales usando el producto. Datos reales para la siguiente fase de inversión.

- [ ] Onboarding guiado de negocio nuevo (wizard de configuración inicial)
- [ ] Incorporación de los primeros 10 negocios piloto en Chile
- [ ] Dashboard de métricas North Star: tasa de canje, retención de negocios, NPS
- [ ] Ronda de ajustes basada en feedback de los pilotos
- [ ] Documentación de los primeros aprendizajes del PMV

---

## Bloquean la experiencia del comensal

> Google Wallet funciona de punta a punta en producción: clase aprobada, pase verificado en
> un teléfono real, webhooks entrando. **Estos pendientes no son del backend.** Son el muro
> entre que un comensal se registre y llegue a tener una tarjeta en la billetera. Cada ítem
> dice cómo se verificó.

### Identidad del comensal

- [ ] **Ningún comensal tiene email: el registro no lo pide y nadie lo captura.**
      El campo existe en `apps/customer-web/app/register/page.tsx` pero vive dentro de un
      `<details>` de "opcionales", con el texto *"Solo si te resulta cómodo"*. **Verificado
      en producción: los 12 clientes tienen `email = NULL`.**
      El email sí se lee, pero solo en el backend: el buscador de clientes del worker
      `customer` lo incluye entre los tokens (`like(customers.email, ...)`) y lo devuelve en
      la proyección. Es decir, **el merchant puede buscar por email a un comensal que nunca
      dio uno** — siempre que lo escribiera, lo que nunca ocurre.
      **Hoy esto no bloquea el regreso** — el login de cliente
      (`POST /v1/auth/customer/token`) busca por `eq(customers.phone, ...)` y el formulario
      de ingreso pide teléfono, no email. El día que el login por teléfono exija OTP o
      verificación real, no hay ningún canal de recuperación para nadie. Conviene decidirlo
      antes de que el sistema lo decida solo.

### El perfil nunca pide el pase

- [ ] **`profile/page.tsx` nunca llama a `GET /v1/wallet/pass`.**
      Verificado: no hay una sola referencia a `/v1/wallet` en todo `apps/customer-web`
      (grep sobre `.ts` y `.tsx`, sin resultados). El backend responde bien — hay 3 pases
      en estado `issued` en producción — pero **el frontend no lo consulta**.
      El comensal llega a su perfil y no ve el botón de guardar el pase en Google Wallet,
      porque no hay código que lo pida.

- [ ] **`member_code`: se genera al pedir el pase, pero el alta por sí sola no lo dispara.**
      `ensureMemberCode` se llama desde `issuePass` en `workers/wallet/src/issuance.ts:418`,
      es decir dentro de la emisión del pase. El alta del cliente no lo dispara, así que un
      comensal registrado y que nunca pide pase tiene `member_code = NULL` — verificado:
      4 de los 12 clientes en producción lo tienen, y son los que pidieron pase. El código
      de intercambio (`accountId` en el pase) existe para que el cajero identifique al
      cliente, así que queda ausente justo en el caso de quien todavía no tiene el pase.

### La página pública del comercio está muerta para las personas

- [ ] **`/p/{slug}` no tiene ningún link. Verificado.**
      La página responde 200 y contiene el nombre del comercio en el `<h1>` — eso es lo que
      la review de Google lee, y por eso se construyó así. Pero `curl` sobre
      `media.juancode.dev/p/cafe-central` devuelve **cero** elementos `<a>`: no hay un CTA,
      ni un botón, ni un link a ningún lado. Se construyó para que Google la revise, y quedó
      muerta para las personas: es una página pública y sin puerta de entrada.
      Necesita un CTA a `customer-web/register?biz={slug}`. Al agregarlo hay que tener en
      cuenta que el mismo HTML lo lee el revisor de Google: el texto visible del CTA cuenta
      a favor, no en contra.

---

## Backlog Fase 2+ (post-PMV)

Estos ítems están en la visión del producto pero **no entran al PMV**. Se priorizan en la siguiente ronda de planificación tras los aprendizajes de los pilotos.

### Growth
- [ ] Programa de referidos viral (puntos por referir a otro cliente)
- [ ] Cashback parcial (canje mixto puntos + dinero)
- [ ] Gamificación: streaks de visitas, badges, desafíos
- [ ] Red cross-loyalty entre negocios aliados

### AI / Analytics
- [ ] Modelo de predicción de churn con ML (reemplaza las reglas RFM del PMV)
- [ ] Business Copilot: consulta semántica al dashboard (`POST /v1/ai/copilot/query`)
- [ ] Benchmarks entre negocios de la misma categoría (requires ClickHouse)
- [ ] Analytics por empleado individual (QR propio por cajero)
- [ ] Migración analítica a ClickHouse Cloud

### Communication & Automation
- [ ] Workflow builder visual (If This Then That con interfaz drag & drop)
- [ ] Orquestador omnicanal (canal óptimo según preferencias del cliente)
- [ ] Canal SMS como complementario

### Plataforma
- [ ] App nativa iOS y Android (Flutter o React Native)
- [ ] Apple Wallet + Google Wallet con actualización de saldo en tiempo real
      — *Parcial. La mitad de Google Wallet está construida; la de Apple no se ha tocado; el barrido
      programado no existe.* El ítem no se tilda porque una promesa a medias no es una promesa cumplida.

      **Hecho (Google Wallet), en `workers/wallet` + `packages/db`:**
      - Modelo de pase completo: derivación de ids, member code Crockford Base32 de 6 caracteres
        con salt por tenant, `LoyaltyClass`, `LoyaltyObject`, formato de saldo, firmante JWT y cliente
        REST de Google detrás de una interfaz. PRs #121, #122, #123, #124.
      - Superficie HTTP de 6 rutas (`GET /v1/wallet/status`, `GET /v1/wallet/pass`,
        `GET /v1/wallet/program`, `PUT /v1/wallet/program/demo-mode`,
        `POST /v1/wallet/program/sync`, `POST /v1/wallet/google/callback`), enrutadas por el
        gateway bajo `/v1/wallet`. La última es la que Google llama, y está exenta del
        middleware de auth junto con `robots.txt`.
      - Schema: `tenant_wallet_programs`, `customer_wallet_passes`, `customers.member_code`,
        con migración `0004` aplicada al schema.
      - Callback de Google: verificación de firma, resolución del tenant por `classId`, y
        supresión de reentrega por `nonce` (`wallet_callback_deliveries`, `0008`).
      - Página pública por comercio `/p/{slug}`, servida por el gateway. Es lo que Google
        revisa como `homepageUri`.

      **Restricciones que siguen en pie (no son código):** el acceso de publicación es **una sola
      aprobación para todo el emisor**, no una por clase. El worker lo declara explícito
      con `WALLET_DEMO_MODE`, cuyo default es `true` a propósito, y las dos rutas de cliente
      responden en negativo en vez de ofrecer un botón que falla. La fila de tier del pase se
      omite porque no hay columna que guarde su header de display (`tier_row_available` es siempre
      `false`), y un saldo sobre 9,999,999 se rechaza con `WALLET_BALANCE_NOT_DISPLAYABLE` en vez de
      truncarse.

      **Pendientes abiertos, con el estado real de cada uno.** Ninguno de estos se resuelve
      con más backend: el backend responde, lo que falta es que alguien lo pregunte o que el
      pipeline lo compruebe.

      - [ ] **El merchant no puede ver ni gestionar las tarjetas de sus clientes.**
            Es el pendiente que pidió el usuario explícitamente. `/dashboard/settings` muestra
            el estado del *programa* — clase, `review_status`, demo mode — pero no las
            tarjetas: no hay ninguna vista que liste los pases de los clientes de un negocio,
            ni que permita reemitir o revocar uno. Sin esto el merchant tiene la mitad
            operador del producto y no la otra.
      - [ ] **Los 7 rechazos (HTTP 400) sobre 18 callbacks reales no están explicados.**
            Google entregó 18 callbacks contra la clase de producción: 7 rechazados con 400,
            6 aceptados. Los 6 que pasaron demuestran que la verificación de firma funciona
            — un atacante no los habría colado — pero los 7 rechazos no tienen causa conocida.
            Un 39% de rechazo sobre tráfico real de Google es un defecto, no ruido.
            *No verificado:* `wallet_callback_deliveries` está **vacía** en producción (contada
            el 2026-10-02). Si los 6 aceptados hubieran pasado por
            `claimCallbackDelivery`, habría 6 filas. Dos explicaciones: los eventos llegaron
            antes de que existiera la tabla `0008`, o el paso de escritura está fallando. Hay
            que averiguarlo antes de confiar en que el estado de un pase refleja lo que Google
            dijo — hoy no hay evidencia de que el camino completo se haya ejercitado en
            producción.
      - [ ] **`loyaltyPoints.balance` se manda como `{"string": "0"}` y Google usa `int`.**
            Verificado en `workers/wallet/src/reconcile.ts:308`. No rompe: Google acepta el
            saldo como string y el pase renderiza bien. Pero es un tipo equivocado en el
            contrato, y el día que Google lo valide estrictamente deja de funcionar sin aviso.
      - [ ] **El gate de migraciones en el deploy.**
            **Ningún job de CI aplica migraciones** — `grep db:migrate .github/workflows/` da
            cero — y el deploy sale `success` aunque el schema destino esté atrasado. Ya costó
            dos rutas muertas en producción (`/p/{slug}` y el callback de Google, por columnas
            de `0007` y `0008` sin aplicar) sin que nada lo dijera.
            Verificado: `drizzle.__drizzle_migrations` tiene 4 filas (los hashes de `0000` a
            `0003`) mientras el schema real ya tiene `0007` y `0008`. **El ledger miente** —
            `drizzle-kit push` no lo escribe — así que el gate tiene que comparar el schema
            contra el journal, no confiar en el ledger.
            Detalle: [`18-Verificacion-y-Seguridad-Operativa.md`](18-Verificacion-y-Seguridad-Operativa.md) §5.
      - [ ] **El hueco de `request_id` en todos los workers.**
            `workers/*/src/index.ts` tienen un `console.error` pelado en el catch final
            (`'[customer] Unhandled error:'`, `'[growth] Unhandled error:'`, y uno por worker).
            El gateway ya loguea el `request_id` de un 500 para que el error sea rastreable
            — ese es el patrón — pero el `request_id` se corta en el borde gateway/worker:
            un 500 que nace dentro de un worker llega al cliente sin correlación con el log
            del worker.

      **No construido:**
      - **Apple Wallet.** Sin trabajo en el repositorio. Este ítem sigue abierto en su mitad.
      - **El barrido programado.** La reconciliación corre dentro de `GET /v1/wallet/pass`, después
        de firmar el link, y sus fallas se registran y se ignoran para no comprometer el 200. No hay
        cron, ni handler `scheduled`, ni worker de barrido: `workers/wallet/src/index.ts` solo exporta
        `fetch`. Por lo tanto **no hay actualización de saldo en tiempo real**: el saldo se proyecta
        cuando el cliente pide el link, y un pase que no se vuelve a abrir no se vuelve a actualizar.
      - **El botón "Add to Google Wallet".** Intencionalmente ausente. `GET /v1/wallet/status` es
        exactamente el endpoint que ese botón tendría que consultar antes de renderizarse, para que
        nunca aparezca sobre un pase que va a fallar.
- [ ] API pública documentada con Swagger (para integradores externos)
- [ ] Webhooks para suscripción de sistemas externos a eventos de Vyloop
- [ ] SDKs oficiales Node.js y Python
- [ ] Modo offline con sincronización diferida (para comercios con conectividad inestable)
- [ ] Integración con POS (Bsale / iPos — asignación automática de puntos)
- [ ] Dashboard multi-sucursal consolidado
- [ ] White-label / marca blanca (plan Enterprise)
- [ ] NFC como vector de captura alternativo al QR

---

## Criterio de definición de "listo" (DoD)

Un ítem del backlog está listo para marcar como completado cuando:
1. El código tiene tests que cubren el caso principal y los casos de error más relevantes.
2. El endpoint o el Worker está documentado en el Schema Registry o en el Swagger.
3. El comportamiento puede explicarse en términos del valor que genera — no solo de que "funciona".
4. El código pasó revisión de un segundo par de ojos antes del merge.

---

## Documento anterior

Este documento reemplaza:
- `14-Backlog.md` v1.0 (Project Atlas)
- Sección de próximos pasos del `Vyloop Roadmap PMV v1` (aprobado)

