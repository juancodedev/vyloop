# Vyloop — Estado de Tareas

> Actualizado: 28 Septiembre 2026

---

## ✅ COMPLETADO

### Infraestructura y Tooling
- [x] **Dev scripts para workers** — Todos los workers tienen `dev` con puertos únicos (8788-8795) y service binding discovery
- [x] **Gateway dev port fijo** — `wrangler dev --port 8787` para que el dashboard lo encuentre siempre
- [x] **.dev.vars** — customer y growth workers con DATABASE_URL para dev local
- [x] **Credenciales seed corregidas** — `demo@cafecentral.com` / `demo123`
- [x] Monorepo pnpm workspace con shared configs (TS, ESLint, Prettier, Vitest)
- [x] Docker Compose para PostgreSQL 16 + Mailpit local
- [x] CI workflow: lint + typecheck + test en cada push
- [x] Deploy workflow (GitHub Actions → Cloudflare)
  - [x] 8 Workers deployados (identity, customer, growth, analytics, automation, communication, compliance, gateway)
  - [ ] **Worker `wallet` no está en la matriz de deploy** — existe y tiene `wrangler.jsonc`, pero
        `.github/workflows/deploy.yml` no lo incluye, así que todavía no está en producción
  - [x] Dashboard Pages deployado en vyloop.juancode.dev
  - [x] Customer-web Pages deployado en vyloop-customer-web.pages.dev
- [x] CI/CD probado y funcionando — 11/11 jobs verdes ✅
- [x] Node.js actualizado a v22 para compatibilidad con undici v8
- [x] wrangler agregado como root devDependency para deploy de workers
- [x] Cloudflare API token con permisos correctos: Workers Scripts:Edit + Memberships:Read

### Base de Datos (PostgreSQL + Neon + Drizzle ORM)
- [x] Schema: 21 tablas (tenants, users, customers, loyalty_programs, tiers, points, rewards, message_log, whatsapp_templates, tenant_wallet_programs, customer_wallet_passes, etc.)
- [x] Mecanismo de RLS para multi-tenancy (`packages/db/src/rls.ts`) — **las policies existen en código
      pero RLS no está desplegado**: `createRlsPolicies()` no se llama en producción y
      `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` no se ha corrido. El aislamiento de hoy descansa en
      filtros explícitos de `business_id` en las rutas. Ver `docs/14-Backlog.md`
