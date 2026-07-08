# Vyloop

**Loyalty & Engagement SaaS for LatAm SMBs.**

Vyloop es una plataforma multi-tenant de lealtad y engagement para PyMEs en Latinoamérica. Los comercios pueden crear y gestionar programas de fidelización con check-in por QR, puntos, rewards, niveles, y comunicación omnicanal — con una demo funcional para ventas.

> Monorepo: apps, workers, packages compartidos, tooling e infraestructura.

---

## Estado del Proyecto

| Hito | Estado |
|------|--------|
| Monorepo structure + tooling | ✅ Completado |
| DB schema (15 tablas, Drizzle ORM) | ✅ Completado |
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
| CI/CD automático (GitHub Actions → Cloudflare) | ✅ 11/11 jobs verdes |
| **Deployado y demo-list** | **✅ VIVO** |

---

## Links en Producción

| App | URL | Descripción |
|-----|-----|-------------|
| Dashboard | [vyloop.juancode.dev](https://vyloop.juancode.dev) | Login + gestión del comercio |
| Customer Web | [vyloop-customer-web.pages.dev](https://vyloop-customer-web.pages.dev) | Tarjeta de puntos del cliente |
| API Gateway | `gateway.cl-jmunoz.workers.dev` | Backend API (8 workers) |

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
| **Database** | PostgreSQL 16 (Neon), Drizzle ORM |
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
│   └── compliance/         # Placeholder — compliance y auditoría
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

- **[PRD y Visión de Producto](./docs/prd/)** — requirements, mercado, business model
- **[Arquitectura](./docs/architecture/)** — system design, DDD, API, DB
- **[Operaciones](./docs/operations/)** — onboarding, backlog
- **[ADR](./docs/decisions/)** — Architecture Decision Records
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
