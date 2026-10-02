# Vyloop

**Loyalty & Engagement SaaS for LatAm SMBs.**

Vyloop es una plataforma multi-tenant de lealtad y engagement para PyMEs en Latinoamérica. Los comercios pueden crear y gestionar programas de fidelización con check-in por QR, puntos, rewards, niveles, y comunicación omnicanal — con una demo funcional para ventas.

> Monorepo: apps, workers, packages compartidos, tooling e infraestructura.

---

## Estado del Proyecto

| Hito | Estado |
|------|--------|
| Monorepo structure + tooling | ✅ Completado |
| DB schema (21 tablas, Drizzle ORM) | ✅ Completado |
| IAM (JWT, API Keys, RLS) | ✅ Completado |
| API Gateway (auth inject, rate-limit, routing) | ✅ Completado |
| Event Bus + Schema Registry | ✅ Completado |
| Customer CRUD (worker + tests) | ✅ Completado |
| Customer-web PWA (registro, perfil, puntos) | ✅ Completado |
| **Perfil premium con QR + achievements + tracking** | **✅ Completado** |
| Growth Engine (puntos, tiers, wallet, consumer) | ✅ Completado |
| Dashboard PMV (login, sidebar, clientes, loyalty) | ✅ Completado |
| **POS Emulator — menú, carrito, QR scanner, cobro+puntos** | **✅ Completado** |
| Customer detail card SDK | ✅ Completado |
| Google Wallet — pase de lealtad de punta a punta | ✅ Clase aprobada; pase emitido y guardado desde un teléfono real |
| CI/CD automático (GitHub Actions → Cloudflare) | ✅ 11/11 jobs verdes |
| **Deployado y demo-list** | **✅ VIVO** |

### Google Wallet — estado real

- **Clase de Google Wallet aprobada.** La clase de Café Central pasó la review de Google. *No
  verificado desde este repositorio*: vive en la consola de Google Pay & Wallet, y la única
  huella local es la fila de `tenant_wallet_programs`.
- **Pase emitido y guardado en Google Wallet desde un teléfono real.** Verificado en la sesión
  de integración. En producción hay **3 pases en estado `issued`** — ese estado lo escribe la
  reconciliación leyendo el objeto en Google, así que el objeto existe del lado de Google.
- **Callback de Google deploying y firmando.** `POST /v1/wallet/google/callback` verifica la
  firma antes de tocar la base, y `media.juancode.dev` lo sirve con un `robots.txt` que permite
  a Googlebot alcanzarlo. *No verificado de punta a punta:* la tabla
  `wallet_callback_deliveries` está vacía en producción, así que no hay evidencia de que un
  callback haya llegado a aplicarse. Está en el backlog.

> ⚠️ **La fila de `tenant_wallet_programs` todavía dice `review_status = 'draft'` y su
> `demo_mode` es `false`.** Nadie corrió `POST /v1/wallet/program/sync` después de la aprobación,
> así que la fila local no refleja lo que Google ya dijo. Es el paso 4 de
> [`docs/11-crear-tarjeta-lealtad.md`](docs/11-crear-tarjeta-lealtad.md), y el orden importa:
> sincronizar primero, después el flag. `scripts/check-wallet-readiness.mjs` lo reporta.

Lo que **no** está: el gate de migraciones en el deploy, y las piezas de UX que faltan para que
un comensal llegue solo hasta la tarjeta — están en [`docs/14-Backlog.md`](docs/14-Backlog.md).

---

## Ambientes y bases de datos

**Hay tres bases, y solo una es producción.**

| | Base | Qué es |
|---|---|---|
| **Producción** | Neon `polished-firefly-68401534` | La que inyecta `.github/workflows/deploy.yml` desde el secret de GitHub `DATABASE_URL` |
| **Dev** | Neon `ep-divine-bonus-ai05bdy3` | La `DATABASE_URL` de los `workers/*/.dev.vars`. 1 tenant, sin fila de clase de wallet |
| **Migrado** | Supabase `mysrgtsuoxhpsyfhdnsp` | Proyecto anterior, ya no en uso. Vacía, sin schema |

