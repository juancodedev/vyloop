# ODD — Backlog post-PMV documentado en OpenSpec

Objetivo: dejar los pendientes técnicos (sin Mercado Pago) especificados en OpenSpec para abordarlos después del PMV.
Rama: `docs/openspec-deferred-backlog` · Entrega: un PR de documentación · Validación: `openspec validate <change> --strict`.

## Specs

- **S1** — L1, verbatim: "documenta esos pendientes, para abordar mas adelante, por lo que veo no son tan relevantes para un PMV. cuando lo documentes, pon detalle de lo que hay que implementar, siguiendo openspec"
- **S2** — Alcance elegido por el usuario: "Los 9 cambios" — los 15 pendientes de implementación agrupados en 9 cambios OpenSpec, más la lista de decisiones de producto y pendientes de documentación en `docs/18`.
- **S3** — Mercado Pago queda fuera (proyecto futuro, decisión del usuario del 2026-10-20).

## Tasks

| ID | Specs | Ruta | Cambio(s) | Estado |
|---|---|---|---|---|
| T1 | S1, S2 | delegada (W1, paralelismo) | `tenant-isolation-rls`, `message-log-schema-alignment`, `supply-chain-hardening` | hecha |
| T2 | S1, S2 | delegada (W2, paralelismo) | `campaign-delivery-idempotency`, `branch-reward-trigger`, `request-tracing` | hecha |
| T3 | S1, S2 | delegada (W3, paralelismo) | `pages-opennext-migration`, `wallet-pass-correctness`, `api-surface-cleanup` | hecha |
| T4 | S2, S3 | inline (padre) | Lista de decisiones de producto y docs en `docs/18`; validación; PR | hecha |

## Log

### L1 — 2026-10-20

> "documenta esos pendientes, para abordar mas adelante, por lo que veo no son tan relevantes para un PMV. cuando lo documentes, pon detalle de lo que hay que implementar, siguiendo openspec"

Alcance: "Los 9 cambios". Disparador de escritores: tres unidades independientes con superficies disjuntas (`openspec/changes/<id>/`), cada una con investigación propia del código.

### L2 — 2026-10-20 (cierre)

Los tres escritores terminaron dentro de sus superficies; el padre verificó que solo cambió
`openspec/changes/<9 ids>/`, `docs/18-Trabajo-Pendiente.md` y este documento. Los 9 cambios pasan
`openspec validate --strict` (217 tareas en total). Hallazgos verificados por el padre contra el
código: `withRls` no tiene efecto hoy (`packages/db/src/rls.ts:176`, `set_config` con `is_local`
fuera de transacción, 16 archivos), y el ingestor `POST /v1/events/:type` es público
(`apps/gateway/src/index.ts:51` antes de `:289`) pero growth relee el saldo real, así que no
fabrica puntos. Ambos quedaron anotados en el índice de `docs/18`.
