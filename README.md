# Vyloop

**Loyalty & Engagement SaaS for LatAm SMBs.**

Vyloop is a multi-tenant loyalty and customer engagement platform designed for small and medium businesses in Latin America. It enables merchants to create, manage, and grow loyalty programs through QR-based check-in, rewards, automated marketing, and omnichannel communication.

> This repository is the monorepo — shared packages, services, applications, tooling, and infrastructure.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **Workspace** | pnpm 9 — apps, services, packages, tooling |
| **Frontend** | Next.js 14 (App Router), TypeScript |
| **Services** | Cloudflare Workers + Hono |
| **Database** | PostgreSQL 16, Drizzle ORM |
| **Infrastructure** | Docker Compose (local dev), Cloudflare (production) |
| **Tooling** | TypeScript (strict), ESLint 9, Prettier, Vitest |

## Prerequisites

- **Node.js** >= 20 (see `.nvmrc`)
- **pnpm** >= 9
- **Docker Desktop** (for local PostgreSQL and Mailpit)

## Getting Started

```bash
# Install all workspace dependencies
pnpm install

# Start local infrastructure (PostgreSQL + Mailpit)
docker compose -f docker/docker-compose.yml up -d

# Run all packages, services, and apps in dev mode
pnpm dev
```

### Service Ports

| Service | Port |
|---------|------|
| API Gateway (dev) | 8787 |
| Dashboard (dev) | 3000 |
| PostgreSQL | 5432 |
| Mailpit SMTP | 1025 |
| Mailpit UI | 8025 |

### Quality Checks

```bash
pnpm -r typecheck   # TypeScript compilation check
pnpm -r lint        # ESLint across workspace
pnpm -r test        # Vitest test suite
```

## Project Structure

```
vyloop/
├── apps/
│   └── dashboard/          # Next.js 14 — merchant dashboard
├── services/
│   ├── api-gateway/        # Hono Worker — HTTP entry point
│   ├── identity/           # Identity bounded context (placeholder)
│   ├── customer/           # Customer bounded context (placeholder)
│   └── growth/             # Growth bounded context (placeholder)
├── packages/
│   ├── types/              # Domain types & branded identifiers
│   ├── schemas/            # Zod validation schemas
│   ├── database/           # Drizzle ORM config & client
│   ├── config/             # Environment config reader
│   └── utils/              # Shared utilities
├── tooling/
│   ├── typescript/         # Shared TS config
│   ├── eslint/             # Shared ESLint flat config
│   ├── prettier/           # Shared Prettier config
│   └── vitest/             # Vitest workspace config
├── docker/
│   ├── docker-compose.yml  # PostgreSQL 16 + Mailpit
│   └── postgres/init.sql   # DB extensions & setup
├── .github/workflows/ci.yml
├── docs/                   # Documentation
│   ├── prd/                # Product requirements & vision
│   ├── architecture/       # System design & architecture docs
│   ├── operations/         # Backlog & onboarding
│   └── decisions/          # Architecture Decision Records (ADRs)
└── ...config files
```

## Documentation

See the [docs](./docs) directory for:

- **[Product Vision & PRD](./docs/prd/)** — product requirements, market research, business model
- **[Architecture](./docs/architecture/)** — system design, DDD, API design, database design
- **[Operations](./docs/operations/)** — developer onboarding, backlog
- **[Decisions](./docs/decisions/)** — ADRs (in progress)

## License

TODO — not yet licensed.

---

_Vyloop — Build loyalty, grow your business._
