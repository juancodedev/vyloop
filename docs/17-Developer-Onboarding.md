# 17-Developer-Onboarding.md
**[DOCUMENTO]:** Vyloop Developer Onboarding | **[VERSIÓN]:** v2.0 | **[ESTADO]:** Approved | **[RESPONSABLE]:** Founder

---

## Bienvenido a Vyloop

No estás aquí para construir un sistema de puntos. Estás aquí para construir el **Growth OS** global que hace que los clientes de miles de negocios físicos vuelvan solos — y que cada negocio sepa, antes de que ocurra, cuándo un cliente está a punto de no volver.

Antes de escribir una sola línea de código, lee los siguientes documentos en orden. No son opcionales.

| # | Documento | Por qué |
|---|---|---|
| 1 | `00-Product-Vision.md` | Entiende qué estamos construyendo y por qué |
| 2 | `01-Product-Manifesto.md` | Entiende cómo tomamos decisiones |
| 3 | `06-Domain-Driven-Design.md` | Entiende la arquitectura de dominios antes de tocar código |
| 4 | `07-Architecture.md` | Entiende el flujo de eventos — el núcleo del sistema |
| 5 | `09-Database-Design.md` | Entiende el modelo de datos antes de escribir cualquier query |
| 6 | `18-Verificacion-y-Seguridad-Operativa.md` | Entra antes de tu primer deploy: bases de datos, migraciones, secretos, y cómo se verifican las cosas |

---

## Nuestras reglas de oro

### 1. Event-Driven primero
Antes de escribir una lógica de negocio, pregunta: **"¿Qué evento dispara esto, y qué eventos genera?"**

Si la respuesta no es clara, la lógica está en el lugar equivocado. Vuelve al `06-Domain-Driven-Design.md` y al `07-Architecture.md`.

### 2. Schema-First
Todo contrato de datos — un evento nuevo, un endpoint nuevo, un campo nuevo en un payload — debe estar documentado en el Schema Registry **antes** de implementarlo. El código es consecuencia del schema, no al revés.

### 3. Nunca un fork por país
Si estás creando una rama de código, un `if`, o una variable que dice `if country == "CL"`: **detente**. Busca el adaptador correspondiente en el dominio `Compliance` o en la capa de adaptadores de `Communication` o `Payment`. Lo que cambia por país es configuración o un adaptador — nunca lógica de negocio bifurcada.

### 4. El valor primero
Antes de hacer merge de cualquier feature, pregunta: **"¿Qué gana el negocio o el cliente final con esto?"**. Si la respuesta es solo técnica ("mejora la performance", "refactoriza el código"), está bien — pero debe haber una razón de negocio detrás. Lee el `01-Product-Manifesto.md` sección "Accionabilidad sobre información".

### 5. Idempotencia en los Workers
Los Workers que consumen eventos del bus pueden recibir el mismo evento más de una vez (at-least-once delivery). **Todo Worker debe ser idempotente**: procesar el mismo evento dos veces no debe generar duplicados ni efectos secundarios no deseados. Usa el `X-Request-ID` del header o el `id` del evento para detectar duplicados.

### 6. Verificá la salida antes de creerla
Una herramienta que imprimió algo no es evidencia de que ese algo sea cierto. Antes de afirmar que falta un símbolo en el código, confirmá con `git log --all -S'<símbolo>'` que existió alguna vez. Antes de confiar en un `sed` o un `perl` que filtra un secreto, comprobá que el patrón matchea: uno que no matchea sale 0 y deja pasar el texto entero. Detalle y comandos en [`docs/18-Verificacion-y-Seguridad-Operativa.md`](18-Verificacion-y-Seguridad-Operativa.md).

### 7. El schema se despliega a mano, y el pipeline no lo comprueba
**Ningún job de CI aplica migraciones.** Se aplican a mano, y el deploy sale `success` aunque el schema destino esté atrasado. Antes de escribir en una base, confirmá cuál es: `.dev.vars` **no es producción**. Y nunca corras `drizzle-kit migrate` sobre una base con drift — el ledger miente. Ver [`docs/18`](18-Verificacion-y-Seguridad-Operativa.md) §4 y §5.

---

## Checklist del primer día

