# 05-System-Design-Document.md
**[ESTADO]:** Draft | **[RESPONSABLE]:** Principal Software Architect

## Arquitectura de Referencia
* **Frontend:** Next.js + React + TypeScript (Edge-friendly).
* **Backend:** FastAPI (Python) distribuido por dominios (Bounded Contexts).
* **Bus de Eventos:** Apache Kafka / Cloudflare Queues.
* **Storage:** PostgreSQL (RLS para multi-tenancy) + ClickHouse (Analytics).
* **IA:** Capa de abstracción de LLMs (LangChain/LlamaIndex).
* **Despliegue:** Kubernetes (EKS) / AWS Global.