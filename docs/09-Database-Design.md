# 09-Database-Design.md
**[DOCUMENTO]:** Vyloop Data Schema | **[VERSIÓN]:** v2.0 | **[ESTADO]:** Draft | **[RESPONSABLE]:** Principal Software Architect

---

## 1. Estrategia de persistencia

**Decisión confirmada:** Multi-tenancy mediante `business_id` en tablas compartidas con Row-Level Security (RLS) en PostgreSQL. **No se usa schema por tenant.**

**Por qué:**
- Las migraciones se ejecutan una sola vez, sin importar cuántos negocios existan.
- Las métricas comparativas entre negocios de la misma categoría (benchmarks) son una sola query con `GROUP BY category, country` — con schema por tenant serían consultas cross-schema o una tabla de agregación sincronizada constantemente.
- El pool de conexiones es uno solo — predecible y escalable.
- El aislamiento de seguridad por RLS es equivalente al de schema por tenant, aplicado a nivel de fila en lugar de nivel de base de datos.

**Cuándo reconsiderar:** Solo si en una fase posterior se incorporan clientes enterprise con exigencia contractual de aislamiento físico de datos. No aplica para el PMV ni la Fase 2.

---

## 2. Dos motores de persistencia

| Motor | Tecnología | Uso | Fase |
|---|---|---|---|
| Transaccional (OLTP) | PostgreSQL (Neon serverless) | Estado actual de entidades, transacciones de puntos, perfil del cliente | PMV |
| Analítico (OLAP) | ClickHouse Cloud | Data Lake de eventos, cohortes, segmentación masiva, benchmarks | Fase 2 |

Durante el PMV, el `customer_events` en PostgreSQL cubre las necesidades analíticas. ClickHouse se incorpora cuando el volumen de negocios genera suficientes datos para que las consultas analíticas complejas aporten valor real y empiecen a afectar la performance del PostgreSQL principal.

---

## 3. Schema Core — PostgreSQL

### Dominio Identity

```sql
-- El negocio suscrito a Vyloop (tenant raíz)
CREATE TABLE tenants (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  slug            TEXT NOT NULL UNIQUE,         -- para URLs del negocio
  plan            TEXT NOT NULL DEFAULT 'free', -- free | pro | business | enterprise
  status          TEXT NOT NULL DEFAULT 'active',
  base_currency   TEXT NOT NULL DEFAULT 'CLP',
  timezone        TEXT NOT NULL DEFAULT 'America/Santiago',
  country         TEXT NOT NULL DEFAULT 'CL',
  language        TEXT NOT NULL DEFAULT 'es-CL',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Sucursales físicas de un tenant
CREATE TABLE branches (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  address         TEXT,
  city            TEXT,
  country         TEXT NOT NULL,
  timezone        TEXT,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Usuarios del sistema (empleados y administradores)
CREATE TABLE users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email           TEXT NOT NULL,
  full_name       TEXT,
  role            TEXT NOT NULL DEFAULT 'cashier', -- owner | admin | cashier
  branch_id       UUID REFERENCES branches(id),    -- NULL = acceso a todas las sucursales
  is_active       BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(business_id, email)
);
```

### Dominio Customer

