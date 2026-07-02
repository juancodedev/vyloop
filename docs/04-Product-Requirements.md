# 04-Product-Requirements.md
**[DOCUMENTO]:** Vyloop Product Requirements | **[VERSIÓN]:** v2.0 | **[ESTADO]:** Draft | **[RESPONSABLE]:** Product Manager

---

## 1. Pilares de capacidad del producto

El producto se organiza en seis pilares. Cada pilar es un dominio independiente tanto en producto como en arquitectura (ver `06-Domain-Driven-Design.md`).

---

### Pilar 1 — Customer Platform
**Dominio:** Identity + Customer

Lo que el negocio gana: conocer a cada cliente como si lo recordara desde siempre.

| Capacidad | Descripción | Fase |
|---|---|---|
| Perfil 360° del cliente | Timeline unificado: visitas, puntos, canjes, mensajes, evaluaciones, eventos de churn | PMV |
| Identidad unificada (GlobalID) | Un identificador universal de cliente que trasciende su relación con un negocio específico — base del cross-loyalty futuro | PMV |
| Registro vía QR / WhatsApp / landing | Múltiples vectores de captura sin fricción para el cliente final | PMV |
| Gestión de consentimientos (GDPR-ready) | Consentimiento configurable por jurisdicción, con soporte para solicitudes de eliminación | PMV |
| Captura por NFC | Alternativa al QR para locales con mala iluminación o QR dañado | Fase 3 |

---

### Pilar 2 — Growth Platform
**Dominio:** Growth

Lo que el negocio gana: clientes que vuelven más seguido y acumulan más valor con cada visita.

| Capacidad | Descripción | Fase |
|---|---|---|
| Motor de puntos con reglas configurables | Tasa de conversión, vencimiento, puntos mínimos para canje | PMV |
| Niveles de membresía con multiplicadores | Bronze 1x, Silver 2x, Gold/Platinum 3x — configurables por negocio | PMV |
| Programa de referidos viral | Cliente que refiere gana puntos; negocio reduce CAC | Fase 2 |
| Cashback parcial (puntos + dinero) | Canje mixto — mayor tasa de uso del programa | Fase 2 |
| Red cross-loyalty entre negocios | Puntos de un negocio válidos parcialmente en negocios aliados | Fase 3 |
| Gamificación: streaks, badges, desafíos | Incremento de frecuencia de visita por mecánicas de juego | Fase 2 |

---

### Pilar 3 — Communication
**Dominio:** Communication

Lo que el negocio gana: el mensaje correcto al cliente correcto en el momento exacto, sin intervención manual.

| Capacidad | Descripción | Fase |
|---|---|---|
| WhatsApp (Meta Business API) | Canal principal para LatAm — plantillas, conversaciones, notificaciones | PMV |
| Email transaccional y de campaña | Confirmación de registro, alertas de beneficios, campañas segmentadas | PMV |
| Push notifications (FCM) | Disponible con la app nativa — delivery rate 3x superior a notificaciones web | Fase 3 |
| SMS | Canal complementario para mercados donde WhatsApp tiene menor penetración | Fase 2 |
| Orquestador omnicanal | El sistema elige el canal óptimo según las preferencias del cliente final | Fase 3 |

---

### Pilar 4 — Automation
**Dominio:** Automation

Lo que el negocio gana: el sistema actúa solo — el dueño no necesita recordar nada.

| Capacidad | Descripción | Fase |
|---|---|---|
| Workflow builder visual (If This Then That + IA) | Flujos configurables por evento, condición y acción | Fase 2 |
| Automatizaciones predefinidas (cumpleaños, inactividad, primer canje) | Flujos listos para activar sin configuración avanzada | PMV |
| Asignación automática de puntos vía POS | Integración directa con Bsale/iPos — sin intervención del cajero | Fase 3 |
| Modo offline con sincronización diferida | Acumulación de transacciones sin conexión, sincronización automática al reconectar | Fase 3 |

---

### Pilar 5 — AI / Data
**Dominio:** Analytics + AI

Lo que el negocio gana: saber qué va a pasar antes de que ocurra.

| Capacidad | Descripción | Fase |
|---|---|---|
| Alertas de clientes en riesgo (reglas RFM) | Basadas en recencia, frecuencia y valor — sin ML, listo para el PMV | PMV |
| Predicción de abandono con ML | Modelo que calcula probabilidad de churn por cliente con actualización periódica | Fase 2 |
| Business Copilot (IA consultiva) | Consulta semántica al dashboard: "¿Quiénes son mis mejores clientes este mes?" | Fase 2 |
| Métricas comparativas entre negocios de la misma categoría | Benchmarks por rubro y país — posible gracias al modelo shared-database | Fase 3 |
| Analytics por empleado individual | QR propio por cajero — métricas de conversión y registro por persona | Fase 2 |

---

### Pilar 6 — Developer Platform
**Dominio:** Identity (API layer)

Lo que el ecosistema gana: integrarse con Vyloop en menos de 30 minutos.

| Capacidad | Descripción | Fase |
|---|---|---|
| API pública REST + GraphQL | Mismos endpoints que usa la interfaz interna | Fase 2 |
| Webhooks (event subscription) | Suscripción a eventos del sistema para integraciones en tiempo real | Fase 2 |
| SDKs oficiales (Node.js, Python, PHP) | Adopción rápida en el mercado pyme y agencias | Fase 3 |
| Marketplace de plugins | Ecosistema de terceros con take-rate sobre transacciones | Fase 4+ |
| OpenAPI / Swagger autogenerado | Documentación siempre sincronizada con el código | Fase 2 |

---

## 2. Capacidades fuera del alcance del PMV

Las siguientes capacidades son parte de la visión pero **no entran al PMV** (primeros 90 días):

- App nativa iOS y Android (el PMV usa PWA)
- Chatbot con IA generativa en WhatsApp
- Predicción de churn con ML (el PMV usa reglas RFM simples)
- Red cross-loyalty entre negocios
- Integración automática con POS
- Marketplace de plugins
- White-label / marca blanca
- Dashboard multi-sucursal consolidado

---

## 3. Criterio de aceptación global

> Una capacidad está lista para producción cuando puede explicarse en términos del valor que genera para el negocio o el cliente final, sin necesidad de explicar cómo funciona por debajo.

---

## 4. Documento anterior

Este documento reemplaza:
- `04-Product-Requirements.md` v1.0 (Project Atlas)
- Sección de alcance funcional del `Vyloop PRD v1` (aprobado)

