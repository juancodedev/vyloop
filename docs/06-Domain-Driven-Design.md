# 06-Domain-Driven-Design.md
**[DOCUMENTO]:** Vyloop Domain-Driven Design | **[VERSIÓN]:** v2.0 | **[ESTADO]:** Draft | **[RESPONSABLE]:** Principal Software Architect

---

## 1. Principio de diseño por dominios

Cada dominio (Bounded Context) es una unidad autónoma de lógica de negocio. Los dominios **nunca se llaman directamente entre sí** — se comunican exclusivamente publicando y consumiendo eventos del bus. Esto garantiza que un fallo en el dominio de Analytics no afecte el procesamiento de puntos, y que el dominio de Communication pueda escalar independientemente del resto.

---

## 2. Mapa de dominios (Bounded Contexts)

### Dominio 1 — Identity
**Responsabilidad:** Gestión de Tenants (negocios), usuarios del sistema, permisos y autenticación global.

| Entidad principal | Descripción |
|---|---|
| `tenant` | El negocio suscrito a Vyloop. Unidad raíz de multi-tenancy. |
| `branch` | Sucursal física de un tenant. |
| `user` | Empleado o administrador del negocio, con rol y permisos. |
| `api_key` | Credencial de acceso a la API pública, con scopes granulares. |

**Eventos que publica:**
- `TenantCreated` · `TenantUpdated` · `UserInvited` · `UserDeactivated`

---

### Dominio 2 — Customer
**Responsabilidad:** Perfil único del cliente final, incluyendo su identidad global y su historial de eventos.

| Entidad principal | Descripción |
|---|---|
| `customer` | Perfil del cliente final. Tiene un `global_id` y un contexto de `business_id`. |
| `customer_event` | Log inmutable de cada acción del cliente (Event Sourcing). Fuente de verdad del perfil 360°. |
| `consent` | Registro de consentimientos del cliente por tipo y jurisdicción. |

**El GlobalID es la pieza más importante de este dominio:**
- Es un identificador universal que trasciende la relación del cliente con un negocio específico.
- Permite que el mismo cliente sea reconocido en múltiples negocios de la red sin exponer sus datos entre ellos.
- Es la base técnica del cross-loyalty — sin GlobalID, los puntos no pueden validarse entre negocios de forma segura.

**Eventos que publica:**
- `CustomerRegistered` · `CustomerProfileUpdated` · `ConsentGranted` · `ConsentRevoked`

---

### Dominio 3 — Growth
**Responsabilidad:** Lógica de reglas de lealtad, cálculo de puntos, niveles de membresía y promociones.

| Entidad principal | Descripción |
|---|---|
| `loyalty_program` | Configuración del motor de puntos de un negocio (tasa de conversión, vencimiento, moneda de puntos). |
| `membership_tier` | Nivel de membresía (Bronze/Silver/Gold) con multiplicador y beneficios asociados. |
| `points_transaction` | Registro histórico de créditos y débitos de puntos. Inmutable. |
| `reward` | Premio o beneficio canjeable definido por el negocio. |
| `cross_loyalty_alliance` | Alianza entre dos tenants para compartir validez parcial de puntos. |
| `referral` | Registro de un cliente que refirió a otro, con el incentivo asociado. |

**Eventos que consume:**
- `PurchaseCompleted` → calcula y asigna puntos.
- `RewardRedeemed` → debita puntos y registra el canje.

**Eventos que publica:**
- `PointsAssigned` · `PointsRedeemed` · `TierUpgraded` · `ReferralRewarded`

---

### Dominio 4 — Communication
**Responsabilidad:** Orquestación de mensajería omnicanal mediante adaptadores por canal.

**Adaptadores implementados por fase:**

| Canal | Adaptador | Fase |
|---|---|---|
| WhatsApp | Meta Business API | PMV |
| Email | Resend | PMV |
| Push (iOS/Android) | Firebase Cloud Messaging | Fase 3 |
| SMS | Twilio / proveedor local | Fase 2 |

**Principio de adaptadores:** El dominio de Communication no sabe qué canal se usa por debajo. Recibe una instrucción (`send_message(customer_id, template, channel_preference)`) y el adaptador correspondiente la ejecuta. Agregar un canal nuevo (LINE, iMessage) es agregar un adaptador, no modificar el dominio.

