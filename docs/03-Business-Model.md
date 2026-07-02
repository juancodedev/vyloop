# 03-Business-Model.md
**[DOCUMENTO]:** Vyloop Business Model | **[VERSIÓN]:** v2.0 | **[ESTADO]:** Draft | **[RESPONSABLE]:** Founder

---

## 1. Propuesta de valor por segmento

| Segmento | Lo que gana |
|---|---|
| Dueño del negocio | Sus clientes vuelven más seguido, sin tener que recordarlo manualmente. Sabe quién está a punto de no volver antes de que ocurra. |
| Cliente final del negocio | Cada visita tiene valor acumulado. Sus beneficios lo siguen sin importar qué dispositivo usa. |
| Agencia digital / revendedor | Puede ofrecer un producto de loyalty de nivel enterprise a sus clientes pyme, con su propia marca si elige el plan white-label. |

---

## 2. Estrategia de monetización

### 2.1 SaaS por tiers (ingreso principal)

Suscripción mensual por capacidad de base de clientes activos y número de sucursales. Los precios se localizan por país manteniendo equivalencia aproximada en USD.

| Plan | Capacidad | Precio referencial Chile | Precio referencial USD |
|---|---|---|---|
| Free | Hasta 150 clientes | Sin costo | Sin costo |
| Pro | Hasta 2.000 clientes, 1 sucursal | $29.990 CLP/mes | ~$32 USD/mes |
| Business | Hasta 10.000 clientes, hasta 5 sucursales | $59.990 CLP/mes por sucursal | ~$65 USD/mes por sucursal |
| Enterprise | Ilimitado, multi-sucursal, white-label | Desde $150.000 CLP/mes | Desde $160 USD/mes |

> **Nota de localización:** Argentina y Venezuela usan precios indexados a USD para evitar erosión de margen por inflación. El ajuste se hace en la capa de configuración por tenant, no en el código.

### 2.2 Consumo — add-ons por uso

Tarifas variables sobre servicios con costo marginal real:

- **Mensajería WhatsApp:** Por conversación o por mensaje de plantilla enviado (costo de Meta API trasladado con margen).
- **IA / Business Copilot:** Por tokens consumidos en consultas semánticas y generación de contenido.
- **SMS:** Por mensaje enviado en mercados donde SMS es canal complementario.
- **Almacenamiento de eventos (Data Lake):** Por GB almacenado en ClickHouse a partir de un volumen base incluido en el plan.

### 2.3 Marketplace revenue (Fase 4+)

Take-rate sobre transacciones generadas por plugins de terceros en el marketplace de integraciones. Relevante una vez que exista ecosistema de desarrolladores activo.

### 2.4 Enterprise — licenciamiento custom

Para redes de franquicias y corporativos con requerimientos de Data Residency, SLA garantizado, integración POS dedicada y soporte de implementación. Precio negociado por contrato anual.

---

## 3. Canales de adquisición

| Canal | Por qué | Costo estimado |
|---|---|---|
| Referidos entre negocios de la plataforma | El negocio que ya usa Vyloop recomienda a otro — incentivado con puntos o descuento | Muy bajo — CAC casi cero |
| SEO + contenido educativo para dueños de pymes | Artículos sobre retención de clientes, fidelización, WhatsApp marketing | Bajo — resultado compuesto en el tiempo |
| Agencias digitales como revendedores | Acceso a su cartera de clientes pyme existente | Bajo — comisión por suscripción activa |
| Ferias y eventos de emprendimiento en LatAm | Visibilidad directa con el segmento objetivo | Medio — costo puntual |
| Alianzas con proveedores de POS locales | Co-marketing con Bsale, iPos, Bling — su base de clientes es exactamente el segmento objetivo | Medio — requiere tiempo de negociación |

---

## 4. Métricas de negocio (North Stars)

| Métrica | Objetivo PMV (90 días) | Objetivo Año 1 |
|---|---|---|
| Negocios activos pagando | 15 piloto | 150 |
| Retención mensual de negocios | >85% | >90% |
| NPS del dueño del negocio | >40 | >50 |
| % clientes finales que vuelven en 30 días | Medición base | >35% |
| % nuevos negocios vía referidos | Medición base | >25% |
| Tasa de canje de beneficios | Medición base | >40% |

---

## 5. Estructura de costos relevante para el PMV

| Componente | Proveedor | Modelo de costo |
|---|---|---|
| Infraestructura edge | Cloudflare Workers + R2 + Queues | Sin costo hasta volumen relevante, luego por uso |
| Base de datos | Neon (PostgreSQL serverless) | Free tier para PMV, luego por compute |
| Email transaccional | Resend | Free tier 3.000 emails/mes, luego por volumen |
| WhatsApp API | Meta Business API | Por conversación iniciada |
| IA / LLM | Anthropic API | Por tokens consumidos |
| Analytics (ClickHouse) | ClickHouse Cloud | Se incorpora en Fase 2 cuando el volumen lo justifique |

---

## 6. Documento anterior

Este documento reemplaza:
- `03-Business-Model.md` v1.0 (Project Atlas)
- Sección de modelo de negocio del `Vyloop PRD v1` (aprobado)

