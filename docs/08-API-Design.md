# 08-API-Design.md
**[DOCUMENTO]:** Vyloop API Design | **[VERSIÓN]:** v2.0 | **[ESTADO]:** Draft | **[RESPONSABLE]:** Principal Software Architect

---

## 1. Filosofía de API

**API-First:** La interfaz web (dashboard) y la app nativa consumen exactamente los mismos endpoints públicos que consumirá un desarrollador externo. No existe una "API interna" separada de la pública — hay una sola API.

**REST + GraphQL:**
- REST para operaciones transaccionales: registro de clientes, asignación de puntos, canjes.
- GraphQL para consultas complejas de agregación, reportes y el Business Copilot — donde la flexibilidad del cliente para especificar el shape de la respuesta reduce el número de roundtrips.

**Versionamiento:** URI versioning (`/v1/`, `/v2/`). Nunca se introducen cambios breaking en una versión activa. Una versión se depreca con mínimo 6 meses de aviso.

**Estándar de respuesta:** JSON plano, con códigos HTTP estándar. Los errores siempre incluyen un `error_code` semántico además del status HTTP, para facilitar el manejo programático.

```json
// Respuesta de error estándar
{
  "error": {
    "code": "CUSTOMER_NOT_FOUND",
    "message": "No se encontró un cliente con el ID proporcionado.",
    "request_id": "uuid"
  }
}
```

---

## 2. Autenticación y seguridad

**Protocolo:** OAuth 2.0 + OpenID Connect (OIDC).

**API Keys:** Generadas por negocio (tenant), con scopes granulares:
- `read:customers` · `write:customers`
- `write:loyalty` · `read:analytics`
- `admin:billing` · `admin:webhooks`

**Headers obligatorios en toda petición autenticada:**

| Header | Descripción |
|---|---|
| `Authorization: Bearer {jwt}` | Token de acceso OAuth 2.0 |
| `X-Business-ID: {uuid}` | Identificador del tenant — validado contra el token. Primera línea de aislamiento multi-tenant. |
| `X-Request-ID: {uuid}` | Para idempotencia en operaciones críticas (asignación de puntos, canjes) — recomendado, no obligatorio |

**Multi-tenancy:** El `X-Business-ID` es validado en el API Gateway antes de que la petición llegue a cualquier Worker de dominio. Una petición con un `business_id` que no coincide con el token es rechazada con 403 sin llegar al backend.

---

## 3. Payload estándar con contexto de localización

Todo evento o acción que genere efectos de negocio debe incluir el contexto de localización necesario para el procesamiento multi-país:

```json
{
  "header": {
    "business_id": "uuid",
    "timestamp": "2026-06-30T12:00:00Z",
    "localization": {
      "country": "CL",
      "currency": "CLP",
      "timezone": "America/Santiago",
      "language": "es-CL"
    }
  },
  "payload": {
    // ... contenido específico del recurso o evento
  }
}
```

---

## 4. Estructura de endpoints por dominio

### Identity Platform

| Método | Endpoint | Descripción |
|---|---|---|
| POST | `/v1/auth/token` | Autenticación y obtención de JWT (OAuth 2.0) |
| POST | `/v1/auth/refresh` | Renovación de token sin re-autenticación |
| GET | `/v1/me` | Información del usuario autenticado y sus permisos |
| GET | `/v1/businesses/{id}` | Información del negocio (tenant) autenticado |
| GET | `/v1/businesses/{id}/branches` | Lista de sucursales del negocio |

### Customer Platform

| Método | Endpoint | Descripción |
|---|---|---|
| GET | `/v1/customers` | Lista de clientes con filtros avanzados de segmentación (AND/OR) |
| POST | `/v1/customers` | Registro de nuevo perfil de cliente |
| GET | `/v1/customers/{id}` | Perfil 360°: eventos, puntos, historial, score de churn |
| PATCH | `/v1/customers/{id}` | Actualización de datos de perfil |
| DELETE | `/v1/customers/{id}` | Eliminación por solicitud del cliente (cumplimiento GDPR/LGPD) |
| GET | `/v1/customers/{id}/events` | Timeline de eventos del cliente (Customer360) |
| POST | `/v1/customers/{id}/consents` | Registro de consentimiento |

### Growth Platform

