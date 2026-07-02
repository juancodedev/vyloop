# 17-Developer-Onboarding.md
**[DOCUMENTO]:** Vyloop Developer Onboarding | **[VERSIÓN]:** v2.0 | **[ESTADO]:** Approved | **[RESPONSABLE]:** Founder

---

## Bienvenido a Vyloop

No estás aquí para construir un sistema de puntos. Estás aquí para construir el **Growth OS** global que hace que los clientes de miles de negocios físicos vuelvan solos — y que cada negocio sepa, antes de que ocurra, cuándo un cliente está a punto de no volver.

Antes de escribir una sola línea de código, lee los siguientes documentos en orden. No son opcionales.

| # | Documento | Por qué |
|---|---|---|
| 1 | `00-Product-Vision.md` | Entiende qué estamos construyendo y por qué |
| 2 | `01-Product-Manifesto.md` | Entiende cómo tomamos decisiones |
| 3 | `06-Domain-Driven-Design.md` | Entiende la arquitectura de dominios antes de tocar código |
| 4 | `07-Architecture.md` | Entiende el flujo de eventos — el núcleo del sistema |
| 5 | `09-Database-Design.md` | Entiende el modelo de datos antes de escribir cualquier query |

---

## Nuestras reglas de oro

### 1. Event-Driven primero
Antes de escribir una lógica de negocio, pregunta: **"¿Qué evento dispara esto, y qué eventos genera?"**

Si la respuesta no es clara, la lógica está en el lugar equivocado. Vuelve al `06-Domain-Driven-Design.md` y al `07-Architecture.md`.

### 2. Schema-First
Todo contrato de datos — un evento nuevo, un endpoint nuevo, un campo nuevo en un payload — debe estar documentado en el Schema Registry **antes** de implementarlo. El código es consecuencia del schema, no al revés.

### 3. Nunca un fork por país
Si estás creando una rama de código, un `if`, o una variable que dice `if country == "CL"`: **detente**. Busca el adaptador correspondiente en el dominio `Compliance` o en la capa de adaptadores de `Communication` o `Payment`. Lo que cambia por país es configuración o un adaptador — nunca lógica de negocio bifurcada.

### 4. El valor primero
Antes de hacer merge de cualquier feature, pregunta: **"¿Qué gana el negocio o el cliente final con esto?"**. Si la respuesta es solo técnica ("mejora la performance", "refactoriza el código"), está bien — pero debe haber una razón de negocio detrás. Lee el `01-Product-Manifesto.md` sección "Accionabilidad sobre información".

### 5. Idempotencia en los Workers
Los Workers que consumen eventos del bus pueden recibir el mismo evento más de una vez (at-least-once delivery). **Todo Worker debe ser idempotente**: procesar el mismo evento dos veces no debe generar duplicados ni efectos secundarios no deseados. Usa el `X-Request-ID` del header o el `id` del evento para detectar duplicados.

---

## Checklist del primer día

- [ ] **Acceso al repositorio:** Clona el monorepo `vyloop-core` desde el repositorio del equipo.
- [ ] **Setup del entorno local:**
  ```bash
  cp .env.example .env.local
  # Completa las variables de entorno (pedir al líder técnico)
  npx wrangler dev          # Levanta el API Gateway localmente
  # O alternativamente:
  docker-compose up         # Si prefieres todo en contenedores
  ```
- [ ] **Verifica la base de datos:** Corre las migraciones y verifica que RLS esté activo.
  ```bash
  npm run db:migrate
  npm run db:verify-rls
  ```
- [ ] **Tu primera tarea:** Crea un evento nuevo en el Schema Registry, publícalo al bus desde el Event Ingestor, y suscríbete a él desde el Worker del dominio `Customer`. Haz que el Worker loguee el payload recibido. Esto valida que tu entorno local funciona de extremo a extremo.
- [ ] **Lee la `00-Product-Vision.md`:** Es la única fuente de verdad sobre qué estamos construyendo.

---

## Estructura del monorepo

```
vyloop-core/
├── apps/
│   ├── gateway/          # API Gateway (Cloudflare Workers + Hono)
│   ├── dashboard/        # Next.js — interfaz del negocio
│   └── customer-web/     # Next.js PWA — landing del cliente final
├── workers/
│   ├── identity/         # Dominio Identity
│   ├── customer/         # Dominio Customer
│   ├── growth/           # Dominio Growth
│   ├── communication/    # Dominio Communication
│   ├── automation/       # Dominio Automation
│   ├── analytics/        # Dominio Analytics
│   └── compliance/       # Dominio Compliance
├── services/
│   └── ai/               # FastAPI (Python) — IA y ML (predicción de churn, Copilot)
├── packages/
│   ├── schema-registry/  # Definiciones de esquemas de eventos
│   ├── db/               # Migraciones y tipos de base de datos
│   └── config/           # Configuración compartida (no lógica de negocio)
└── docs/                 # Este repositorio de documentación
```

---

## Flujo de trabajo de desarrollo

```
1. Lee el ítem del backlog (14-Backlog.md) y su criterio de DoD
2. Identifica el dominio responsable (06-Domain-Driven-Design.md)
3. Define los eventos involucrados y actualiza el Schema Registry
4. Implementa el Worker o el endpoint
5. Escribe tests (caso principal + casos de error)
6. Verifica idempotencia si el Worker consume del bus
7. Solicita revisión antes del merge
```

---

## Convenciones de código

| Convención | Detalle |
|---|---|
| Lenguaje principal | TypeScript — tipado estricto en todo el monorepo |
| Nombres de eventos | PascalCase, tiempo pasado: `CustomerRegistered`, `PointsAssigned`, `ChurnRiskDetected` |
| Nombres de endpoints | kebab-case: `/v1/loyalty/points/assign` |
| Nombres de tablas | snake_case, plural: `customers`, `points_transactions` |
| Nombres de Workers | kebab-case: `growth-worker`, `customer-worker` |
| Commits | Conventional Commits: `feat:`, `fix:`, `docs:`, `refactor:` |
| Branches | `feature/nombre-descriptivo`, `fix/nombre-del-bug` |

---

## Contacto y soporte

Si tienes dudas sobre:
- **Decisiones de producto o alcance:** Lee el `04-Product-Requirements.md` primero. Si no está respondido ahí, consulta al Product Manager.
- **Decisiones de arquitectura:** Lee el `07-Architecture.md` y el `06-Domain-Driven-Design.md`. Si no está respondido ahí, consulta al Principal Architect.
- **Dudas de acceso o entorno:** Consulta directamente al líder técnico del equipo.

---

## Documento anterior

Este documento reemplaza:
- `17-Developer-Onboarding.md` v1.0 (Project Atlas)