- [x] Seed script: Café Central demo (tiers, 10 customers, 50+ transacciones)
- [x] Migraciones Drizzle
- [x] **Deuda de índices y tablas cerrada** — los 14 `CREATE (UNIQUE) INDEX` declarados nunca habían
      llegado a la base de datos, y `message_log` y `whatsapp_templates` estaban en el schema sin
      migración. Cerrado en la migración `0004` (PR #122). Los índices se declaran ahora en el callback
      de extra-config de cada tabla en `schema.ts`, porque un builder exportado a nivel de módulo nunca
      lo reclama una tabla y drizzle-kit lo descarta en silencio

### Google Wallet (loyalty pass del cliente)
- [x] Modelo de pase: derivación de ids, member code Crockford Base32, `LoyaltyClass`, `LoyaltyObject`, formato de saldo, firmante JWT, cliente REST de Google (PR #121)
- [x] Migración de schema: `tenant_wallet_programs`, `customer_wallet_passes`, `customers.member_code` (PR #122)
- [x] Superficie HTTP de 3 rutas — `/v1/wallet/status`, `/v1/wallet/pass`, `/v1/wallet/program/sync` — enrutadas por el gateway (PR #123)
- [x] Reconciliación del pase guardado y push del saldo actual (PR #124)
- [ ] **Botón "Add to Google Wallet"** — bloqueado por la aprobación de acceso de publicación de Google.
      El worker lo declara con `WALLET_DEMO_MODE` (default `true` a propósito) y las rutas de cliente
      responden en negativo en vez de ofrecer un control que falle
- [ ] **Barrido programado de reconciliación** — hoy la reconciliación corre dentro de
      `GET /v1/wallet/pass`; no hay cron ni handler `scheduled`, así que el saldo no se actualiza en
      tiempo real
- [ ] **Fila de tier en el pase** — omitida: no hay columna que guarde su header de display
- [ ] **Deploy del worker a Cloudflare** — ausente de la matriz de `deploy.yml`

### Identity / Auth
- [x] JWT issuance + validation (Web Crypto API, PBKDF2)
- [x] API Keys management
- [x] Login email/password contra DB
- [x] Event handler (UserCreated)
- [x] Tests unitarios + integración

### API Gateway
- [x] Auth inject middleware (JWT → X-User-Id, X-Business-Id, X-User-Role)
- [x] Stripeo de headers entrantes para evitar spoofing
- [x] Rate limiting
- [x] Domain prefix routing (/v1/identity/*, /v1/customers/*, /v1/loyalty/*)
- [x] Tests de middleware

### Customer Domain
- [x] CRUD completo: upsert, list (con search), profile 360°, patch, soft-delete
- [x] Event publishing (CustomerRegistered)
- [x] 25 tests (unit + integration)

### Customer Web (PWA)
- [x] Landing page con QR del comercio
- [x] Registro del cliente (formulario + confirmación)
- [x] Login con teléfono (mock auth)
- [x] Perfil: tarjeta de puntos, nivel, barra de progreso, últimos movimientos
- [x] Historial completo con filtros

### Growth Engine (Loyalty)
- [x] Foundation: event types, schemas, DB migration
- [x] Worker HTTP endpoints: puntos, tiers, wallet
- [x] Queue consumer: CustomerRegistered → wallet init, PointsAssigned → tier eval
- [x] Tests

### Dashboard (PMV)
- [x] Login page con toggle de visibilidad de contraseña
- [x] Sidebar layout
- [x] Customers list view
- [x] Loyalty config view (programas, niveles)
- [x] Tiers management view
- [x] Conexión a API real (gateway)

### SDK
- [x] `@vyloop/dashboard-cards` — Customer detail card component
- [x] Publicado en npm

---

## 🔲 PENDIENTE

### Growth Engine
- [ ] **Phase 5 tests** — Completar suite de tests faltantes del Growth Engine
- [ ] Validación post-deploy de endpoints de loyalty

### Workers Placeholder (implementar lógica de negocio)
- [ ] **Analytics** — Reportes, métricas de uso, dashboard analytics
- [ ] **Automation** — Reglas de automatización (bienvenida, cumpleaños, inactividad)
- [ ] **Communication** — Notificaciones push, email, SMS, WhatsApp
- [ ] **Compliance** — Auditoría de eventos, GDPR, exportación de datos

### DB y Migraciones
- [ ] **Drizzle migration real** — Generar migrations formales con `drizzle-kit generate`
- [ ] Revisar y alinear versiones de `@neondatabase/serverless` entre workers

### Dashboard
- [x] **Customer detail page** — Vista de perfil individual del cliente desde el dashboard
- [x] **QR del negocio** — Página para mostrar/compartir el QR del comercio
- [x] **CRUD de rewards** — UI para crear/editar rewards del programa de lealtad
- [x] **Fix loyalty customers** — Row click navega al detalle del cliente
- [x] **Guard deQR sin comercios sembrados, también en el dashboard** — `cafe-central`,
      `demo-shop` y `barro` existen en los seeds, y un comercio nunca puede ver el nombre de otro
      ni ser enviado al registro de otro. Cubierto en los dos paquetes:
      `apps/customer-web/app/delivery.contract.test.ts` y
      `apps/dashboard/src/__tests__/qr-tenant.contract.test.ts`
- [ ] **Dashboard analytics** — KPIs (clientes nuevos, puntos emitidos, canjes)

### Customer Web
- [x] **Auth real** — Login por teléfono contra `POST /v1/auth/customer/token`, reemplazando el mock
- [x] **Aislamiento por comercio en el login** — `businessSlug` es obligatorio y un slug desconocido
      se rechaza. Antes: sin `?biz=` elegía el tenant que la base devolviera primero, y un slug
      inexistente emitía un token de un tenant arbitrario
- [x] **Canal de soporte en la pantalla de error** — `POST /v1/support` con rate limit, honeypot y
      Turnstile. Falla cerrado: sin token devuelve 403, y sin secret configurado 503
- [ ] **Canje de rewards** — Flujo para que el cliente canjee sus puntos
- [ ] **Push notifications** — Notificaciones de puntos, niveles, rewards

### Alta de comercios (autoservicio)
- [x] **Formulario de alta** — `/login?signup=true` llama a `POST /v1/auth/business/signup`, deriva
      el slug, inicia sesión al operador nuevo y muestra el enlace de registro
- [x] **Botón "Comenzar Gratis"** — la landing del dashboard enlaza al alta

### Google Wallet — estado de revisión
- [x] **Sincronización de `review_status`** — el sweep diario refresca de Google toda clase que no
      esté `approved`. El cron vive en el sweep existente porque la cuenta tiene sus 5 cron triggers
      asignados y un sexto es rechazado con `10072`
- [x] **Casing de la respuesta de Google** — `loyaltyclass.get` devuelve `reviewStatus` en
      minúsculas. El mapeo inverso no matcheaba ninguna respuesta real y devolvía 502 para todos los
      estados, incluido `approved`

### Otros
  - [ ] **Design tokens** — Sistema de diseño unificado (colores, tipografía, spacing)
  - [ ] **Modo oscuro** — Dark mode en dashboard y customer-web
  - [ ] **Internacionalización** — Soporte multi-idioma (es, pt, en)
  - [ ] **Tests end-to-end** — Playwright o Cypress para flujos críticos
  - [ ] **Documentación API** — OpenAPI spec actualizada con todos los endpoints vivos
  - [ ] **Licencia** — Definir y agregar licencia al proyecto

  ---

  ## 🐾 Bugs de producción encontrados probando el flujo real

  Los cuatro se mergearon con los cuatro gates en verde. **Ninguno era visible desde los tests**,
  y tres compartían la misma forma: el test afirmaba el comportamiento equivocado, o no afirmaba
  nada sobre el valor queimportaba.

  | Qué | Síntoma | Por qué los gates no lo vieron |
  |---|---|---|
| `PUT /v1/customers` con email duplicado | 500 | La violación de índice único no se manejaba; `PATCH` sí lo hacía y `PUT` no |
  | Nombre del índice en el error del driver | `CUSTOMER_CONFLICT` siempre, nunca `CUSTOMER_EMAIL_TAKEN` | El fixture usaba `constraint_name`; el driver lo llama `cause.constraint` |
  | `PUT /v1/customers` sin token válido | 500 **después** de insertar la fila | El cliente quedaba registrado y se le decía que no. El test afirmaba el 500 como correcto |
  | El form de soporte sin token de Turnstile | 403 siempre | `useRef` declarado y leído, escrito nunca. **Todos** los tests mockean `sendSupportMessage` |

  ### La lección, en una línea

  > **Un mock que reemplaza el valor que viaja por el cable no está probando el cable.**
  > Un mapping testeado contra su propio enum no matchea ninguna respuesta real.

  ### La trampa de infraestructura

  `wrangler.jsonc` **no lo valida ningún gate**. Un flag de compatibility inventado pasó lint,
  typecheck y tests enteros, y el deploy lo rechazó con `No such compatibility flag`. Lo mismo
  con `useSearchParams()` fuera de un boundary de Suspense: los cuatro gates en verde, el build roto.

  **El build es su propio check, y no lo corre ningún script de tests.**

  ### Los guards que sí atraparon cosas

  Vale la pena lo contrario, porque es lo que se está buscando:

  - El guard de QR del dashboard rechazó el form de alta por un
    `placeholder="Café Central"` y después por armar `?biz=` a mano. **Ambas veces tenía razón** —
    el segundo porque esa es la forma que matchea el escáner del cajero.
  - `customer-patch.contract.test.ts` rechazó que un test escribiera un código de error a mano.
  - `qr-tenant.contract.test.ts` y `globals.contract.test.ts` rechazaron markup sin regla CSS y un
    `style` inline.

  Un guard que te frena sin que lo esperes está funcionando. El problema no es que haya demasiados:
  es que **no cubren el cable ni el build**, que es donde estaban los cuatro bugs.

  ---

## Referencias Rápidas

### URLs de Producción

| App | URL |
|-----|-----|
| Dashboard | https://vyloop.juancode.dev |
| Customer Web | https://vyloop-customer-web.pages.dev |
| Gateway API | https://gateway.cl-jmunoz.workers.dev |

### El link del cliente es el que lleva el comercio

```
https://vyloop-customer-web.pages.dev/register?biz=<slug>
```

**Sin `?biz=` no hay login ni registro**, y está a propósito: un teléfono no es único entre
comercios, así que sin el slug la pregunta no tiene respuesta. Cada comercio ve el suyo al
terminar el alta, y es también lo que imprime como QR.

**`vyloop.juancode.dev` NO es el customer-web.** Ese es el dashboard. El `/c/<uuid>` del QR es el
`global_id` del cliente y lo resuelve el POS con `/v1/customers/by-global-id/:globalId`; apunta a
`pages.dev`, que es donde vive de verdad.

### Credenciales Demo

| Rol | Email / Teléfono | Contraseña |
|-----|------------------|-------------|
| Admin (Café Central) | demo@cafecentral.com | demo123 |
| Cliente (Lucía Fernández) | +56956789012 | (login con teléfono, en `/login?biz=cafe-central`) |

### Comandos Útiles

```bash
pnpm dev                    # Todo en modo dev
pnpm -r test                # Todos los tests
pnpm -r lint                # ESLint
pnpm -r typecheck           # TypeScript strict
pnpm build                  # Build de todos los paquetes
```

### Rama default: `main`

Todas las features se trabajan en branches y se mergean vía PR. No commits directos a main (excepto fixes urgentes).
