# 20 — Revisión de las specs de OpenSpec

> **Alcance:** revisión de `openspec/` contra el código que existe hoy. Sin cambios de código, schema ni workflow.
> **Base:** `main` en `ad0d363`, después de F1 (venues con posición) y de la purga de credenciales.
> **Método:** cada afirmación de este documento se verificó contra el código o contra el propio `openspec/`. No hay afirmaciones sin evidencia.

---

## 1. Qué hay

`openspec/` tiene tres capas, y funcionan bien:

| Capa                        | Qué es                                            | Estado                   |
| --------------------------- | ------------------------------------------------- | ------------------------ |
| `openspec/specs/`           | **12 specs vivas** — la verdad actual del sistema | 880 líneas en total      |
| `openspec/changes/`         | **7 propuestas** en vuelo (una con 0 tareas)      | mayormente implementadas |
| `openspec/changes/archive/` | **3 cambios** completados y archivados            | —                        |

El ciclo que declara `openspec/config.yaml` es `proposal → specs → design → tasks → apply → verify → archive`, con reglas claras: escenarios Given/When/Then, palabras clave RFC 2119, plan de rollback en las propuestas, tareas numeradas jerárquicamente y completables en una sesión.

**El proceso está bien diseñado. El problema es que el estado en disco no refleja el código.**

---

## 2. Hallazgos

### 2.1 `config.yaml` describe un proyecto que ya no existe

El bloque `testing` sigue diciendo:

> `note: "No test runner detected. Project is in pre-implementation (documentation) phase. Strict TDD disabled until a test framework is established."`
> `runner: null` · `unit/integration/e2e: { available: false }` · `linter: { available: false }` · `type_checker: { available: false }` · `test_command: ""` · `build_command: "npm run build || npx tsc --noEmit"`

La realidad: **vitest** con ~4.000 tests, **eslint**, **prettier**, **tsc**, y comandos reales `pnpm -r test`, `pnpm -r lint`, `pnpm -r typecheck`, `npx vitest run --dir scripts`.

**Por qué importa más de lo que parece:** un agente que lee la config para decidir cómo verificar no corre nada, porque la config le dice que no hay nada que correr. Y `build_command: "npm run build || npx tsc --noEmit"` usa **npm** en un repo que es **pnpm**. Esto no es un documento viejo: es una instrucción actively incorrecta.

### 2.2 El routing de `api-gateway` describe un gateway que no existe

La spec dice:

> Route by segment: `/v1/identity/*`, `/v1/customers/*`, `/v1/loyalty/*`, `/v1/analytics/*`, `/v1/events/*`, `/v1/automation/*`.

El `ROUTE_MAP` real (`apps/gateway/src/router.ts`) tiene **13 prefijos**:

```
/v1/auth  /v1/me  /v1/businesses  /v1/customers  /v1/loyalty  /v1/growth
/v1/analytics  /v1/events  /v1/support  /v1/automation  /v1/communication
/v1/compliance  /v1/wallet
```

**`/v1/identity/*` no existe** — la identidad vive en `/v1/auth` y `/v1/me`. Y faltan **7** prefijos reales, entre ellos `/v1/communication` (WhatsApp) y `/v1/wallet` (Google Wallet), que son dominios enteros de la plataforma.

### 2.3 `database` cuenta 15 tablas; hay 25

> #### Scenario: Migration
>
> - THEN **15 tables** exist with FK + constraints.

`packages/db/src/schema.ts` declara **25** `pgTable`. La lista de índices también quedó atrás: la spec nombra 3 índices parciales y 1 GIN; el registro declara **16**.

Y tras F1, `branches` tiene 5 columnas nuevas, un índice nuevo y 2 CHECK constraints. **Ninguna spec lo menciona** — más abajo (§2.7).

### 2.4 Dos specs vivas se contradicen sobre el formato de error, y las dos se contradicen con el código