- [ ] **Acceso al repositorio:** Clona el monorepo `vyloop-core` desde el repositorio del equipo.
- [ ] **Setup del entorno local:**
  ```bash
  cp .env.example .env.local
  # Completa las variables de entorno (pedir al líder técnico)
  npx wrangler dev          # Levanta el API Gateway localmente
  # O alternativamente:
  docker-compose up         # Si prefieres todo en contenedores
  ```
- [ ] **Verifica la base de datos:** Corre las migraciones y verifica que RLS esté activo.
  ```bash
  npm run db:migrate
  npm run db:verify-rls
  ```
  Contra **Docker local**, no contra la base de `.dev.vars`. Ver `18-Verificacion-y-Seguridad-Operativa.md` §4.
- [ ] **Tu primera tarea:** Crea un evento nuevo en el Schema Registry, publícalo al bus desde el Event Ingestor, y suscríbete a él desde el Worker del dominio `Customer`. Haz que el Worker loguee el payload recibido. Esto valida que tu entorno local funciona de extremo a extremo.
- [ ] **Lee la `00-Product-Vision.md`:** Es la única fuente de verdad sobre qué estamos construyendo.

---

## Variables de entorno y secrets por Worker

Cada Worker declara sus bindings en su propio `wrangler.jsonc` y sus tipos en el `*Bindings` del código. La regla general: **un secret nunca vive en un archivo del repositorio.** Llega por `wrangler secret put`, por entorno.

```bash
wrangler secret put <NOMBRE> --config workers/<worker>/wrangler.jsonc
```

### `DATABASE_URL` no es una variable: son tres

`DATABASE_URL` es la que más se confunde, porque **hay tres bases distintas y solo una es producción**:

| Dónde vive | Qué es | Estado |
|---|---|---|
| `workers/*/.dev.vars` (7 archivos, gitignored) | Neon `ep-divine-bonus-ai05bdy3` | 1 tenant, sin fila de clase de wallet. Es de desarrollo. **No es producción.** |
| Secret de GitHub `DATABASE_URL`, inyectado por `.github/workflows/deploy.yml` a `identity`, `wallet` y `gateway` | Neon `polished-firefly-68401534` | **PRODUCCIÓN.** Los secrets de GitHub son write-only: esta URL no se puede leer de vuelta |
| Proyecto Supabase `mysrgtsuoxhpsyfhdnsp` | Proyecto migrado, ya no en uso | Vacía, sin schema |

El `.dev.vars` no se commitea, pero **sí contiene credenciales reales**, así que no se imprime: enmascaralo antes de mostrarlo. Ver [`docs/18`](18-Verificacion-y-Seguridad-Operativa.md) §3 y §4.

### Worker `wallet` — Google Wallet

**Secrets (por `wrangler secret put`, nunca en un archivo):**

| Secret | Qué es |
|---|---|
| `GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL` | El `client_email` de la clave JSON de la service account. Su email debe estar invitado a la cuenta de emisor en la consola de Google Pay & Wallet, con rol `Developer` |
| `GOOGLE_WALLET_PRIVATE_KEY` | El `private_key` de esa misma clave, PEM-encoded. Firma el JWT de guardado del pase con RS256 |
| `MEMBER_CODE_PEPPER` | Secret servidor para derivar el member code del pase. Ver la regla crítica abajo |

En dev local, `.dev.vars` (gitignored) es la excepción habitual, porque `wrangler dev` no lee secrets del remoto. La regla de "nunca en el repositorio" sigue valiendo: `.dev.vars` no se commitea.

**Variables que no son secret:**

| Var | Dónde vive | Qué es |
|---|---|---|
| `GOOGLE_WALLET_ISSUER_ID` | `vars` en `wrangler.jsonc` | El id de emisor que entrega Google. No es secreto, pero es un valor real de la consola, así que se configura por entorno en vez de hardcodearlo en el código |
| `WALLET_DEMO_MODE` | `vars` en `wrangler.jsonc` | `'true'` o `'false'`. Si el despliegue todavía no tiene acceso de publicación de Google. **El default es `true` a propósito**: ausente, vacío o no reconocido se interpreta como demo mode, porque el costo de equivocarse es asétrico — un despliegue en demo mode que responde "no estoy en demo" le entrega un pase a un cliente real que solo funciona en las cuentas de prueba, y eso es un incidente de soporte |
| `DATABASE_URL` | por entorno (no commiteado) | Connection string de Neon, exactamente como la reciben los demás Workers. **Cuál de las tres es, importa:** ver la tabla de arriba y [`docs/18`](18-Verificacion-y-Seguridad-Operativa.md) §4 |
| `WALLET_ALLOWED_ORIGINS` | por entorno (no commiteado) | Lista separada por comas de origins donde se va a renderizar el control. Se convierte en el claim `origins` del token, y Google no renderiza el botón sin él. Si queda vacía, `GET /v1/wallet/pass` responde `WALLET_NOT_CONFIGURED` 500 en vez de firmar un token cuyo botón no hace nada |

