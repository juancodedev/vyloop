# 07-Architecture.md
**[DOCUMENTO]:** Vyloop Core Architecture | **[VERSIÓN]:** v1.0 | **[ESTADO]:** Draft | **[RESPONSABLE]:** Principal Product Architect

## 1. Filosofía de Arquitectura: "The Event-First Core"
En un Growth OS, el estado es efímero, pero los eventos son eternos. Vyloop no consulta bases de datos para saber qué ocurrió; Vyloop procesa el flujo de eventos para proyectar el estado actual.

*   **Decoupling:** Los dominios (Customer, Growth, Communication, etc.) nunca se llaman entre sí mediante acoplamiento directo. Publican eventos al bus y consumen únicamente lo que necesitan.
*   **Scalability:** Al ser asíncrono, la carga de trabajo de un evento (ej. "Compra realizada") se distribuye: el motor de lealtad procesa puntos, la IA reevalúa la predicción de churn y el CRM actualiza la segmentación, todo en paralelo y de forma no bloqueante.

## 2. Capas de la Arquitectura

### A. Capa de Ingesta (The Gateway)
*   **API Gateway (Cloudflare Workers + Hono):** Punto de entrada único. Gestiona AuthN/AuthZ global, Rate Limiting y enrutamiento inteligente basado en la región del usuario.
*   **Event Ingestor:** Endpoint de alta disponibilidad que valida el esquema del evento (Schema Registry) y lo inyecta inmediatamente en la cola global.

### B. El Bus de Eventos (The Nervous System)
*   **Tecnología:** Cloudflare Queues (para el PMV) evolucionando a Apache Kafka / Confluent para despliegues Enterprise multi-región.
*   **Garantía:** *At-least-once delivery*. Cada evento se persiste antes de ser procesado para garantizar resiliencia ante fallos.

### C. Capa de Servicios de Dominio (Bounded Contexts)
*   Cada dominio es un microservicio (Worker aislado) que vive de forma independiente.
*   **Comunicación:** El sistema responde a eventos como `CustomerPurchased`, `PointsRedeemed`, o `ChurnRiskDetected`.

### D. Capa de Datos (The Memory)
*   **Transactional (PostgreSQL + RLS):** Almacena el estado final de las entidades (Business, Branch, Customer, Tier). El aislamiento multi-tenant se garantiza mediante *Row-Level Security*.
*   **Analytical (ClickHouse):** El destino final de todo evento. Optimizado para consultas de BI, cohortes y segmentación masiva.

## 3. Principios Arquitectónicos
*   **Edge-First:** Procesamiento en el borde de red para latencia mínima global.
*   **Offline-First:** Sincronización diferida mediante colas locales para comercios con conectividad inestable.
*   **Cloud Native:** Construido sobre infraestructura agnóstica de nube, priorizando servicios serverless y gestionados.
*   **Security by Design:** Cifrado en tránsito y reposo, con políticas de cumplimiento regional (GDPR/LGPD) configurables por `tenant`.
*   **Developer Experience First:** Todo el sistema es expuesto mediante APIs públicas documentadas.

## 4. El Ciclo de Vida de un Evento (Patrón de Compra)

1.  **Ingesta:** El POS o la API publica `PurchaseCompleted`.
2.  **Validación:** El Schema Registry verifica la integridad (Schema Enforcement).
3.  **Broadcast:** El bus dispara el evento a los suscriptores:
    *   **Growth Service:** Calcula puntos y actualiza el `Wallet`.
    *   **Customer Service:** Actualiza el `LastPurchaseDate` y el `Customer360Profile`.
    *   **Analytics Service:** Inserta el evento en el Data Lake (ClickHouse).
    *   **AI Service:** Reevalúa el score de abandono (`ChurnPredictionEngine`).
    *   **Automation Service:** Evalúa disparadores (ej: "si es la 5ta compra, enviar regalo").

## 5. Escalabilidad Global
*   **Multi-tenancy:** Aislamiento lógico por `business_id` en una base de datos única y optimizada, eliminando el costo operativo de mantener esquemas físicos separados.
*   **Localization In-Flight:** Cada evento lleva metadatos de contexto (`region`, `currency`, `timezone`). Los servicios consumidores aplican la lógica local basada en estos metadatos, evitando bifurcaciones de código por país.
*   **Event-Sourcing:** La capacidad de reconstruir el estado de cualquier cliente en cualquier momento re-procesando su historial de eventos.

## 6. Diagrama de Flujo (Conceptual Pipeline)
```mermaid
graph LR
    A[POS/App/Web] -->|HTTPS| B(API Gateway)
    B --> C{Event Bus}
    C --> D[Growth Domain]
    C --> E[AI Domain]
    C --> F[Data Domain]
    C --> G[Communication Domain]
    D -->|Persistent State| H[(PostgreSQL)]
    F -->|Query| I[BI/Analytics]