> ⚠️ **`.dev.vars` NO es producción.** Es la que se usa cuando corrés `wrangler dev` en local, pero contiene credenciales reales de una base Neon real. Antes de aplicar una migración, confirmá contra cuál base estás escribiendo.
>
> Los secrets de GitHub son **write-only**: la `DATABASE_URL` de producción no se puede leer de vuelta. Por eso la tabla de arriba es la forma de saber a qué base apunta.
>
> Detalle completo: [`docs/18-Verificacion-y-Seguridad-Operativa.md`](docs/18-Verificacion-y-Seguridad-Operativa.md) §4.

### Qué corre dónde

| | Local | Producción |
|---|---|---|
| **Base de datos** | **Docker** (`docker compose -f docker/docker-compose.yml up -d`) | **Neon** |
| **`DATABASE_URL`** | `docker/postgres`, o el `.dev.vars` si necesitás tocar datos reales | Secret de GitHub |
| **Migraciones** | `pnpm --filter @vyloop/db db:migrate` | **A mano.** Ningún job de CI las aplica, y el deploy sale `success` igual |

---

## Links en Producción

| App | URL | Descripción |
|-----|-----|-------------|
| Dashboard | [vyloop.juancode.dev](https://vyloop.juancode.dev) | Login + gestión del comercio |
| Customer Web | [vyloop-customer-web.pages.dev](https://vyloop-customer-web.pages.dev) | Tarjeta de puntos del cliente |
| API Gateway | `gateway.cl-jmunoz.workers.dev` | Backend API (8 workers) |
| Gateway (dominio propio) | `media.juancode.dev` | Sirve `/p/{slug}`, `/brand/*`, `robots.txt` y el callback de Google. Sin path raíz: responde 404, y es lo esperado |
| Página del comercio | [media.juancode.dev/p/cafe-central](https://media.juancode.dev/p/cafe-central) | Página pública que Google revisa como `homepageUri` |
| Callback de Google Wallet | `POST media.juancode.dev/v1/wallet/google/callback` | Recibe los eventos `save`/`del` del pase. Responde 400 a un POST sin firma válida, que es lo correcto |

### Demo: Tarjeta del Cliente

1. Entrá a [vyloop-customer-web.pages.dev](https://vyloop-customer-web.pages.dev)
2. Iniciá sesión con teléfono `+56956789012`
3. Ves el perfil de Lucía Fernández con:
   - **Avatar con glow** y animación de puntos
   - **Puntos acumulados** + racha de visitas últimos 30 días
   - **Barra de progreso** al siguiente nivel (Oro)
   - **QR dinámico** colapsable para identificar al cliente en el local
   - **Logro Oro** — celebración especial al alcanzar el nivel máximo
   - **Actividad reciente** unificada (eventos + transacciones)
   - **Empty state** elegante cuando no hay actividad
   - Botones lado a lado: historial y canje de puntos

### Demo: POS Emulado (Caja)

1. Entrá a [vyloop.juancode.dev](https://vyloop.juancode.dev)
2. Login con email `demo@cafecentral.com` / contraseña `demo123`
3. Navegá a **Lealtad > POS**
4. Seleccioná productos del menú de cafetería (precios reales)
5. Hacé click en **📷 Identificar Cliente** — se abre la cámara
6. Escaneá el QR del perfil del cliente (desde el celular o desde la web abriendo `/profile`)
7. Se muestra el cliente, sus puntos, y los puntos a ganar por la compra
8. Opcional: ingresá puntos a canjear como descuento
9. **Cobrar** → asigna puntos, registra la venta, muestra recibo

### Demo: Dashboard

1. Entrá a [vyloop.juancode.dev](https://vyloop.juancode.dev)
2. Login con email `demo@cafecentral.com` / contraseña `demo123`
3. Navegá clientes, niveles, configuración de lealtad

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **Workspace** | pnpm 9 — apps, workers, packages, tooling |
| **Frontend** | Next.js 14/15 (App Router), Tailwind CSS, shadcn/ui |
| **API** | Cloudflare Workers + Hono |
| **Database** | PostgreSQL 16, Drizzle ORM — **Neon en producción**, **Docker en local** |
| **Auth** | JWT (Web Crypto API), PBKDF2, service bindings |
| **Events** | Cloudflare Queues + Schema Registry (AJV) |
| **Infrastructure** | Docker (Postgres + Mailpit), `wrangler dev` (workers) |
| **CI/CD** | GitHub Actions — quality checks + deploy automático |
| **SDK** | `@vyloop/dashboard-cards` — customer detail card component |
| **Tooling** | TypeScript strict, ESLint 9, Prettier, Vitest |

## Prerrequisitos

- **Node.js** >= 22 (ver `.nvmrc`)
- **pnpm** >= 9
- **Docker Desktop** (para PostgreSQL y Mailpit local)

## Getting Started

```bash
# 1. Instalar dependencias
pnpm install

# 2. Iniciar infraestructura local (PostgreSQL + Mailpit)
docker compose -f docker/docker-compose.yml up -d

# 3. Crear archivos .dev.vars para workers que lo necesiten
#    (identity, customer y growth ya tienen; analytics y el resto no)
for w in workers/analytics workers/automation workers/communication workers/compliance; do
  if [ ! -f "$w/.dev.vars" ]; then
    cp workers/identity/.dev.vars "$w/.dev.vars"
  fi
done

# 4. Ejecutar todo en modo dev (todos los workers + dashboard)
pnpm dev
```

> ⚠️ **`.dev.vars` apunta a Neon, no a Docker.** Los `.dev.vars` de los workers traen la
> `DATABASE_URL` de la base de desarrollo en Neon (`ep-divine-bonus-ai05bdy3`), porque los
> workers corren fuera de Docker y no alcanzan `localhost`. El `docker compose` de arriba
> levanta PostgreSQL y Mailpit para lo que sí puede usar red local.
>
> El desarrollo local **usa Docker** para su base. Producción **es Neon**, y es otra base
> distinta. Ver *Ambientes y bases de datos* arriba antes de aplicar cualquier migración.

Esto arranca en paralelo:
- `next dev -p 3000` para el dashboard (admin sell flow)
- `next dev -p 3001` para el customer web (perfil del cliente)
- `wrangler dev` para el gateway (puerto 8787) + todos los workers (8788–8794)
- El dashboard apunta al gateway en `http://localhost:8787`
- El customer web apunta al gateway en `http://localhost:8787`
- La gateway resuelve service bindings automáticamente mientras todos los workers estén corriendo

> ⚠️ **Service bindings en local**: wrangler dev descubre workers automáticamente cuando
> todos corren al mismo tiempo. Si un worker no se inicia (ej. por puerto ocupado),
> el gateway responderá `503 Worker "<name>" not found`.
>
> Verificá que todos los workers estén levantados:
> ```bash
> lsof -i :8787-8794 -P 2>/dev/null | grep LISTEN | wc -l
> # → deberían ser 8 (gateway + 7 workers)
> ```

> ⚠️ **Primera vez** — seedear la base de datos local:
> ```bash
> DATABASE_URL="postgresql://vyloop:vyloop_dev@localhost:5432/vyloop_dev" \
>   pnpm --filter @vyloop/db db:seed
> ```

### Puertos de Servicios

| Servicio | Puerto | Uso |
|----------|--------|-----|
| API Gateway (dev) | 8787 | Punto de entrada HTTP — el frontend apunta acá |
| Identity Worker | 8788 | Auth (login, JWT, API keys) |
| Customer Worker | 8789 | CRUD de clientes |
| Growth Worker | 8790 | Motor de lealtad (puntos, tiers) |
| Analytics Worker | 8791 | KPIs y reportes |
| Automation Worker | 8792 | Automatizaciones (placeholder) |
| Communication Worker | 8793 | Comunicación omnicanal (placeholder) |
| Compliance Worker | 8794 | Compliance y auditoría (placeholder) |
| Wallet Worker | 8795 | Pases de lealtad de Google Wallet |
| Dashboard (dev) | 3000 | Frontend Next.js — admin sell flow |
| Customer Web (dev) | 3001 | Frontend Next.js — perfil del cliente |
| PostgreSQL | 5432 | Base de datos local (Docker) |
| Mailpit SMTP | 1025 | Captura de emails (Docker) |
| Mailpit UI | 8025 | Web UI para ver emails capturados |

### Conexión directa a workers en local

En dev podés llamar cada worker directamente por su puerto,
sin pasar por el gateway. Esto es útil para debugging:

```bash
# Identity — login
curl -X POST http://localhost:8788/v1/auth/token \
  -H 'Content-Type: application/json' \
  -d '{"email":"demo@cafecentral.com","password":"demo123"}'

# Analytics — requiere headers inyectados por el gateway
curl -H 'X-User-Id: <uuid>' \
  -H 'X-Business-Id: <uuid>' \
  -H 'X-User-Role: admin' \
  http://localhost:8791/v1/analytics/kpis
```

### Quality Checks

```bash
pnpm -r typecheck   # TypeScript strict
pnpm -r lint        # ESLint 9
pnpm -r test        # Vitest (105+ tests)
```

---

## Estructura del Proyecto

```
vyloop/
├── apps/
│   ├── dashboard/          # Next.js 14 — merchant dashboard + POS emulator
│   ├── customer-web/       # Next.js 15 — PWA del cliente (QR, login, perfil)
│   └── gateway/            # Hono Worker — API Gateway (HTTP entry point)
├── workers/
│   ├── identity/           # Auth: JWT, API keys, event handler
│   ├── customer/           # Customer CRUD (360° profile, queue events)
│   ├── growth/             # Loyalty engine: puntos, tiers, wallet, consumer
│   ├── analytics/          # Placeholder — analíticas y reportes
│   ├── automation/         # Placeholder — automatizaciones
│   ├── communication/      # Placeholder — comunicación omnicanal
│   ├── compliance/         # Placeholder — compliance y auditoría
│   └── wallet/             # Google Wallet: pases de lealtad del cliente
├── packages/
│   ├── types/              # Domain types & branded IDs
│   ├── schemas/            # Zod validation schemas
│   ├── database/           # Drizzle ORM config & client
│   ├── config/             # Config reader
│   ├── utils/              # Shared utilities
│   ├── event-bus/          # Queue publish/consume helpers
│   ├── schema-registry/    # AJV schema registry
│   └── dashboard-cards/    # Customer detail card React SDK
├── tooling/
│   ├── typescript/         # Shared TS config
│   ├── eslint/             # ESLint flat config
│   ├── prettier/           # Prettier config
│   └── vitest/             # Vitest workspace config
├── docker/
│   ├── docker-compose.yml  # PostgreSQL 16 + Mailpit
│   └── postgres/init.sql
├── .github/workflows/
│   ├── ci.yml              # Quality checks (lint + typecheck + test)
│   └── deploy.yml          # Deploy a Cloudflare (workers + Pages)
├── docs/                   # Documentación
│   ├── prd/                # Product requirements & vision
│   ├── architecture/       # System design, DDD, API design
│   ├── operations/         # Onboarding, backlog
│   └── decisions/          # ADRs
└── TASKS.md                # Tareas realizadas y pendientes
```

## Documentación

Ver [docs/](./docs) para:

- **[Visión y producto](./docs/00-Product-Vision.md)** — qué estamos construyendo y por qué
- **[Arquitectura](./docs/07-Architecture.md)** — system design, DDD, API, DB
- **[Onboarding](./docs/17-Developer-Onboarding.md)** — reglas de oro y variables por worker
- **[Verificación y seguridad operativa](./docs/18-Verificacion-y-Seguridad-Operativa.md)** — bases de datos, migraciones, secretos, y cómo se verifica una herramienta antes de creerle
- **[Backlog](./docs/14-Backlog.md)** — lo que falta, con el estado real de cada cosa
- **[Google Wallet: crear una tarjeta](./docs/11-crear-tarjeta-lealtad.md)** — el alta de un negocio
- **[TASKS.md](./TASKS.md)** — Estado detallado de tareas

## Workers Deployados (Cloudflare)

| Worker | URL | Estado |
|--------|-----|--------|
| identity | `identity.cl-jmunoz.workers.dev` | ✅ Auth completa |
| customer | `customer.cl-jmunoz.workers.dev` | ✅ CRUD completo |
| growth | `growth.cl-jmunoz.workers.dev` | ✅ Loyalty engine |
| analytics | `analytics.cl-jmunoz.workers.dev` | 🔲 Placeholder |
| automation | `automation.cl-jmunoz.workers.dev` | 🔲 Placeholder |
| communication | `communication.cl-jmunoz.workers.dev` | 🔲 Placeholder |
| compliance | `compliance.cl-jmunoz.workers.dev` | 🔲 Placeholder |
| gateway | `gateway.cl-jmunoz.workers.dev` | ✅ API Gateway |

> El worker `wallet` está en producción en `wallet.cl-jmunoz.workers.dev` y sus rutas
> `/v1/wallet/*` están enrutadas por el gateway. Se despliega después que el gateway
> porque el gateway lo tiene como service binding.
>
> El detalle del pase está arriba, en *Google Wallet — estado real*. Para darle una
> tarjeta a un negocio nuevo: **[`docs/11-crear-tarjeta-lealtad.md`](docs/11-crear-tarjeta-lealtad.md)**.
> Hoy es un procedimiento manual —el alta de un tenant no crea su clase automáticamente—
> y el documento dice exactamente eso.

## PRs Completados (25+ mergeados)

| PR | Título |
|----|--------|
| #1 | Scaffolding — monorepo init, tooling, docs |
| #5 | Structural realignment |
| #6 | Data layer (15 tablas, RLS, Schema Registry) |
| #7 | Services (IAM, Gateway, Event Bus, Ingestor) |
| #8 | Customer Foundation (DB driver, events) |
| #9 | Gateway auth injection middleware |
| #10 | Customer Worker (CRUD, 25 tests) |
| #11 | Customer-web PWA registration flow |
| #12-15 | Growth Engine (foundation, endpoints, consumer, merge) |
| #16 | Dashboard PMV (login, sidebar, views) |
| #17 | Customer profile (points, tier, history) |
| #18 | Customer detail card + Cloudflare deployment |
| #19 | GitHub Actions deploy workflow |
| #20 | Fix CI pnpm version spec |
| — | Fix CI: Node v22, wrangler root dep, API token permissions |
| #39 | Backend PMV: /me, /transactions, seed-demo.ts |
| #40 | Dashboard sell: Registrar Venta modal |
| #41 | JWT expiry: clockTolerance in gateway + auto-redirect on 401 |
| #42 | Customer-web real data: profile, history, redeem fix |
| #43 | Profile redesign Propuesta A — QR, Oro achievement, empty state, tracking |
| #44 | POS Emulator — menu cafetería, carrito, QR scanner, cobro + puntos + canje |

---

### CI/CD: Cada push a `main` ejecuta

1. **quality** — lint + typecheck + test (105+ tests)
2. **deploy-workers** — 8 workers a Cloudflare Workers (matrix paralelo)
3. **deploy-dashboard** — build next-on-pages + Pages deploy
4. **deploy-customer-web** — build next-on-pages + Pages deploy

---

## License

TODO — not yet licensed.

---

_Vyloop — Build loyalty, grow your business._
.