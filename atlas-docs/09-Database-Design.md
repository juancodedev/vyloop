# 09-Database-Design.md
**[DOCUMENTO]:** Vyloop Data Schema | **[VERSIÓN]:** v1.0 | **[ESTADO]:** Draft | **[RESPONSABLE]:** Principal Software Architect

## 1. Estrategia de Persistencia
*   **Modelo:** Multi-tenancy mediante `business_id` en tablas principales.
*   **Seguridad:** Implementación de *Row-Level Security* (RLS) en PostgreSQL para asegurar aislamiento de datos[cite: 3, 4].
*   **Consistencia:** Las relaciones de clave foránea garantizan integridad referencial dentro de cada tenant.

## 2. Entidades Principales (Schema Core)

### A. Dominio Identity
- `tenants`: Información global del negocio (Suscripción, moneda base, zona horaria, configuración local)[cite: 3].
- `branches`: Sucursales vinculadas a un `tenant_id`.
- `users`: Usuarios del sistema (empleados/admin) con roles vinculados a `tenant_id`.

### B. Dominio Customer
- `customers`: Perfil 360°. `Global_ID` (unificador) + `business_id` (contexto).
- `customer_events`: Log inmutable de cada acción del cliente (Event Sourcing)[cite: 3].

### C. Dominio Growth
- `loyalty_programs`: Configuración del motor de puntos (tasa de conversión, vencimientos).
- `points_transactions`: Registro histórico de créditos/débitos de puntos.
- `membership_tiers`: Definición de niveles (Bronze, Silver, Gold) y sus multiplicadores[cite: 3].

### D. Dominio Automation & AI
- `workflows`: Definición de triggers, condiciones y acciones[cite: 3].
- `churn_predictions`: Resultados del motor de ML (score de riesgo + fecha de cálculo)[cite: 3, 4].

## 3. Modelo Relacional Simplificado
*   `tenants` 1 — * `branches`
*   `tenants` 1 — * `customers`
*   `tenants` 1 — 1 `loyalty_programs`
*   `customers` 1 — * `points_transactions`
*   `customers` 1 — * `customer_events`[cite: 3]

## 4. Estrategia de Escalabilidad
*   **Sharding:** Preparado para particionar la tabla `customer_events` por `business_id` conforme el volumen de eventos supere los cientos de millones[cite: 3].
*   **Time-Series Optimization:** Uso de índices GIN para búsquedas rápidas en campos JSONB (preferencias y atributos dinámicos del cliente).