```sql
-- Perfil del cliente final
CREATE TABLE customers (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id       UUID NOT NULL DEFAULT gen_random_uuid(), -- identidad cross-loyalty
  business_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  phone           TEXT,
  email           TEXT,
  full_name       TEXT,
  birth_date      DATE,
  identity_doc    TEXT,                -- RUT / CPF / DNI / CURP según país
  identity_type   TEXT,                -- rut | cpf | dni | curp
  language        TEXT DEFAULT 'es',
  opted_in_at     TIMESTAMPTZ,         -- fecha de registro al programa
  last_visit_at   TIMESTAMPTZ,
  current_tier_id UUID REFERENCES membership_tiers(id),
  member_code     TEXT,                -- código corto del pase de lealtad (Google Wallet); NULL = sin pase
  metadata        JSONB DEFAULT '{}',  -- atributos dinámicos extensibles
  deleted_at      TIMESTAMPTZ,         -- soft delete
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(business_id, phone),
  UNIQUE(business_id, email)
);
-- Código del pase de lealtad, único por tenant. Parcial a propósito: la
-- restricción no significa nada para NULL, y un índice no parcial cargaría una
-- entrada por cada cliente existente, todas inútiles.
CREATE UNIQUE INDEX uq_customers_business_member_code
  ON customers(business_id, member_code) WHERE member_code IS NOT NULL;

-- Log inmutable de eventos del cliente (Event Sourcing / Customer360)
CREATE TABLE customer_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id     UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  event_type      TEXT NOT NULL,       -- visit | points_assigned | reward_redeemed | message_sent | nps_submitted | etc.
  branch_id       UUID REFERENCES branches(id),
  payload         JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Índice para consultas del Customer360 por cliente
CREATE INDEX idx_customer_events_customer ON customer_events(business_id, customer_id, created_at DESC);
-- Índice para consultas analíticas por tipo de evento
CREATE INDEX idx_customer_events_type ON customer_events(business_id, event_type, created_at DESC);

-- Registro de consentimientos (GDPR/LGPD)
CREATE TABLE consents (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id     UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  consent_type    TEXT NOT NULL,       -- marketing | analytics | third_party
  granted         BOOLEAN NOT NULL,
  granted_at      TIMESTAMPTZ,
  revoked_at      TIMESTAMPTZ,
  ip_address      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### Dominio Growth

```sql
-- Configuración del programa de fidelidad del negocio
CREATE TABLE loyalty_programs (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id         UUID NOT NULL UNIQUE REFERENCES tenants(id) ON DELETE CASCADE,
  name                TEXT NOT NULL DEFAULT 'Programa de beneficios',
  points_currency     TEXT NOT NULL DEFAULT 'puntos',  -- nombre personalizable
  earn_rate           NUMERIC(10,4) NOT NULL DEFAULT 1.0, -- puntos por unidad de moneda
  min_redeem_points   INTEGER NOT NULL DEFAULT 100,
  points_expiry_days  INTEGER,         -- NULL = no vencen
  is_active           BOOLEAN NOT NULL DEFAULT true,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Niveles de membresía (Bronze, Silver, Gold, Platinum)
CREATE TABLE membership_tiers (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  program_id          UUID NOT NULL REFERENCES loyalty_programs(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,   -- Bronze | Silver | Gold | Platinum
  min_points          INTEGER NOT NULL DEFAULT 0,
  multiplier          NUMERIC(4,2) NOT NULL DEFAULT 1.0,
  benefits            JSONB DEFAULT '[]',
  display_order       INTEGER NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Historial de transacciones de puntos (inmutable)
CREATE TABLE points_transactions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id     UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  branch_id       UUID REFERENCES branches(id),
  type            TEXT NOT NULL,       -- earn | redeem | adjustment | expiry | referral
  points          INTEGER NOT NULL,    -- positivo = crédito, negativo = débito
  balance_after   INTEGER NOT NULL,
  reference_id    TEXT,               -- ID de la compra en el POS, o ID de canje
  note            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_points_transactions_customer ON points_transactions(business_id, customer_id, created_at DESC);

-- Alianzas cross-loyalty entre negocios
CREATE TABLE cross_loyalty_alliances (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_a_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  tenant_b_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  earn_rate_ab    NUMERIC(4,2) NOT NULL DEFAULT 0.5, -- % de puntos de A válidos en B
  earn_rate_ba    NUMERIC(4,2) NOT NULL DEFAULT 0.5,
  status          TEXT NOT NULL DEFAULT 'pending',   -- pending | active | suspended
  activated_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(tenant_a_id, tenant_b_id)
);

-- Referidos entre clientes
CREATE TABLE referrals (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  referrer_id     UUID NOT NULL REFERENCES customers(id),
  referred_id     UUID NOT NULL REFERENCES customers(id),
  points_awarded  INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'pending',   -- pending | completed | cancelled
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### Dominio Automation & AI

```sql
-- Definición de workflows de automatización
CREATE TABLE workflows (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  trigger_event   TEXT NOT NULL,       -- CustomerBirthdayToday | CustomerInactiveDays | etc.
  conditions      JSONB DEFAULT '[]',  -- array de condiciones AND/OR
  actions         JSONB NOT NULL,      -- array de acciones a ejecutar
  is_active       BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Log de ejecuciones de workflows
CREATE TABLE workflow_executions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workflow_id     UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  customer_id     UUID REFERENCES customers(id),
  status          TEXT NOT NULL,       -- triggered | completed | failed
  error           TEXT,
  executed_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Resultados del motor de predicción de abandono
CREATE TABLE churn_predictions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id     UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  score           NUMERIC(5,4) NOT NULL,  -- 0.0 (sin riesgo) a 1.0 (abandono inminente)
  risk_level      TEXT NOT NULL,          -- low | medium | high | critical
  rfm_recency     INTEGER,               -- días desde la última visita
  rfm_frequency   INTEGER,               -- visitas en los últimos 90 días
  rfm_monetary    NUMERIC(12,2),         -- valor total en los últimos 90 días
  model_version   TEXT NOT NULL DEFAULT 'rfm-v1',
  calculated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(business_id, customer_id)        -- solo el score más reciente
);
```

### Dominio Communication

```sql
-- Log de mensajes enviados y recibidos por el cliente final
CREATE TABLE message_log (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id         UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  direction           TEXT NOT NULL,       -- texto libre; el schema no lo enumera
  channel             TEXT NOT NULL DEFAULT 'whatsapp',
  status              TEXT NOT NULL DEFAULT 'queued',  -- 'queued' y 'failed' son los que escribe el worker
  provider_message_id TEXT,
  content             JSONB DEFAULT '{}',
  metadata            JSONB DEFAULT '{}',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Historial de mensajes de un cliente, más reciente primero
CREATE INDEX idx_message_log_customer
  ON message_log(business_id, customer_id, created_at DESC);
-- Filtrado del dashboard de entrega por estado
CREATE INDEX idx_message_log_status
  ON message_log(business_id, status, created_at DESC);

-- Templates de WhatsApp por negocio
CREATE TABLE whatsapp_templates (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  language          TEXT NOT NULL,
  category          TEXT NOT NULL,
  body              TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending',
  meta_template_id  TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Resolver un template por negocio y nombre al renderizar una campaña
CREATE INDEX idx_whatsapp_templates_name ON whatsapp_templates(business_id, name);
```

### Dominio Wallet (Google Wallet)

Ambas tablas son **solo estado de seguimiento**. El saldo y el programa se quedan donde ya estaban (`points_transactions`, `loyalty_programs`, `membership_tiers`): hay una sola fuente de verdad y el pase es una proyección, no un segundo ledger.

```sql
-- Un pase de clase de Google Wallet por negocio (tenant)
CREATE TABLE tenant_wallet_programs (
  tenant_id      UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  issuer_id      TEXT NOT NULL,        -- id de emisor entregado por Google
  class_id       TEXT NOT NULL,        -- <issuerId>.tenant-<tenantId>
  review_status  TEXT NOT NULL DEFAULT 'none',  -- none | draft | under_review | approved | rejected
  last_synced_at TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Un pase de Google Wallet por cliente
CREATE TABLE customer_wallet_passes (
  customer_id   UUID PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  object_id     TEXT NOT NULL,        -- <issuerId>.member-<globalId>
  state         TEXT NOT NULL DEFAULT 'not_issued',  -- not_issued | issued | inactive | expired | completed
  last_synced_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(tenant_id, object_id)
);
-- Buscar el pase de un cliente por tenant
CREATE INDEX idx_customer_wallet_passes_tenant ON customer_wallet_passes(tenant_id);
```

`issuer_id` es el mismo para todos los tenants, pero se guarda por fila para que migrar a otro emisor sea un cambio de datos y no de código. `tenant_wallet_programs.tenant_id` es a la vez clave primaria y única clave: exactamente una clase por tenant. `object_id` se deriva de `customers.global_id` y no de `customers.id`, para que el id del pase sobreviva a un restore o a un clon de base de datos.

### Dominio Compliance

```sql
-- Configuración de localización por tenant
CREATE TABLE localization_configs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL UNIQUE REFERENCES tenants(id) ON DELETE CASCADE,
  country         TEXT NOT NULL,
  language        TEXT NOT NULL,
  currency        TEXT NOT NULL,
  id_format       TEXT NOT NULL,       -- rut | cpf | dni | curp | none
  privacy_law     TEXT NOT NULL,       -- ley_19628 | lgpd | rgpd | ccpa | none
  data_retention_days INTEGER DEFAULT 1825, -- 5 años por defecto
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

---

## 4. Row-Level Security (RLS) — implementación

**Estado actual: RLS no está desplegado.** La estrategia de la sección 1 (multi-tenancy por `business_id` con RLS) sigue siendo la decisión de diseño, pero el rollout está staged, no completo. Los tres hechos que hay que conocer:

1. `withRls(db, businessId)` en los workers solo ejecuta `SET app.current_business_id`. Eso, por sí solo, **no aísla nada**: sin políticas creadas y sin `ALTER TABLE ... ENABLE ROW LEVEL SECURITY`, la sesión ve todas las filas. El aislamiento real de hoy descansa en los filtros explícitos de `business_id` en los handlers de ruta.
2. El mecanismo existe y está probado: `packages/db/src/rls.ts` expone `BUSINESS_ID_TABLES` (17 tablas con `business_id`), `TENANT_ID_TABLES`, `RLS_POLICY_NAME` (`tenant_isolation`) y `createRlsPolicies()`. `createRlsPolicies()` **no se llama en código de producción**; está disponible para el rollout.
3. Hay dos formas de scope porque hay dos formas de clave. `app.current_business_id` para las tablas con `business_id`, y `app.current_tenant_id` para las dos tablas de wallet, que están indexadas por `tenant_id` y no tienen esa columna. Una política `USING (business_id = ...)` sobre una tabla sin `business_id` es un error duro al crearse, no un no-op silencioso, y el test suite lo verifica.

```sql
-- Habilitar RLS en todas las tablas con business_id
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE points_transactions ENABLE ROW LEVEL SECURITY;
-- (aplicar a todas las tablas del schema)

-- Política: un usuario solo ve las filas de su propio business_id
-- El business_id del contexto se inyecta desde el API Gateway vía set_config
CREATE POLICY tenant_isolation ON customers
  USING (business_id = current_setting('app.current_business_id')::UUID);

-- Las tablas de wallet usan su propia variable, porque no tienen business_id
CREATE POLICY tenant_isolation ON customer_wallet_passes
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID);

-- El API Gateway ejecuta antes de cada query:
-- SET LOCAL app.current_business_id = 'uuid-del-tenant-autenticado';
```

`workers/wallet` ya usa el mecanismo con scope de tenant: `openTenantSession` en `drizzle-store.ts` ejecuta `setCurrentBusinessId(tenantId)` y `setCurrentTenantId(tenantId)` antes de leer nada, usando los builders que exporta `@vyloop/db`. Poner las dos variables desde el inicio es deliberado: una variable faltante es invisible hasta que la política correspondiente se habilite, que es el peor momento para descubrirlo.

---

## 5. Índices críticos para performance en el PMV

```sql
-- Búsqueda de clientes por teléfono (flujo más frecuente en el punto de venta)
CREATE INDEX idx_customers_phone ON customers(business_id, phone) WHERE phone IS NOT NULL;

-- Clientes inactivos (base de las alertas de churn)
CREATE INDEX idx_customers_last_visit ON customers(business_id, last_visit_at DESC NULLS LAST);

-- Balance de puntos actual (calculado desde transactions — índice para acelerarla)
CREATE INDEX idx_points_balance ON points_transactions(business_id, customer_id, created_at DESC);

-- Atributos dinámicos del cliente (JSONB) para segmentación
CREATE INDEX idx_customers_metadata ON customers USING GIN(business_id, metadata);
```

### 5.1 La deuda de índices que existía en `main` hasta `0004`

Un hallazgo que no aparece en el diseño sino en el historial, y que conviene documentar porque su causa no es la evidente:

**Los índices estaban declarados en `packages/db/src/indexes.ts` como exports a nivel de módulo, y ninguno existía en la base de datos.** `index('x').on(...)` devuelve un `IndexBuilder`; solo `IndexBuilder.build(table)` lo adjunta, y eso ocurre dentro del callback de extra-config de una tabla. drizzle-kit lee el archivo, encuentra builders sin tabla propietaria y los **descarta en silencio**, reportando cero índices y ningún cambio. Agregar `indexes.ts` al array `schema` de `drizzle.config.ts` se probó y es un **no-op**.

La migración `packages/db/drizzle/0004_chubby_crystal.sql` cierra esa deuda junto con dos tablas que estaban en el schema y en ninguna migración (`message_log` y `whatsapp_templates`, que el worker de communication leía y escribía sin que existieran). La migración emite **14 sentencias `CREATE (UNIQUE) INDEX`**: 12 declaraciones preexistentes ajenas a wallet, más 2 de wallet (`idx_customer_wallet_passes_tenant` y `uq_customers_business_member_code`).

**Consecuencia de diseño que sigue vigente:** las declaraciones de índice viven ahora dentro del callback de extra-config de cada tabla en `schema.ts`, no en `indexes.ts`. `indexes.ts` pasó a ser un registro **derivado** (`getTableConfig(table).indexes` más `indexByName`), de modo que no puede quedar desalineado del schema: si un índice se elimina de un callback, el lookup lanza en vez de exportar un builder obsoleto.

---

## 6. Estrategia de escalabilidad

| Cuándo | Acción |
|---|---|
| >10M filas en `customer_events` | Activar particionado por `business_id` y rango de fecha |
| >50M eventos/día | Migrar el destino analítico de PostgreSQL a ClickHouse Cloud |
| >500 tenants activos | Evaluar read replicas en Neon para separar carga de lectura |
| Requerimiento enterprise de aislamiento físico | Schema o base de datos separada por cliente — solo para enterprise contractual |

---

## 7. Documento anterior

Este documento reemplaza:
- `09-Database-Design.md` v1.0 (Project Atlas)
- Sección de modelo de datos del `Vyloop SDD v1` (aprobado)