**Eventos que consume:**
- `ChurnRiskDetected` → envía mensaje de retención.
- `PointsAssigned` → confirma acumulación al cliente final.
- `TierUpgraded` → notifica al cliente su nuevo nivel.

**Eventos que publica:**
- `MessageSent` · `MessageDelivered` · `MessageFailed`

---

### Dominio 5 — Automation
**Responsabilidad:** Motor de estados y disparadores — evalúa condiciones sobre eventos y ejecuta acciones configuradas por el negocio.

| Entidad principal | Descripción |
|---|---|
| `workflow` | Definición de trigger (evento), condiciones (AND/OR) y acciones (enviar mensaje, asignar puntos, etc.). |
| `workflow_execution` | Log de cada ejecución de un workflow, con resultado y timestamp. |

**Ejemplos de workflows predefinidos (PMV):**
- Cumpleaños: `CustomerBirthdayToday` → enviar WhatsApp con regalo de puntos.
- Inactividad: `CustomerInactiveDays >= N` → enviar recordatorio.
- Primera compra: `PurchaseCompleted` (si es la primera) → enviar bienvenida con puntos extra.

**Eventos que consume:** Cualquier evento del bus que coincida con el trigger de un workflow activo.

**Eventos que publica:**
- `WorkflowTriggered` · `WorkflowCompleted` · `WorkflowFailed`

---

### Dominio 6 — Analytics
**Responsabilidad:** Proyección de eventos en tiempo real hacia el Data Lake (ClickHouse) y exposición de consultas de BI, cohortes y segmentación masiva.

**Modelo de datos:** Cada evento del bus llega a este dominio y se inserta en ClickHouse. No se modifica — es append-only. El estado actual de una métrica es siempre el resultado de agregar eventos, no una columna actualizada en PostgreSQL.

**Capacidades por fase:**

| Capacidad | Fase |
|---|---|
| Segmentación AND/OR sobre atributos del cliente | PMV |
| Cohortes de retención | Fase 2 |
| Benchmarks entre negocios de la misma categoría | Fase 2 |
| Predicción de abandono (score RFM) | PMV (reglas) |
| Predicción de abandono (modelo ML) | Fase 2 |
| Business Copilot (consulta semántica) | Fase 2 |

**Eventos que consume:** Todos. Este dominio es suscriptor universal del bus.

---

### Dominio 7 — Compliance
**Responsabilidad:** Gestión de normativas locales de datos personales, impuestos, moneda y configuración regional por tenant.

| Entidad principal | Descripción |
|---|---|
| `localization_config` | Idioma, moneda, formato de identidad (RUT/CPF/DNI), zona horaria, normativa de datos aplicable. |
| `data_retention_policy` | Reglas de retención y eliminación de datos por jurisdicción. |
| `tax_config` | Configuración de impuestos aplicables por país (IVA, ISR, etc.). |

**Normativas cubiertas por fase:**

| Normativa | Jurisdicción | Fase |
|---|---|---|
| Ley 19.628 | Chile | PMV |
| LGPD | Brasil | Ola 2 |
| RGPD | Unión Europea | Ola 2 |
| CCPA | California, EEUU | Ola 3 |

---

## 3. Mapa de comunicación entre dominios

```
Evento en el Bus              Dominios suscriptores
─────────────────────────     ────────────────────────────────────
PurchaseCompleted         →   Growth, Customer, Analytics, AI, Automation
PointsAssigned            →   Customer, Communication, Analytics
TierUpgraded              →   Customer, Communication, Analytics
ChurnRiskDetected         →   Communication, Automation, Analytics
CustomerRegistered        →   Growth (inicializa wallet), Analytics
WorkflowTriggered         →   Communication (ejecuta la acción)
```

---

## 4. Regla de oro de la comunicación entre dominios

> **Ningún dominio importa código de otro dominio. Ningún dominio llama directamente a la API interna de otro dominio. Toda comunicación ocurre exclusivamente a través del bus de eventos.**

Si en una revisión de código aparece un import de un módulo de otro dominio, es un error de arquitectura que debe corregirse antes de hacer merge.

---

## 5. Documento anterior

Este documento reemplaza:
- `06-Domain-Driven-Design.md` v1.0 (Project Atlas)