| Fuente                           | Formato                                                                                   |
| -------------------------------- | ----------------------------------------------------------------------------------------- |
| `api-gateway/spec.md`            | `{"error":{"code":"...","message":"...","request_id":"..."}}`                             |
| `communication-whatsapp/spec.md` | `{ error: "consent_required", message }` (plano)                                          |
| **Código real**                  | `{ error: { code: 'CONSENT_REQUIRED', message: '...' } }` — anidado, **sin `request_id`** |

Tres versiones del mismo contrato. Peor: un cliente que escriba contra la spec de `communication-whatsapp` deserializa mal **la respuesta que el código realmente emite**.

### 2.5 El consent: hay tres historias distintas, y la tabla `consents` no la escribe nadie

Este es el hallazgo con más consecuencias, porque **bloquea F2**.

**Lo que dicen las specs** (`communication-whatsapp` y `automation-engine`):

> MUST validate customer consent (`consents.whatsapp_opt_in = true`)

**Lo que existe:**

- La columna `whatsapp_opt_in` **no existe** en el schema.
- La tabla `consents` (`consent_type`, `granted`, `granted_at`, `revoked_at`, `ip_address`) **no tiene ni un solo INSERT** en todo el repo. Se lee en `workers/customer/src/routes.ts:979` (perfil del cliente) y se expone en el dashboard (`apps/dashboard/src/lib/api.ts:477`).
- El gate real de envío está en otro lado: `workers/communication/src/routes.ts:67` lee `customer.metadata.consent.whatsapp === true` — un flag jsonb.

O sea: **la consentimiento de registro está en el metadata del cliente, la tabla `consents` está vacía, y la spec describe una columna que jamás existió.**

El plan de F2 (`docs/19-Geolocalizacion-Notificaciones.md` §4, D5) asumía reusar `consents` con `consent_type = 'push'`. Esa decisión ya no es automática: hay que elegir modelo antes de escribir la spec de push.

### 2.6 Tres propuestas al 100% nunca se archivaron, y una está duplicada

| Propuesta              | Sin hacer | Hechas | Total | Spec deltas |
| ---------------------- | --------- | ------ | ----- | ----------- |
| `init-reposotory`      | 0         | **25** | 25    | 1           |
| `whatsapp-automations` | 0         | **38** | 38    | 0           |
| `rewards-crud`         | 0         | **15** | 15    | 0           |
| `growth-engine`        | 5         | 18     | 23    | 2           |
| `demo-ready`           | 5         | 10     | 15    | 5           |
| `pmv-demo-ready`       | 10        | 0      | 10    | 7           |
| `complete-redesign`    | —         | —      | 0     | 1           |

Las tres primeras están **implementadas por completo en el código** y nunca se archivaron, así que sus spec deltas nunca se aplicaron a `openspec/specs/`. `rewards-crud` está además **duplicada**: archivada como `2026-07-06-rewards-crud` y presente en `changes/`.

Las 5 tareas pendientes de `growth-engine` (5.1–5.5) piden tests de integración con **Miniflare**, un framework que el repo no usa: sus tests corren con vitest y mocks. Esas tareas no están pendientes, están **obsoletas**.

### 2.7 F1 no dejó rastro en `openspec/`

Ninguna de las 12 specs vivas menciona `branches`, `venue`, `geolocal`, `latitude` o `longitude` (verificado por grep sobre `openspec/specs/`).

F1 agrego 5 columnas, un índice, 2 constraints, 4 rutas y una tabla de endpoints nueva. Según el propio ciclo de OpenSpec, eso es un `change` con proposal → specs → design → tasks → apply, y al terminar sus deltas deberían quedar en `openspec/specs/`. **Ese change no existe.**

---

## 3. Lo que las specs sí tienen bien

No todo está roto, y conviene decirlo porque es lo que sostiene el sistema:

- **Los scenarios Given/When/Then son ejecutables.** Describen casos concretos —"customer with `whatsapp_opt_in = false` → `403 CONSENT_REQUIRED`"— y se pueden contrastar contra un test. Ese es el formato correcto.
- **Las invariantes de seguridad están todas presentes y siguen siendo ciertas:** RLS por `app.current_business_id`, consentimiento antes de enviar, idempotencia por `reference_id`, gateway inyectando `X-User-Id`/`X-Business-Id`/`X-User-Role` y **strippeando** los headers entrantes para evitar spoofing. Todo eso verificado en el código.
- **Los scopes de la spec de IAM coinciden exactamente** con los del código: `read:customers`, `write:customers`, `write:loyalty`, `read:analytics`, `admin:billing`, `admin:webhooks`.
- **`AUTH_BUSINESS_MISMATCH` existe** (`apps/gateway/src/middleware/business-id.ts:35`).
- **`tasks.md` embebe el plan de entrega** (Review Workload Forecast, líneas estimadas, riesgo de presupuesto de 400, cadena de PRs). OpenSpec y ODD están integrados, no en paralelo.

---

## 4. Plan de remediación

Ordenado por relación de dependencia: cada paso deja el siguiente con menos ambigüedad.

### R1 — Corregir `openspec/config.yaml` (10 minutos)

Sustituir el bloque `testing` por los hechos: runner `vitest`, capas disponibles, `test_command: pnpm -r test`, `build_command: pnpm -r typecheck`, linter `eslint`, formatter `prettier`. `strict_tdd` es **política**, no un hecho: se deja como está y se decide aparte.

### R2 — Decidir el modelo de consent (bloquea F2)

Tres caminos:

|                                        | Qué implica                                                                                                                                                                                                                                                                 |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Unificar en la tabla `consents`** | Escribir en ella (hoy nadie lo hace), hacer que el gate de WhatsApp la lea, y usar `consent_type='push'` en F2. Gana el rastro de auditoría (`granted_at`, `revoked_at`, `ip_address`) y una revocación con fecha. Costo: tocar el registro del cliente y el gate de envío. |
| **B. Unificar en `metadata.consent`**  | Seguir con el jsonb y dejar la tabla `consents` como residuo a eliminar. Costo: se pierde el rastro de auditoría y la revocación con fecha — y la spec seguiría mintiendo.                                                                                                  |
| **C. Mantener los dos**                | Solo si cada canal tiene un modelo distinto. Es lo que hay hoy, y es lo que hace que la spec no pueda ser escrita.                                                                                                                                                          |

**Recomendación: A.** Es la que la spec ya describe, la que tiene el modelo de datos correcto, y la que hace que F2 no introduzca un tercer modelo.

### R3 — Reconciliar las 12 specs vivas con el código

`api-gateway` (routing y formato de error), `database` (tablas, índices, y el delta de F1), `communication-whatsapp` (formato de error y modelo de consent, según R2). Cada delta se pide como `change` con su proposal, no como edición directa de `openspec/specs/`.

### R4 — Archivar las 3 propuestas completas

`init-reposotory`, `whatsapp-automations`, `rewards-crud` — aplicando sus spec deltas a `openspec/specs/` y moviéndolas a `archive/`. Deduplicar `rewards-crud`.

### R5 — Cerrar o reescribir las propuestas a medias

`growth-engine` (18/23): las 5 tareas son obsoletas (Miniflare) — o se adaptan a vitest o se declaran superadas. `demo-ready` (10/15) y `pmv-demo-ready` (0/10): decidir si se completan o se descartan.

### R6 — Spec de venues y geolocalización

El change de F1 que nunca existió: proposal + delta de `database` (columnas, índice, constraints) + delta de `api-gateway` (las 4 rutas y su contrato de error) + delta de `multi-tenant-iam` (el tenant sale del token, y un path que nombra otro business responde 404).

---

## 5. Pregunta abierta

**R2 (modelo de consent) necesita una decisión antes de poder escribir la spec de push (F2).** Es la única de las seis que no se puede resolver leyendo el código, porque el código hoy tiene dos modelos y ninguno de los dos es el que la spec describe.

Todo lo demás (R1, R3, R4, R5, R6) es trabajo mecánico que se puede hacer sin decidir nada.
