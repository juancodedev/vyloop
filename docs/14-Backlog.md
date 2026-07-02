# 14-Backlog.md
**[DOCUMENTO]:** Vyloop Engineering Backlog | **[VERSIÓN]:** v2.0 | **[ESTADO]:** Planning | **[RESPONSABLE]:** Product Manager

> Este backlog está alineado con el `Vyloop Roadmap PMV v1` (aprobado). Las fases y semanas de este documento son las fuentes de verdad del orden de construcción. Cualquier ítem fuera del alcance del PMV está marcado como `[Fase 2+]`.

---

## Fase 1 — Foundation (Semanas 1 a 3)

Objetivo: infraestructura base corriendo en producción. Sin esta fase, nada más puede construirse.

### Infraestructura y datos
- [ ] Setup del monorepo `vyloop-core` con estructura de Workers por dominio
- [ ] Configuración de entorno de desarrollo local (`wrangler dev` + Neon local)
- [ ] Implementar schema de base de datos PostgreSQL (todos los dominios) con migraciones versionadas
- [ ] Activar Row-Level Security (RLS) en todas las tablas con `business_id`
- [ ] Configurar Schema Registry en Cloudflare Workers KV con esquemas de eventos iniciales

### Identity y autenticación
- [ ] Implementar IAM (Identity & Access Management) multi-tenant
- [ ] API Gateway base (Cloudflare Workers + Hono) con routing por dominio
- [ ] Auth OIDC — emisión y validación de JWT con scopes granulares
- [ ] Validación de `X-Business-ID` en el gateway — rechazo 403 si no coincide con el token
- [ ] Registro y login de negocio (tenant) — flujo completo

### Bus de eventos
- [ ] Configurar Cloudflare Queues como bus de eventos base
- [ ] Implementar Event Ingestor con validación de Schema Registry
- [ ] Worker de prueba: publicar `TestEvent` y consumirlo desde un Worker suscriptor

---

## Fase 2 — Core Platform (Semanas 4 a 6)

Objetivo: producto vendible desde la semana 6. Un negocio puede registrar clientes, asignar puntos y ver su base de datos.

### Customer Domain
- [ ] CRUD completo de clientes (`/v1/customers`)
- [ ] Registro de cliente vía landing PWA (escaneo de QR → formulario → confirmación)
- [ ] Evento `CustomerRegistered` publicado al bus al completar registro
- [ ] Perfil 360° del cliente: endpoint `/v1/customers/{id}` con `customer_events`
- [ ] Generación de `global_id` en el momento del registro

### Growth Domain
- [ ] Motor de puntos: lógica de earn con tasa configurable y multiplicador por tier
- [ ] CRUD de niveles de membresía (`membership_tiers`)
- [ ] Endpoint de asignación de puntos (`POST /v1/loyalty/points/assign`)
- [ ] Endpoint de canje (`POST /v1/loyalty/rewards/redeem`)
- [ ] Suscripción al evento `CustomerRegistered` → inicializar wallet en Bronze
- [ ] Suscripción al evento `PointsAssigned` → evaluar upgrade de tier

### Dashboard Web (Next.js)
- [ ] Layout base del dashboard con navegación y autenticación
- [ ] Vista de lista de clientes con búsqueda por nombre/teléfono
- [ ] Vista de perfil individual del cliente (puntos, nivel, últimas visitas)
- [ ] Vista de configuración del programa de puntos
- [ ] QR del negocio para el punto de venta (generado y descargable)

### Pagos (suscripción del negocio)
- [ ] Integración de Stripe para mercados fuera de Chile
- [ ] Integración de Flow para el mercado chileno
- [ ] Flujo de upgrade de plan Free a Pro desde el dashboard

---

## Fase 3 — Retención e Inteligencia (Semanas 7 a 9)

Objetivo: el negocio puede actuar sobre clientes en riesgo y medir satisfacción.

### Analytics Domain
- [ ] Segmentación de clientes con operadores AND/OR (`GET /v1/customers` con filtros combinados)
- [ ] Cálculo de score RFM por cliente (recencia, frecuencia, valor)
- [ ] Alerta de clientes en riesgo: vista en dashboard con lista y días de inactividad
- [ ] Evento `ChurnRiskDetected` publicado al bus cuando un cliente supera el umbral