**Puerto de dev:** `8795` (`wrangler dev --port 8795` en el script `dev` de `workers/wallet/package.json`). Los puertos de los demás Workers van del 8788 al 8794 y el gateway en 8787.

### Regla operativa: `MEMBER_CODE_PEPPER` debe ser idéntico en todos los entornos

El member code del pase se deriva como un HMAC con salt por tenant, usando `MEMBER_CODE_PEPPER`. **El pepper tiene que ser el mismo en dev, staging y producción.** Si un entorno tiene un pepper distinto, el mismo cliente recibe un member code distinto en cada despliegue, y cualquier código que un cliente ya haya memorizado deja de funcionar.

Es la razón por la que el pepper es un secret y no una constante en el código, y también la razón por la que no se puede "generar uno nuevo para cada entorno" siguiendo la costumbre de separar los entornos. Si el pepper se pierde, los códigos existentes no se pueden recuperar ni regenerar igual: habría que backfillearlos.

---

## Estructura del monorepo

```
vyloop-core/
├── apps/
│   ├── gateway/          # API Gateway (Cloudflare Workers + Hono)
│   ├── dashboard/        # Next.js — interfaz del negocio
│   └── customer-web/     # Next.js PWA — landing del cliente final
├── workers/
│   ├── identity/         # Dominio Identity
│   ├── customer/         # Dominio Customer
│   ├── growth/           # Dominio Growth
│   ├── communication/    # Dominio Communication
│   ├── automation/       # Dominio Automation
│   ├── analytics/        # Dominio Analytics
│   ├── compliance/       # Dominio Compliance
│   └── wallet/           # Google Wallet loyalty passes
├── services/
│   └── ai/               # FastAPI (Python) — IA y ML (predicción de churn, Copilot)
├── packages/
│   ├── schema-registry/  # Definiciones de esquemas de eventos
│   ├── db/               # Migraciones y tipos de base de datos
│   └── config/           # Configuración compartida (no lógica de negocio)
└── docs/                 # Este repositorio de documentación
```

---

## Flujo de trabajo de desarrollo

```
1. Lee el ítem del backlog (14-Backlog.md) y su criterio de DoD
2. Identifica el dominio responsable (06-Domain-Driven-Design.md)
3. Define los eventos involucrados y actualiza el Schema Registry
4. Implementa el Worker o el endpoint
5. Escribe tests (caso principal + casos de error)
6. Verifica idempotencia si el Worker consume del bus
7. Solicita revisión antes del merge
```

---

## Convenciones de código

| Convención | Detalle |
|---|---|
| Lenguaje principal | TypeScript — tipado estricto en todo el monorepo |
| Nombres de eventos | PascalCase, tiempo pasado: `CustomerRegistered`, `PointsAssigned`, `ChurnRiskDetected` |
| Nombres de endpoints | kebab-case: `/v1/loyalty/points/assign` |
| Nombres de tablas | snake_case, plural: `customers`, `points_transactions` |
| Nombres de Workers | kebab-case: `growth-worker`, `customer-worker` |
| Commits | Conventional Commits: `feat:`, `fix:`, `docs:`, `refactor:` |
| Branches | `feature/nombre-descriptivo`, `fix/nombre-del-bug` |

---

## Contacto y soporte

Si tienes dudas sobre:
- **Decisiones de producto o alcance:** Lee el `04-Product-Requirements.md` primero. Si no está respondido ahí, consulta al Product Manager.
- **Decisiones de arquitectura:** Lee el `07-Architecture.md` y el `06-Domain-Driven-Design.md`. Si no está respondido ahí, consulta al Principal Architect.
- **Dudas de acceso o entorno:** Consulta directamente al líder técnico del equipo.

---

## Documento anterior

Este documento reemplaza:
- `17-Developer-Onboarding.md` v1.0 (Project Atlas)

