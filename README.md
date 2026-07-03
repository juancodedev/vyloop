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
| Growth Engine (puntos, tiers, wallet, consumer) | ✅ Completado |
| Dashboard PMV (login, sidebar, clientes, loyalty) | ✅ Completado |
| Customer detail card SDK | ✅ Completado |
| CI/CD automático (GitHub Actions → Cloudflare) | ✅ Completado |
| **Deployado y demo-list** | **✅ VIVO** |
| Growth Engine Phase 5 tests | 🔲 Pendiente |
| Workers placeholder (analytics, automation, communication, compliance) | 🔲 Implementar lógica de negocio |

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
3. Ves la tarjeta de Lucía Fernández: 1.200 pts, nivel Plata, progreso a Oro, últimos movimientos

### Demo: Dashboard

1. Entrá a [vyloop.juancode.dev](https://vyloop.juancode.dev)
2. Login con email `admin@cafecentral.com` / contraseña `admin123`
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
| **Infrastructure** | Docker Compose (dev), Cloudflare (prod) |
| **CI/CD** | GitHub Actions — quality checks + deploy automático |
| **SDK** | `@vyloop/dashboard-cards` — customer detail card component |
| **Tooling** | TypeScript strict, ESLint 9, Prettier, Vitest |

## Prerrequisitos

- **Node.js** >= 22 (ver `.nvmrc`)
- **pnpm** >= 9
- **Docker Desktop** (para PostgreSQL y Mailpit local)

## Getting Started

```bash
# Instalar dependencias
pnpm install

# Iniciar infraestructura local (PostgreSQL + Mailpit)
docker compose -f docker/docker-compose.yml up -d

# Ejecutar todo en modo dev
pnpm dev
```

### Puertos de Servicios

| Servicio | Puerto |
|----------|--------|
| API Gateway (dev) | 8787 |
| Dashboard (dev) | 3000 |
| Customer Web (dev) | 3001 |
| PostgreSQL | 5432 |
| Mailpit SMTP | 1025 |
| Mailpit UI | 8025 |

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
│   ├── dashboard/          # Next.js 14 — merchant dashboard
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

## PRs Completados (20 mergeados)

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

---

## License

TODO — not yet licensed.

---

_Vyloop — Build loyalty, grow your business._