### Communication Domain
- [ ] Integración de Meta Business API (WhatsApp)
- [ ] Templates de WhatsApp: bienvenida, puntos acumulados, beneficio disponible
- [ ] Integración de Resend para email transaccional
- [ ] Templates de email: confirmación de registro, estado de puntos
- [ ] Endpoint `/v1/communication/send` — envío omnicanal basado en template

### Automation Domain
- [ ] Workflows predefinidos activables sin configuración:
  - [ ] Cumpleaños: `CustomerBirthdayToday` → WhatsApp con regalo de puntos
  - [ ] Inactividad: `N días sin visita` → mensaje de retención
  - [ ] Primer canje: `RewardRedeemed` (primera vez) → mensaje de felicitación

### Feedback
- [ ] NPS post-canje: solicitud automática al cliente final tras el primer canje
- [ ] Vista de NPS promedio en el dashboard del negocio
- [ ] Exportación de base de clientes en CSV/Excel

---

## Fase 4 — Validación con Pilotos (Semanas 10 a 13)

Objetivo: 10 a 15 negocios reales usando el producto. Datos reales para la siguiente fase de inversión.

- [ ] Onboarding guiado de negocio nuevo (wizard de configuración inicial)
- [ ] Incorporación de los primeros 10 negocios piloto en Chile
- [ ] Dashboard de métricas North Star: tasa de canje, retención de negocios, NPS
- [ ] Ronda de ajustes basada en feedback de los pilotos
- [ ] Documentación de los primeros aprendizajes del PMV

---

## Backlog Fase 2+ (post-PMV)

Estos ítems están en la visión del producto pero **no entran al PMV**. Se priorizan en la siguiente ronda de planificación tras los aprendizajes de los pilotos.

### Growth
- [ ] Programa de referidos viral (puntos por referir a otro cliente)
- [ ] Cashback parcial (canje mixto puntos + dinero)
- [ ] Gamificación: streaks de visitas, badges, desafíos
- [ ] Red cross-loyalty entre negocios aliados

### AI / Analytics
- [ ] Modelo de predicción de churn con ML (reemplaza las reglas RFM del PMV)
- [ ] Business Copilot: consulta semántica al dashboard (`POST /v1/ai/copilot/query`)
- [ ] Benchmarks entre negocios de la misma categoría (requires ClickHouse)
- [ ] Analytics por empleado individual (QR propio por cajero)
- [ ] Migración analítica a ClickHouse Cloud

### Communication & Automation
- [ ] Workflow builder visual (If This Then That con interfaz drag & drop)
- [ ] Orquestador omnicanal (canal óptimo según preferencias del cliente)
- [ ] Canal SMS como complementario

### Plataforma
- [ ] App nativa iOS y Android (Flutter o React Native)
- [ ] Apple Wallet + Google Wallet con actualización de saldo en tiempo real
- [ ] API pública documentada con Swagger (para integradores externos)
- [ ] Webhooks para suscripción de sistemas externos a eventos de Vyloop
- [ ] SDKs oficiales Node.js y Python
- [ ] Modo offline con sincronización diferida (para comercios con conectividad inestable)
- [ ] Integración con POS (Bsale / iPos — asignación automática de puntos)
- [ ] Dashboard multi-sucursal consolidado
- [ ] White-label / marca blanca (plan Enterprise)
- [ ] NFC como vector de captura alternativo al QR

---

## Criterio de definición de "listo" (DoD)

Un ítem del backlog está listo para marcar como completado cuando:
1. El código tiene tests que cubren el caso principal y los casos de error más relevantes.
2. El endpoint o el Worker está documentado en el Schema Registry o en el Swagger.
3. El comportamiento puede explicarse en términos del valor que genera — no solo de que "funciona".
4. El código pasó revisión de un segundo par de ojos antes del merge.

---

## Documento anterior

Este documento reemplaza:
- `14-Backlog.md` v1.0 (Project Atlas)
- Sección de próximos pasos del `Vyloop Roadmap PMV v1` (aprobado)

