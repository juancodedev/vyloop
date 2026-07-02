# 02-Market-Research.md
**[DOCUMENTO]:** Vyloop Market Research | **[VERSIÓN]:** v2.0 | **[ESTADO]:** Draft | **[RESPONSABLE]:** Principal Product Architect

---

## 1. Panorama competitivo

| Competidor | Alcance | Fortaleza | Brecha que expone |
|---|---|---|---|
| FidelidApp (CL) | Chile, expansión incipiente | Primero en mercado chileno, bajo costo de entrada | Solo PWA, sin IA real, sin app nativa, sin API pública, plataforma cerrada |
| Smile.io | Global (e-commerce) | Ecosistema Shopify/BigCommerce | No orientado a negocios físicos, sin canal WhatsApp, sin predicción de churn |
| LoyaltyLion | Global (e-commerce) | Segmentación avanzada | Mismo problema: digital-only, sin POS físico, caro para pymes |
| Yotpo Loyalty | Global (mid-market) | Integración con reviews y UGC | Precio enterprise, sin LatAm real, sin WhatsApp |
| Toast Loyalty | EEUU (restaurantes) | Integrado al POS | Solo EEUU, sin expansión LatAm, modelo cerrado |
| Square Loyalty | EEUU | Simplicidad, precio bajo | Solo EEUU, sin IA predictiva, sin cross-loyalty |
| HubSpot | Global (CRM) | Ecosistema completo de marketing | No es loyalty, es CRM general — demasiado complejo y caro para pymes físicas |
| Klaviyo | Global (email/SMS) | Segmentación y automatización de email | No gestiona puntos ni fidelización, no tiene canal WhatsApp para LatAm |

---

## 2. Brecha de mercado identificada

Existe una falta crítica de una plataforma unificada para el segmento PYME/Mid-market que combine:

1. **Fidelización con IA predictiva** — nadie en LatAm tiene predicción de churn real para pymes físicas.
2. **App nativa + web** — los competidores locales solo tienen PWA; los globales no están orientados a negocios físicos.
3. **Canal WhatsApp como ciudadano de primera clase** — es el canal dominante en LatAm y España, y los competidores globales lo tratan como add-on.
4. **Red cross-loyalty entre negocios** — ningún competidor tiene esto; es una ventaja de red que se vuelve más valiosa con cada negocio que se suma.
5. **Arquitectura global con localización real** — los competidores locales son mono-país; los globales no tienen localización real para LatAm (Pix, SPEI, RUT, CPF).

---

## 3. Ventaja estratégica — el Flywheel de datos

```
Más negocios en la red
        ↓
Más datos de comportamiento de clientes
        ↓
Mejores modelos de predicción de churn
        ↓
Mayor retención para cada negocio
        ↓
Más valor del cross-loyalty entre negocios
        ↓
Más negocios quieren entrar a la red
```

Vyloop no compite por features — compite por **eficiencia de crecimiento**. A mayor uso, mejor predicción; a mejor predicción, mayor retención; a mayor retención, más negocios; a más negocios, más valor de la red.

---

## 4. Segmentos de mercado objetivo

### Ola 1 — Base (meses 1 a 12)
**Chile, Perú, Colombia, México**
- Idioma base compartido (ES neutro + variantes)
- WhatsApp como canal dominante en los cuatro mercados
- Mercado Pago + Stripe cubren >90% de los casos de pago
- Menor complejidad regulatoria para validar el core del producto

### Ola 2 — Expansión (meses 12 a 24)
**Brasil, Argentina, España, US Hispanic**
- Brasil: mercado sin líder claro en loyalty para pymes físicas, requiere PT-BR + Pix + LGPD
- Argentina: alta adopción digital, requiere precios indexados a USD por inflación
- España: puerta de entrada a Europa, RGPD desde el inicio
- US Hispanic: WhatsApp sigue siendo canal relevante, mercado de 60M+ de hispanohablantes

### Ola 3 — Madura (24 meses en adelante)
**EEUU general, Europa, Asia selectivo**
- Requiere SOC 2, canal dominante cambia a email/push
- Competencia consolidada — entrada por nicho o partnership

---

## 5. Tamaño de mercado (referencia)

- El mercado global de software de loyalty y engagement supera los USD 10B anuales (2024).
- LatAm representa aproximadamente el 8-10% y crece a tasas superiores al 15% anual.
- Brasil y México son los dos mercados más grandes de la región, con alta penetración de smartphones y WhatsApp.
- El segmento pyme físico (1 a 50 empleados) es el menos servido por soluciones de loyalty digitales en LatAm.

---

## 6. Documento anterior

Este documento reemplaza:
- `02-Market-Research.md` v1.0 (Project Atlas)
- Secciones de mercado del `Vyloop PRD v1` (aprobado)

