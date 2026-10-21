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
| GET | `/v1/businesses/{id}/branches` | Lista de sucursales del negocio, con su posición geográfica cuando la registró (`latitude`, `longitude`, `geohash`, `geohash_precision`, `located_at`) |
| POST | `/v1/businesses/{id}/branches` | Crea una sucursal; la posición es opcional y se envía como `latitude` + `longitude` o `geohash` |
| PATCH | `/v1/businesses/{id}/branches/{branchId}` | Actualiza una sucursal y, si vienen, sus coordenadas |
| DELETE | `/v1/businesses/{id}/branches/{branchId}` | Desactiva la sucursal (`is_active: false`); no borra la fila |

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

Requiere JWT y `X-Business-ID`, como el resto de `/v1/*`. El `business_id` del sobre sale del token; si el body declara otro comercio, la respuesta es 403 `EVENT_BUSINESS_MISMATCH`. El `{tipo}` de la ruta se resuelve contra el Schema Registry, que el job `register-schemas` rellena en cada deploy: KV guarda `{tipo}:latest` y `{tipo}:1.0.0`, y las claves son PascalCase. Cualquier nombre que no esté registrado responde 404 `EVENT_TYPE_UNKNOWN`.

| Método | Endpoint | Descripción |
|---|---|---|
| POST | `/v1/events/CustomerRegistered` | Alta de cliente |
| POST | `/v1/events/CustomerCheckedIn` | Check-in en local |
| POST | `/v1/events/PointsAssigned` | Puntos asignados, con el saldo resultante |
| POST | `/v1/events/RewardRedeemed` | Canje de una recompensa |
| POST | `/v1/events/PushNotificationRequested` | Push puntual |
| POST | `/v1/events/PushCampaignRequested` | Campaña push segmentada |
| POST | `/v1/events/WhatsAppOutboundRequested` | Mensaje saliente de WhatsApp |
| POST | `/v1/events/WorkflowTriggered` | Disparo de un workflow de automatización |
| GET | `/v1/events/health` | Sonda autenticada del ingestor |

Varios de esos tipos los produce la propia plataforma: `Growth` publica `PointsAssigned` y `RewardRedeemed` directo a la cola, sin pasar por HTTP.

No hay esquema de compra. Esta tabla documentó durante meses `/v1/events/purchase` y `/v1/events/custom`, que nunca estuvieron registrados y siempre respondieron 404; un `PurchaseCompleted` sería una decisión de producto aparte, no un nombre que falte.

### Wallet (Google Wallet)

Worker `@vyloop/wallet`. Las tres rutas existen en `workers/wallet/src/routes.ts` y están enrutadas por el gateway bajo el prefijo `/v1/wallet`.

| Método | Endpoint | Descripción |
|---|---|---|
| GET | `/v1/wallet/status` | Si el cliente autenticado puede obtener un pase ahora, y por qué no cuando no puede |
| GET | `/v1/wallet/pass` | Link de guardado del pase de lealtad del cliente autenticado |
| POST | `/v1/wallet/program/sync` | Refresca `review_status` de la clase desde Google — acción de operador |

#### Autenticación

Las tres rutas son autenticadas por headers inyectados por el gateway después de validar el JWT: `X-User-Id`, `X-Business-Id` y `X-User-Role`. No hay `customer_id` en el path ni en el query string: el cliente es el sujeto del token, así que nombrar a otro no es expresable.

El tenant es siempre el negocio autenticado (`X-Business-Id`). No existe parámetro de path, de query ni campo de body que permita nombrar otro.

El rol distingue las superficies: `GET /v1/wallet/status` y `GET /v1/wallet/pass` son para el token de rol `customer`; `POST /v1/wallet/program/sync` rechaza ese mismo token con `OPERATOR_ROLE_REQUIRED`.

#### Respuesta exitosa

`GET /v1/wallet/status` — siempre 200 para un cliente autenticado de un negocio existente, incluso cuando el pase no está disponible. `available: false` con un `reason` es la respuesta, no un error.

```json
{
  "data": {
    "available": false,
    "reason": "class_not_approved",
    "reason_code": "WALLET_CLASS_NOT_APPROVED",
    "review_status": "under_review",
    "google_review_status": "UNDER_REVIEW",
    "class_id": "3388000000023206930.tenant-0b1f...",
    "last_synced_at": null,
    "has_member_code": false,
    "tier_row_available": false,
    "demo_mode": false,
    "pass_state": null
  }
}
```

Cuando el tenant no tiene fila de programa, `review_status`, `google_review_status` y `class_id` vienen en `null`; los tres derivan de la misma fila. `tier_row_available` es siempre `false` y `demo_mode` siempre está presente, porque son los dos hechos que más caro es no mirar.

`GET /v1/wallet/pass`:

```json
{
  "data": {
    "save_url": "...",
    "object_id": "...",
    "class_id": "...",
    "member_code": "...",
    "balance_points": 0,
    "points_currency": "puntos",
    "already_existed": false,
    "pass_state": "issued"
  }
}
```

**Emisión idempotente.** Antes de mintear, la ruta consulta `customer_wallet_passes` para el cliente del token y decide por estado:

