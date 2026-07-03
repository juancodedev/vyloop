# Vyloop — Estado de Tareas

> Actualizado: 3 Julio 2026

---

## ✅ COMPLETADO

### Infraestructura y Tooling
- [x] Monorepo pnpm workspace con shared configs (TS, ESLint, Prettier, Vitest)
- [x] Docker Compose para PostgreSQL 16 + Mailpit local
- [x] CI workflow: lint + typecheck + test en cada push
- [x] Deploy workflow (GitHub Actions → Cloudflare)
  - [x] 8 Workers deployados (identity, customer, growth, analytics, automation, communication, compliance, gateway)
  - [x] Dashboard Pages deployado en vyloop.juancode.dev
  - [x] Customer-web Pages deployado en vyloop-customer-web.pages.dev
- [x] CI/CD probado y funcionando — 11/11 jobs verdes ✅
- [x] Node.js actualizado a v22 para compatibilidad con undici v8
- [x] wrangler agregado como root devDependency para deploy de workers
- [x] Cloudflare API token con permisos correctos: Workers Scripts:Edit + Memberships:Read

### Base de Datos (PostgreSQL + Neon + Drizzle ORM)
- [x] Schema: 15 tablas (tenants, users, customers, loyalty_programs, tiers, points, rewards, etc.)
- [x] RLS policies para multi-tenancy
- [x] Seed script: Café Central demo (tiers, 10 customers, 50+ transacciones)
- [x] Migraciones Drizzle

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
- [ ] **Customer detail page** — Vista de perfil individual del cliente desde el dashboard
- [ ] **QR del negocio** — Página para mostrar/compartir el QR del comercio
- [ ] **CRUD de rewards** — UI para crear/editar rewards del programa de lealtad
- [ ] **Dashboard analytics** — KPIs (clientes nuevos, puntos emitidos, canjes)

### Customer Web
- [ ] **Auth real** — Reemplazar mock auth por autenticación real contra el gateway
- [ ] **Canje de rewards** — Flujo para que el cliente canjee sus puntos
- [ ] **Push notifications** — Notificaciones de puntos, niveles, rewards

### Otros
- [ ] **Design tokens** — Sistema de diseño unificado (colores, tipografía, spacing)
- [ ] **Modo oscuro** — Dark mode en dashboard y customer-web
- [ ] **Internacionalización** — Soporte multi-idioma (es, pt, en)
- [ ] **Tests end-to-end** — Playwright o Cypress para flujos críticos
- [ ] **Documentación API** — OpenAPI spec actualizada con todos los endpoints vivos
- [ ] **Licencia** — Definir y agregar licencia al proyecto

---

## Referencias Rápidas

### URLs de Producción

| App | URL |
|-----|-----|
| Dashboard | https://vyloop.juancode.dev |
| Customer Web | https://vyloop-customer-web.pages.dev |
| Gateway API | https://gateway.cl-jmunoz.workers.dev |

### Credenciales Demo

| Rol | Email / Teléfono | Contraseña |
|-----|------------------|-------------|
| Admin (Café Central) | admin@cafecentral.com | admin123 |
| Cliente (Lucía Fernández) | +56956789012 | (login con teléfono) |

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