| Método | Endpoint | Descripción |
|---|---|---|
| POST | `/v1/loyalty/points/assign` | Asignación de puntos — publica evento `PointsAssigned` |
| POST | `/v1/loyalty/rewards/redeem` | Canje de beneficio — publica evento `RewardRedeemed` |
| GET | `/v1/loyalty/tiers` | Niveles de membresía activos con multiplicadores |
| GET | `/v1/loyalty/programs/{id}` | Configuración del programa del negocio |
| PATCH | `/v1/loyalty/programs/{id}` | Actualización de reglas del programa |
| GET | `/v1/loyalty/alliances` | Alianzas cross-loyalty activas del negocio |

### Automation & Communication

| Método | Endpoint | Descripción |
|---|---|---|
| GET | `/v1/automation/workflows` | Lista de workflows del negocio |
| POST | `/v1/automation/workflows` | Creación de workflow personalizado |
| PATCH | `/v1/automation/workflows/{id}` | Actualización de workflow |
| DELETE | `/v1/automation/workflows/{id}` | Eliminación de workflow |
| POST | `/v1/communication/send` | Envío omnicanal (WhatsApp/Email/Push) basado en template |

### Analytics & AI

| Método | Endpoint | Descripción |
|---|---|---|
| GET | `/v1/analytics/overview` | KPIs principales del negocio (retención, puntos, NPS) |
| GET | `/v1/analytics/cohorts` | Análisis de retención por cohortes |
| GET | `/v1/analytics/churn-risk` | Lista de clientes con score de riesgo alto |
| GET | `/v1/analytics/benchmarks` | Métricas del negocio vs. promedio de su categoría |
| POST | `/v1/ai/copilot/query` | Consulta semántica al Business Copilot (Fase 2) |

### Events (ingesta directa al bus)

| Método | Endpoint | Descripción |
|---|---|---|
| POST | `/v1/events/purchase` | Compra completada desde POS o sistema externo |
| POST | `/v1/events/custom` | Evento personalizado definido por el negocio |

---

## 5. Webhooks — suscripción a eventos del sistema

Para que servicios externos reaccionen en tiempo real a lo que ocurre en Vyloop:

| Evento | Cuándo se dispara |
|---|---|
| `events.customer.created` | Nuevo cliente registrado en el programa |
| `events.loyalty.points_assigned` | Puntos acreditados a un cliente |
| `events.loyalty.points_redeemed` | Beneficio canjeado por un cliente |
| `events.loyalty.tier_upgraded` | Cliente sube de nivel de membresía |
| `events.automation.workflow_triggered` | Workflow disparado por condición cumplida |
| `events.ai.churn_risk_alerted` | Cliente supera umbral de riesgo de abandono |
| `events.communication.message_sent` | Mensaje enviado al cliente final |

**Especificación de entrega:**
- HTTPS POST al endpoint configurado por el negocio.
- Firma HMAC-SHA256 en el header `X-Vyloop-Signature` para validar autenticidad.
- At-least-once delivery con reintentos exponenciales (1s, 5s, 30s, 5min, 30min).
- Playground de pruebas disponible en el dashboard para validar el endpoint antes de activar.

---

## 6. Documentación y SDKs

| Recurso | Descripción | Fase |
|---|---|---|
| OpenAPI / Swagger | Generación automática sincronizada con el código — nunca documentación desactualizada | PMV |
| SDK Node.js | Adopción rápida para integradores en el ecosistema JavaScript/TypeScript | Fase 2 |
| SDK Python | Para integradores con stack data/ML y para el propio servicio de IA interno | Fase 2 |
| SDK PHP | Para adopción en el mercado pyme LatAm donde PHP tiene alta penetración (WordPress, Laravel) | Fase 3 |
| Marketplace Playground | Entorno de pruebas para webhooks y plugins de terceros antes del despliegue | Fase 3 |

---

## 7. Códigos de error semánticos (referencia)

| Código | Status HTTP | Significado |
|---|---|---|
| `AUTH_TOKEN_INVALID` | 401 | Token expirado o malformado |
| `AUTH_BUSINESS_MISMATCH` | 403 | El `X-Business-ID` no coincide con el token |
| `CUSTOMER_NOT_FOUND` | 404 | Cliente no existe en el tenant |
| `POINTS_INSUFFICIENT` | 400 | Saldo insuficiente para el canje solicitado |
| `SCHEMA_INVALID` | 400 | El payload del evento no cumple el esquema registrado |
| `RATE_LIMIT_EXCEEDED` | 429 | Límite de peticiones por minuto superado |
| `TENANT_SUSPENDED` | 403 | La suscripción del negocio está suspendida |

---

## 8. Documento anterior

Este documento reemplaza:
- `08-API-Design.md` v1.0 (Project Atlas)