| Estado previo | Qué hace la ruta | `already_existed` |
|---|---|---|
| `issued` | Firma un link nuevo para el `object_id` registrado. No llama a Google, no inserta, no parchea, no reconcilia | `true` |
| `not_saved` | Igual. Es un hueco de nuestro conocimiento, no un estado del cliente: preguntamos a Google y no hay objeto | `true` |
| `inactive` | Igual. Es el mismo pase, desactivado por el cliente | `true` |
| `not_issued` | Mintea. La fila no dice si el objeto existe en Google —la deja `recordPass` tanto si el insert following funcionó como si no— y la única forma de averiguarlo es preguntar | `false` |
| `expired` / `completed` | **No mintea.** Son terminales y Google no puede deshacerlos, así que un insert nuevo no reviviría este pase: sería un segundo objeto para el mismo cliente. Responde `409 WALLET_PASS_TERMINAL` | — |
| Sin fila | Mintea, inserta, y parchea en 409 si Google ya lo tenía | `false` |
| Valor no reconocido | **No mintea.** Falla cerrado con `500 WALLET_PASS_STATE_UNKNOWN`, porque la columna es `text` sin `check` y el schema pide que los lectores fallen cerrados | — |

El `save_url` se firma al vuelo en cada caso y nunca se guarda, así que devolver un pase existente no cuesta una llamada a Google. El camino 409 → patch sigue existiendo para la carrera real: dos requests que leen "sin fila" antes de que ninguna escriba son invisibles entre sí, y el 409 es la única señal. Dejó de ser el mecanismo principal, no el mecanismo.

`already_existed` dice si **este request** creó el pase. `pass_state` es `customer_wallet_passes.state` después del request, con el mismo vocabulario que ya reporta `GET /v1/wallet/status`. Los dos campos son necesarios y no se contradicen: `already_existed: false, pass_state: "issued"` es una primera visita que sí creó el objeto, y `already_existed: true, pass_state: "not_saved"` es una fila que existe pero que el cliente todavía no guardó en el teléfono. `object_id` es idéntico en ambos caminos a propósito —eso es lo que hace idempotente la segunda petición—, así que sin esos dos campos un cliente no puede distinguir "la acabo de crear" de "ya la tenías".

`POST /v1/wallet/program/sync`:

```json
{
  "data": {
    "class_id": "...",
    "review_status": "approved",
    "changed": true,
    "previous_review_status": "under_review",
    "last_synced_at": "2026-09-29T00:00:00.000Z"
  }
}
```

#### Códigos de falla

`GET /v1/wallet/status`:

| Código | Status | Significado |
|---|---|---|
| `UNAUTHORIZED` | 403 | Faltan headers de autenticación (middleware global del worker) |
| `CUSTOMER_SELF_NOT_FOUND` | 403 | El token no tiene fila de cliente en este negocio |

`GET /v1/wallet/pass`:

| Código | Status | Significado |
|---|---|---|
| `UNAUTHORIZED` | 403 | Faltan headers de autenticación |
| `WALLET_DEMO_MODE` | 409 | El despliegue no tiene acceso de publicación de Google; el pase solo llegaría a las cuentas de prueba del emisor |
| `CUSTOMER_SELF_NOT_FOUND` | 403 | El token no tiene fila de cliente en este negocio |
| `WALLET_CLASS_NOT_PROVISIONED` | 409 | El tenant no tiene fila de clase |
| `WALLET_CLASS_NOT_APPROVED` | 409 | La clase del tenant no está aprobada |
| `WALLET_CLASS_ID_MISMATCH` | 409 | El `class_id` almacenado no corresponde al `issuer_id` del tenant |
| `LOYALTY_PROGRAM_NOT_CONFIGURED` | 409 | Hay clase de Google pero no hay programa de lealtad, así que el pase no tiene moneda de puntos |
| `WALLET_PASS_TERMINAL` | 409 | El pase está en `expired` o `completed`. Google no puede volver atrás de esos estados, así que no se emite un pase nuevo por encima |
| `WALLET_PASS_STATE_UNKNOWN` | 500 | `customer_wallet_passes.state` tiene un valor que este build no reconoce. Falla cerrado en vez de emitir sobre un estado que nadie revisó |
| `WALLET_BALANCE_NOT_DISPLAYABLE` | 409 | El saldo supera los 9,999,999 puntos que un pase puede mostrar; es una condición de producto, no una falla del despliegue |
| `WALLET_NOT_CONFIGURED` | 500 | `WALLET_ALLOWED_ORIGINS` vacío, o no se pudo obtener un member code |

`POST /v1/wallet/program/sync`:

| Código | Status | Significado |
|---|---|---|
| `UNAUTHORIZED` | 403 | Faltan headers de autenticación |
| `OPERATOR_ROLE_REQUIRED` | 403 | El token es de rol `customer`; esta ruta es de operador |
| `WALLET_CLASS_NOT_PROVISIONED` | 404 | El tenant no tiene fila de clase, así que no hay nada que sincronizar. Esta ruta nunca crea una clase |
| `WALLET_CLASS_NOT_FOUND` | 404 | Google no tiene esa clase. La fila almacenada queda intacta |
| `WALLET_SYNC_FAILED` | 502 | Google no pudo ser leído, o reportó un `review_status` que el sistema no reconoce |

Además, el worker responde `NOT_FOUND` 404 para rutas bajo `/v1/wallet` que no existen, y `ERROR` o `INTERNAL_ERROR` 500 desde el manejador global de errores.

**Nota sobre la reconciliación:** en `GET /v1/wallet/pass`, la reconciliación con Google ocurre después de firmar el link y es un efecto secundario que no puede fallar la petición. Toda falla de Google se registra y se ignora, y la respuesta 200 con link se entrega igual. Un cliente que toca un botón y recibe un error porque la API de Google está teniendo un mal momento no vuelve a tocarlo.

La reconciliación corre solo en el camino que emite. Cuando el pase ya existe no se le pide nada a Google: el saldo de un pase guardado lo mantiene `sweep.ts` en cada barrido programado, que incluye a los clientes que nunca abren la app.

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

