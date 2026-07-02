# 05-System-Design-Document.md
**[DOCUMENTO]:** Vyloop System Design Document | **[VERSIÓN]:** v2.0 | **[ESTADO]:** Draft | **[RESPONSABLE]:** Principal Software Architect

---

## 1. Filosofía de arquitectura: "Event-First, Edge-Native"

En un Growth OS, el estado es efímero, pero los eventos son eternos. Vyloop no consulta bases de datos para saber qué ocurrió — procesa el flujo de eventos para proyectar el estado actual. Esto permite que múltiples dominios reaccionen en paralelo al mismo evento sin acoplamiento directo entre ellos.

El sistema se ejecuta en el borde de red (edge) para garantizar latencia mínima sin importar el país del usuario final, sin necesidad de desplegar infraestructura regional dedicada.

---

## 2. Stack tecnológico por capa

### 2.1 Frontend / Cliente

| Componente | Tecnología | Justificación |
|---|---|---|
| Dashboard web del negocio | Next.js + TypeScript + Tailwind CSS | SSR, SEO para landing pública, edge-friendly, mismo stack que el API gateway |
| Landing del cliente final (PMV) | Next.js PWA | Web-first para el PMV — sin descarga de app, instalable desde el navegador |
| App nativa (Fase 3) | Flutter o React Native | Código compartido iOS/Android, integración nativa con Apple Wallet y Google Wallet |

### 2.2 Backend / API

| Componente | Tecnología | Justificación |
|---|---|---|
| API Gateway | Cloudflare Workers + Hono | Ejecución en el borde de red, latencia global mínima, sin gestión de servidores — es la decisión correcta para el PMV y escala sin reescritura |
| Servicios de dominio (bounded contexts) | Cloudflare Workers (Workers aislados por dominio) | Cada dominio es un Worker independiente que se comunica exclusivamente por el bus de eventos |
| Servicios de IA / ML | Python (FastAPI en containers) | Python es superior para inferencia de modelos y procesamiento de lenguaje — se despliega como servicio interno separado, no como parte del gateway principal |

> **Decisión de arquitectura:** Se descarta Kubernetes / EKS para el PMV y Fase 2. La complejidad operativa de K8s no está justificada para validar el modelo con 150 negocios piloto. La migración a K8s se evalúa cuando el volumen lo exija, no antes.

### 2.3 Bus de eventos

| Fase | Tecnología | Justificación |
|---|---|---|
| PMV y Fase 2 | Cloudflare Queues | Sin configuración de infraestructura, at-least-once delivery, integrado nativamente con Workers |
| Fase 3+ (Enterprise) | Apache Kafka / Confluent | Cuando se requiera multi-región real, replay de eventos históricos y throughput de millones de eventos/hora |

### 2.4 Persistencia de datos

| Capa | Tecnología | Uso |
|---|---|---|
| Transaccional (OLTP) | PostgreSQL (Neon serverless) | Estado final de entidades: Business, Branch, Customer, Tier, Points. Multi-tenant via `business_id` + RLS |
| Analítica (OLAP) | ClickHouse Cloud | Destino de todos los eventos. Consultas de BI, cohortes, segmentación masiva, benchmarks cross-tenant. Se incorpora en Fase 2. |
| Schema Registry | Cloudflare Workers KV | Validación de esquemas de eventos antes de su ingesta al bus — evita que eventos malformados lleguen a los consumidores |
| Feature flags | Cloudflare Workers KV | Activación de funcionalidades por país/tenant sin despliegue de código |
| Archivos y assets | Cloudflare R2 | Compatible con S3, sin costos de egreso, costo predecible a escala |

### 2.5 Servicios externos (adaptadores)

| Categoría | Tecnología | Alcance |
|---|---|---|
| Email transaccional | Resend + React Email | Alta deliverability, plantillas como componentes React |
| WhatsApp | Meta Business API | Canal oficial, plantillas aprobadas, webhooks bidireccionales |
| Push notifications | Firebase Cloud Messaging | iOS + Android, delivery rate >90% vs ~40% de notificaciones web |
| IA / LLM | Anthropic API (Claude) | Chatbot contextual entrenado con datos del negocio, Business Copilot |
| Pagos (suscripción del negocio) | Stripe + Mercado Pago + Flow (CL) | Cobertura global + métodos locales críticos en LatAm |
| Billeteras digitales | Apple PassKit + Google Wallet API | Tarjeta de fidelidad nativa en el teléfono del cliente final |
| Analítica de producto | PostHog (self-hosted) | Funnels, retención por cohortes, feature flags de producto |

---

## 3. Arquitectura de referencia — diagrama conceptual

```
┌─────────────────────────────────────────────────────────────────┐
│  CLIENTES                                                          │
│  App nativa (iOS/Android) · Dashboard web (Next.js) · PWA        │
└────────────────────────────┬────────────────────────────────────┘
                             │ HTTPS / REST + GraphQL
┌────────────────────────────▼────────────────────────────────────┐
│  API GATEWAY (Cloudflare Workers + Hono)                          │
│  AuthN/AuthZ (OIDC) · Rate limiting · Routing · i18n headers      │
│  Event Ingestor → Schema Registry (KV) → validación de eventos    │
└────────────────────────────┬────────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────────┐
│  BUS DE EVENTOS (Cloudflare Queues → Kafka en enterprise)         │
│  At-least-once delivery · Persistencia antes del procesamiento    │
└──┬──────────┬──────────┬──────────┬──────────┬─────────────────┘
   │          │          │          │          │
   ▼          ▼          ▼          ▼          ▼
[Growth]  [Customer]  [AI/ML]  [Comms]  [Analytics]
[Worker]  [Worker]   [FastAPI] [Worker]  [Worker]
   │          │                           │
   ▼          ▼                           ▼
[PostgreSQL + RLS]                  [ClickHouse]
(Estado transaccional)          (Data Lake / OLAP)
```

---

## 4. Principios de arquitectura operativa

| Principio | Implementación concreta |
|---|---|
| **Edge-First** | Cloudflare Workers ejecutan en el PoP más cercano al usuario — latencia <50ms global sin configuración regional adicional |
| **Offline-First** | Cloudflare Queues con buffer local en el cliente para comercios con conectividad inestable; sincronización diferida automática |
| **No fork por país** | Feature flags en KV + adaptadores por categoría (pago, mensajería, identidad) — nunca una rama de código para un país |
| **Schema-First** | Todo contrato de datos documentado en el Schema Registry antes de implementar |
| **Security by Design** | TLS en tránsito, cifrado en reposo, RLS en PostgreSQL, consentimiento configurable por jurisdicción |
| **Developer Experience First** | La API interna y la pública son idénticas — lo que usa el dashboard es exactamente lo que usa un integrador externo |

---

## 5. Documento anterior

Este documento reemplaza y fusiona:
- `05-System-Design-Document.md` v1.0 (Project Atlas)
- `07-Architecture.md` v1.0 (Project Atlas) — los detalles de flujo de eventos se mantienen en `07-Architecture.md`
- `Vyloop SDD v1` (aprobado como docx)

