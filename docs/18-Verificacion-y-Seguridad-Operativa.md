# 18-Verificacion-y-Seguridad-Operativa.md
**[DOCUMENTO]:** Vyloop Verificación y Seguridad Operativa | **[ESTADO]:** Approved | **[RESPONSABLE]:** Equipo

Este documento existe porque una sesión de integración de Google Wallet terminó con tres incidentes que costaron tiempo y que **ningún test en verde detectaría**. Cada sección es una clase de error, no un incidente: el incidente es lo que pasó una vez; la clase vuelve a pasar si no queda escrita.

Las tres reglas que rigen todo lo de abajo:

- Una herramienta no se creyó porque imprimió algo: se creyó porque lo que imprimió se verificó contra la fuente.
- Un paso que no se comprobó no se reportó como hecho.
- Un secreto no sale del entorno, ni siquiera para ayudar a diagnosticarlo.

---

## 1. Verificar la salida de una herramienta antes de creerla

### El incidente

Al buscar un símbolo en el código se ejecutó:

```
rg -rln "callback" apps/gateway/src/ workers/wallet/src/
```

`rg -r` es `--replace`, no "recursive". El flag se leyó como el prefijo de "recursive" y el argumento que lo seguía se consumió como texto de reemplazo:

```
-r  es --replace, no "recursive"
ln  es el texto de reemplazo
```

La salida imprimió cada coincidencia con `callback` sustituido por `ln`. Leyendo eso apareció un `lnOptions` en el código y se reportó como bug de producción: "el campo se llama mal, hay que renombrarlo". Casi sale un PR que "arreglaba" código sano.

**El campo nunca existió.** Lo que realmente se leyó fue `callbackOptions` con el prefijo
sustituido, y eso es exactamente lo que reproduce el comando:

```bash
$ printf 'const callbackOptions = { url: "x" };\n' > t.ts
$ rg -rln "callbackOptions" t.ts
const ln = { url: "x" };        # ← lo que imprimió la herramienta
$ rg -n "callbackOptions" t.ts
1:const callbackOptions = { url: "x" };
```

El símbolo real del repositorio es `callbackOptions`, el campo `callbackOptions.url` de la clase
de Google Wallet (`workers/wallet/src/class.ts:190`, asignado en `:382`). Nunca hubo un
`lnOptions`, y `git log --all -S'lnOptions'` no devuelve nada en ningún branch.

### La regla

**"No lo veo" y "no existe" son cosas distintas.** Antes de afirmar que algo falta en el código, hay que confirmar que el comando que lo buscado hacía lo que se cree que hacía.

`rg` es recursivo por defecto y no tiene flag de recursión:

```bash
rg -n "callback" apps/gateway/src/ workers/wallet/src/   # recursivo
rg --files apps/gateway/src/                            # solo nombres de archivo
```

Y antes de reportar un símbolo inexistente, confirmar que existió alguna vez y se perdió, en lugar de nunca haber estado:

```bash
git log --all -S'<símbolo>' --oneline    # ¿apareció o desapareció en algún commit?
git log --all -S'<símbolo>' -p           # el diff donde cambió
```

Un `-S` con cero resultados significa "nunca estuvo en ningún branch". Eso sostiene el reporte; la salida de un `rg` mal invocado no.

### El otro caso: un filtro que no matchea no falla

Un `sed` o un `perl` cuyo patrón no encuentra nada **sale 0 y deja el texto entero**. No hay error, no hay código de salida distinto, no hay aviso.

Pasó al intentar enmascarar una connection string:

```bash
sed -E 's#://([^:]+):[^@]+@([^@]+)@.*#     host: \2#' <<< "$DATABASE_URL"
```

El patrón espera **dos** `@`: `user:pass@host@rest`. La URL de Postgres tiene **uno**: `user:pass@host`. No matcheó, así que imprimió la línea completa, contraseña incluida.

Comprobación de 10 segundos, sin secreto de por medio:

```bash
$ echo "no match here" | sed -E 's#zzz#yyy#'
no match here          # exit 0
```

Un redact que no se aplica es peor que no redactar: no redactar deja el secreto en el archivo; un redact que falla deja el secreto en el terminal y en la conversación.

**Antes de confiar en una salida filtrada, comprobá que el patrón matchea algo.** Probá contra una línea de ejemplo primero, y si la credencial es real, enmascará el original en la misma línea de comando que el comando que lo expone.

---

## 2. Una mutación que no se aplicó es peor que no testear

### El incidente

Verificar que una guarda de seguridad realmente protege algo se hace quitándola y comprobando que algún test cae. En este repositorio existen dos herramientas para eso, y ambas verifican lo mismo:

- `scripts/mutate-wallet.mjs` — aplica una edición que rompe la regla, corre la suite de wallet, cuenta cuántos tests caen, y restaura el archivo.
- `scripts/verify-guards.mjs` — lo mismo para las guardas de presentación del pase, con una condición extra.

La condición extra de `verify-guards.mjs` es la que importa:

> **1. La edición entró.** `git diff` se consulta después de escribir. Una mutación cuyo archivo queda byte-idéntico se reporta como `NO-OP` y **su resultado se descarta** en vez de contarse.
>
> **2. Un test la detectó.** Solo un test que *falla* cuenta como verificación. Una mutación que deja la suite verde es `MISSED`, lo que significa que la guarda no es load-bearing y el test que dice cubrirla es decoración.

El motivo está en el propio archivo: este repositorio tiene historial de un heredoc de Python que salía 0 sin hacer nada, dejando un test verde sobre código sin cambios.

### La regla

**Un test verde sobre un cambio que no ocurrió es evidencia falsa.** Es peor que no testear, porque se reporta como cobertura.

Antes de leer el resultado de una mutación, confirmar que entró:

```bash
git diff --stat             # ¿el archivo que modifiqué cambió?
git diff                    # ¿cambió lo que yo creía?
```

Y la regla que se aplica a **cada guarda** que se escriba a partir de ahora:

> **Se revierte, y se confirma que un test cae.** Si sigue pasando, no prueba nada y se reescribe.

Un test que sigue verde después de quitar la guarda no la está probando: o la guarda no hace nada, o el test no la ejercita. No es una guarda que "parece redundante".

---

## 3. No filtrar secretos al log

### El incidente

El `sed` de la sección anterior imprimió una `DATABASE_URL` completa en la conversación. La fuente era `.dev.vars`, que contiene credenciales reales de Neon.

### La regla

**Nunca imprimir un secreto sin enmascarar.** Ni para diagnosticar, ni "solo para ver el host", ni parcialmente.

`.dev.vars` de los workers (7 archivos: identity, customer, growth, analytics, communication,
compliance, automation — gitignored) contiene:

```
JWT_SECRET=<hex de 64 caracteres>
DATABASE_URL=postgresql://neondb_owner:<contraseña>@ep-...-pooler.c-4.us-east-1.aws.neon.tech/neondb?...
```

Los secrets de GitHub Actions son **write-only**: la `DATABASE_URL` de producción no se puede leer de vuelta, ni con `gh secret list` ni por la API. Esa asimetricidad es una protección. El `.dev.vars` no la tiene, y por eso es el que hay que tratar con más cuidado, no con menos: **hoy los `.dev.vars` apuntan a producción** (ver §4).

### El enmascarado correcto

Una connection string de Postgres tiene **un solo** `@`. El patrón correcto:

```bash
# Muestra solo el host. Un @, y el texto ANTES del @ se descarta.
sed -E 's#^[^:]+://[^@]+@([^/?]+).*#     host: \1#' <<< "$DATABASE_URL"
```

```
     host: ep-shiny-paper-aibbf0hk-pooler.c-4.us-east-1.aws.neon.tech
```

Alternativa sin `sed`, cuando el secreto está en una variable de shell y se quiere evitar el shell por completo:

```bash
node -e "const u=new URL(process.argv[1]); console.log('     host:', u.host)" "$DATABASE_URL"
```

Cualquiera de las dos está bien. Lo que no está bien es un patrón que no matchea, porque no falla (sección 1).

### Dónde se filtra un token por descuido

**Los logs de error son el lugar donde un token se filtra.** No en el mensaje del error: en el contexto que se loguea alrededor.

Nunca loguear:

| Qué | Por qué |
|---|---|
| `Authorization` | Es el token. Si se loguea un header entero, se logueó la credencial |
| Cookies de sesión | Mismo caso, y una cookie sirve para suplantar al navegador entero |
| Query string de una URL | `?token=`, `?code=`, `?sig=` son tokens con otra sintaxis |
| Body de la request | Puede contener `password`, `otp`, `cardNumber` en endpoints que no son de tarjeta todavía |

Sí se loguea: el **código** de error, el `request_id`, y el nombre del recurso. `apps/gateway/src/index.ts` loguea el `request_id` de un 500 justamente para que un error sea rastreable sin filtrar nada — ese es el patrón.

---

## 4. Hay tres bases de datos, y solo una es producción

| | Qué es | Estado |
|---|---|---|
| Neon `ep-shiny-paper-aibbf0hk` (proyecto `polished-firefly-68401534`, rama `br-delicate-paper-aitqyq9y`) | **PRODUCCIÓN** | La que inyecta `deploy.yml` desde el secret `DATABASE_URL`, **y a la que apuntan hoy todos los `.dev.vars`** (`apps/gateway` y los 7 workers) |
| Neon `ep-divine-bonus-ai05bdy3` (mismo proyecto, rama `br-still-mud-aik526qf`) | **DEV.** Ningún `.dev.vars` la usa hoy | 10 clientes, sin pases, sin clases de wallet. Inactiva desde el 2026-10-07 |
| Supabase `mysrgtsuoxhspyfhdnsp` | Proyecto migrado, ya no en uso | **Vacía, sin schema** |

> **Actualizado el 2026-10-20.** Los `.dev.vars` dejaron de apuntar a dev: los 8 (`apps/gateway` y
> los 7 workers) usan `ep-shiny-paper-aibbf0hk`, que **es producción, y así está bien**. Se comprobó
> con datos y no con nombres: 6 tenants, 24 clientes, 9 pases de wallet, 6 programas de wallet y 11
> entregas de callback, contra 0 pases en dev. El MCP de Neon confirma que las dos bases son ramas
> del mismo proyecto. **Consecuencia práctica: cualquier script que lea `.dev.vars` escribe y lee
> en producción.** Ese día se aplicaron ahí las migraciones `0017` y `0018`, y `pnpm db:drift` pasó.

Comprobado contra producción el 2026-10-05: **5 tenants, 13 clientes, 5 pases, 5 filas de clase
de wallet, 7 entregas de callback registradas.**

Actualizado el **2026-10-07**: **6 tenants** — `cafeteria-dragon` se creó ese mismo día desde el
formulario de alta, que es la primera vez que un comercio entró por la interfaz en vez de por
un `curl`. Sigue habiendo **5 clases aprobadas** de las 6; la nueva está en `draft` porque Google
aún no la revisó.

### El registro de clientes devuelve 409 por email repetido, no 500

Comprobado el 2026-10-07 contra producción, con un teléfono nuevo y un email ya usado en el mismo
comercio:

```
teléfono nuevo     + email tomado  ->  409 CUSTOMER_EMAIL_TAKEN
teléfono conocido  + email tomado  ->  409 CUSTOMER_EMAIL_TAKEN
email libre                      ->  201
```

El mensaje entra en los 180 caracteres que el formulario exige antes de caer en su copy genérico, y
dice lo único que desbloquea al cliente: que el campo es opcional y lo deje vacío.

### El login de cliente exige el comercio

`POST /v1/auth/customer/token` **requiere `businessSlug`**. Un teléfono no es único entre
comercios — la misma persona es cliente de cuatro cafés y `customers` tiene una fila por
`(business_id, phone)` — así que sin el comercio la pregunta no tiene respuesta.

Sin él, la búsqueda era `where phone = ? limit 1`, sin orden: **la misma fila y otro café según el
día**. Y un slug que no existía no daba error, porque el refinamiento era condicional y caía al
lookup global: **token válido de un tenant arbitrario**, que renderiza el nombre de un café y
escribe un QR con el id de un cliente de otro local.

Ante la ausencia de `?biz=`, `/login` muestra qué enlace falta y deshabilita el formulario en vez
de pedir un número que no puede identificar nada.

### Cómo se identificó producción, y por qué este documento se equivocaba antes

La versión anterior de esta tabla nombraba `polished-firefly-68401534` como producción. **No lo
es**, y el error fue de método, no de dato: ese nombre es un **project id**, no un endpoint, y
nunca se comprobó contra un servidor.

La forma correcta de responder la pregunta es leer el binding del worker **desplegado**. El
`DATABASE_URL` de los workers se inyecta con `--var`, o sea que es un binding `plain_text` y no
un secret — se lee desde Cloudflare:

```bash
npx wrangler versions list --name wallet --json | head -1     # version id
npx wrangler versions view <id> --name wallet --json           # .resources.bindings[]
```

> No imprimas el valor del binding en un transcript. Extraé solo el host.

El discovery comparó datos, no nombres. `ep-divine-bonus` tiene **0 pases y 0 clases de wallet**,
mientras que la fila de este documento decía que dev tenía 1 tenant "sin fila de clase" — la
coincidencia de la que.Peor todavía: el callback de Google verificado en producción el mismo día
escribe en la base del worker desplegado, y ese pase no estaba en `ep-divine-bonus`.

**Un nombre de proyecto no es una dirección de servidor.** Comprobá el dato.

### La tabla de migraciones ya no tiene drift

Cuando este documento se escribió, `drizzle-kit migrate` contra producción estaba **prohibido**
porque 0004–0006 se habían aplicado sin registrarse. **Eso cambió** y el riesgo cambió con ello:

```
0009  aplicado y registrado  →  el watermark quedó por encima de 0004–0009
                              →  no queda nada fuera del journal
                              →  el baseline de migraciones quedó vacío
```

El baseline (`packages/db/drizzle/meta/_applied-outside-drizzle.json`) compensaba lo que el
journal no cubría. Con el journal completo no hay nada que compensar, y **`drizzle-kit migrate`
volvió a ser una operación normal** en este repo.

**Pero sigue sin ser la forma de aplicar una migración acá**, por una razón que no cambió:
`deploy.yml` no aplica migraciones y el gate de drift corre antes de publicar. El flujo correcto
sigue siendo aplicar a mano, revisando, y después re-derivar el baseline.

> *Nota sobre el drift:* el watermark de drizzle es **un escalar** — `order by created_at desc
> limit 1` — no un recorrido de entradas. Por eso una sola fila insertada mueve el mark por encima
> de todo lo anterior. Es lo que hace que un `INSERT` mal fechado pueda "registrar" migraciones que
> nunca se aplicaron.

Ese contraste ya produjo un falso positivo: `node scripts/check-wallet-readiness.mjs` lee
`apps/gateway/.dev.vars`, que cuando pasó apuntaba a **la base de dev**, y reportó sobre ella
mientras en producción la fila de clase de wallet existía. Hoy ese `.dev.vars` apunta a producción
(ver la tabla de §4), así que el script y `pnpm db:drift` reportan sobre producción. Igual hay que
leer la primera línea, que declara la base leída, antes que el veredicto.

### La regla

**Antes de aplicar una migración, confirmar contra cuál base se está.**

`.dev.vars` **hoy es producción** (comprobado el 2026-10-20, ver la tabla de arriba): escribir con lo que hay en `.dev.vars` es escribir en producción. Antes no lo era, y esa diferencia es justamente la razón de la regla: en una sesión de integración se estuvo a punto de aplicar una migración a la base equivocada y el reporte habría dicho "listo" — la migración habría quedado aplicada donde nadie la mira, y el mismo bug habría seguido vivo en producción.

La pregunta que hay que responder antes de escribir en cualquier base:

```bash
# ¿A qué host apunta? Comparar con la tabla de arriba.
echo "$DATABASE_URL" | sed -E 's#^[^:]+://[^@]+@([^/?]+).*#host: \1#'
```

### Cómo mirar cada una

El MCP de Neon funciona pasando `project_id` explícito en cada llamada:

```
project_id: polished-firefly-68401534      # el proyecto: contiene producción Y dev
```

`polished-firefly-68401534` es el **proyecto**, no una base: tiene dos ramas. `list_postgres_endpoints` con ese `project_id` las devuelve a las dos: `ep-shiny-paper-aibbf0hk` (rama `br-delicate-paper-aitqyq9y`, **producción**) y `ep-divine-bonus-ai05bdy3` (rama `br-still-mud-aik526qf`, dev). Por eso decir "polished-firefly es producción" es a medias cierto: para apuntar a producción hay que nombrar la rama o el endpoint, no solo el proyecto.

`list_projects` no sirve para esto: devuelve todos los proyectos de la organización, no solo los de Vyloop, y no resuelve una dirección de endpoint. `ep-divine-bonus-ai05bdy3` es un **endpoint**, no un project id — el MCP responde 404 a ese valor.

Los secrets de GitHub son write-only: para saber a qué base apunta `DATABASE_URL` en producción hay que saberlo de antemano (esta tabla), no leerlo.

### `sslmode=require` no significa lo mismo en cada driver

Comprobado el 2026-10-20 leyendo el código de las dos librerías, no su documentación:

| Driver | `require` / `prefer` / `verify-ca` | `verify-full` | `disable` | `no-verify` |
|---|---|---|---|---|
| `pg` vía `pg-connection-string@2.14.1` | **verifica** (alias de `verify-full`, con un warning que avisa que en v3/pg9 pasa a semántica libpq: sin verificar) | verifica | sin TLS | TLS sin verificar |
| `@neondatabase/serverless@1.2.0` | **verifica** (traduce a `ssl = {}`) | verifica | sin TLS | TLS sin verificar |

La consecuencia práctica: hoy `sslmode=require` es seguro con ambos drivers, y va a dejar de serlo en
cuanto `pg` cruce a la versión que anuncia el warning. Un `require` escrito hoy es una decisión de
seguridad que caduca sola, y el síntoma no es un error, es tráfico en claro o sin verificar que nadie
mira.

Por eso la regla es `verify-full` explícito en el connection string, y `scripts/lib/database-url.mjs`
lo hace cumplir antes de abrir el pool en los scripts operativos.

**Estado de los connection strings del repo:** los 8 `.dev.vars` (`apps/gateway` y los 7 workers)
todavía dicen `sslmode=require` y apuntan a producción. Están gitignoreados y **no se editaron**: el
guard corre en los scripts justamente para que ese `require` falle ahí, delante de quien lo mira, en
vez de degradarse en silencio dentro de un worker. `packages/db/src/index.ts` (`createDb`) todavía no
tiene el guard, a propósito: aplicarlo antes de rotar el secret de producción tumba los workers.

---

## 5. Migraciones: el ledger no es la verdad

### El incidente

`0007` y `0008` se mergearon. **Ningún job de CI aplica migraciones**:

```bash
$ grep db:migrate .github/workflows/
# sin resultados
```

El job `Deploy` salió `success`. Dos rutas quedaron muertas en producción — `/p/{slug}` daba 500 y el webhook de callbacks daba 500 — y nada dijo nada, porque un deploy que despliega código contra un schema que no tiene no falla en ninguna de las dos capas.

Al diagnosticar la columna `promo_copy` no existía, y apareció el problema de fondo:

```
migraciones aplicadas    4 de 8 registradas en el ledger
0004, 0005, 0006        aplicadas pero NO registradas (entraron por drizzle-kit push)
```

Verificado contra producción el 2026-10-02: `drizzle.__drizzle_migrations` tiene **4 filas** —los
`created_at` de `0000`, `0001`, `0002` y `0003`—, mientras que el schema real tiene
`wallet_callback_deliveries` (`0008`) y la columna `loyalty_programs.promo_copy` (`0007`). El
ledger no registra esas tres, ni las que están en medio. Hay **9** migraciones en el journal y
**4** en el ledger: cinco entraron por una vía que no escribe ledger.

### Por qué `drizzle-kit migrate` no es el remedio

**`drizzle-kit push` no escribe el ledger.** Compara el schema contra la base y emite DDL directo. El resultado es correcto y el ledger sigue mintiendo: la próxima vez que alguien corra `drizzle-kit migrate` sobre esa base, intenta reproducir desde el principio.

Y `0004` no se puede reproducir: su `CREATE TABLE "customer_wallet_passes"` no lleva `IF NOT EXISTS`, sobre una tabla que ya existe → `42P07`. Falla antes de llegar a `0007`.

### La regla

**Nunca `drizzle-kit migrate` contra una base con drift.**

El remedio es aplicar **las sentencias del archivo puntual**, con `IF NOT EXISTS` cuando se aplican a mano:

```bash
# Leer el archivo, aplicar lo que falta, con idempencia.
psql "$DATABASE_URL" -f packages/db/drizzle/0007_loyalty_promo_copy.sql
# y, si la tabla ya existe:
psql "$DATABASE_URL" -c 'CREATE TABLE IF NOT EXISTS wallet_callback_deliveries (...)'
```

Y después, **revisar que la ruta que fallaba responda**. Una migración aplicada es una hipótesis hasta que el endpoint contesta.

### El gate de deploy que falta

**Pendiente, no implementado.** El pipeline debería fallar si el esquema destino está atrasado respecto al journal: comparar lo que el journal declara contra lo que la base tiene, y cortar el deploy. Hoy el gate es humano y no está en ningún archivo.

Está anotado como pendiente en `docs/14-Backlog.md`.

---

## 6. La review de Google Wallet es de ida

Esta sección resume las propiedades de la API de Google que hacen la revisión irreversible. Las fuentes son las mismas que cita `docs/11-crear-tarjeta-lealtad.md`.

### `review_status` es una caché, y hay que refrescarla

Google aprueba clases **por su cuenta y en su propio calendario**. `review_status` se escribe una vez, como `draft`, al crear la clase. Si nadie lee la respuesta de Google, la fila dice `draft` para siempre — y el cliente ve *"tu tarjeta está en revisión"* aunque Google la haya aprobado hace días.

Hay dos piezas, y **las dos hacen falta**:

| pieza | qué hace | qué pasaba si falta |
|---|---|---|
| `POST /v1/wallet/program/sync` | refresca **un** tenant, el de quien llama | el comerciante tiene que refrescar a mano desde su panel |
| el sweep diario | refresca **todos** los que no estén `approved` | el estado de la flota se congela el día que se crea |

El cron vive dentro del sweep existente porque la cuenta de Cloudflare tiene sus **cinco cron triggers asignados** — un sexto es rechazado con el error `10072` y rompe el deploy. `automation` dispara el `scheduled` del worker `wallet` por service binding, así que el refresh corre con las credenciales de Google de ese worker y alcanza a todos los tenants. **Por eso la ruta no puede hacer este trabajo**: lee un solo tenant, el del que llama.

> **El casing importa.** `loyaltyclass.get` devuelve `reviewStatus` en **minúsculas** (`approved`), aunque la documentación de Google lo describa en mayúsculas. Un `switch` escrito contra la grafía documentada no matchea ninguna respuesta real y devuelve `null` — que el sync convertía en `502`, para todos los estados incluido `approved`. Consecuencia observada: **`review_status` nunca pudo escribirse desde Google**, y los merchants quedaron en `draft` sin que nadie pudiera saberlo.

### Estado verificado por lectura real

Comprobado contra producción el 2026-10-07, leyendo `review_status` desde la API de Google y no desde la fila:

```
slug                  review_status   leído de Google
cafeteria-dragon      draft           2026-10-07   ← creada hoy, Google aún no aprueba
cafe-central          approved        2026-10-07   ← confirmada contra Google
cafe-e2e-1448         approved        sin releer
vyloop-demo           approved        sin releer
cafe-prueba-0117      draft           NUNCA        ← espera el sweep
sonda-a2-1116         draft           NUNCA        ← espera el sweep
```

`cafeteria-dragon` es el control: se leyó y Google **`draft`**. No era caché viejo — Google de verdad no la aprobó todavía, y es una clase creada el mismo día. Un `draft` de una hora y un `draft` de seis días se distinguen por la fecha de creación, no por el estado.

### `reviewStatus` no vuelve a `draft`

La documentación de Google: *"Once the review state is changed from `draft` it may not be changed back to `draft`."*

Una clase rechazada **no se puede recrear bajo el mismo id**. El remedio es crear una clase nueva con otro sufijo y corregir el `class_id` de la fila en `tenant_wallet_programs`:

```sql
UPDATE tenant_wallet_programs
   SET class_id = '<issuerId>.tenant-<tenantId>-v2'
 WHERE tenant_id = '<tenantId>'::uuid;
```

Por eso un rechazo no es un contratiempo, es un retrabajo de id: la fila tiene que apuntar a algo que Google nunca va a revisar.

### Un `draft` no puede crear objetos

No hay pase hasta que la clase esté aprobada. Google no expone objetos de una clase en `draft`.

### `homepageUri` es el motivo de rechazo más común

Según `docs/11-crear-tarjeta-lealtad.md`, `homepageUri` es barato y es lo que más se rechaza. Tiene que apuntar a una página **del comercio**, en **dominio propio**, con el **nombre en el HTML servido** — no en un bundle que se carga del lado del cliente, porque el revisor de Google lee el HTML.

Hoy `homepageUri` es `https://media.juancode.dev/p/{slug}`, y esa página la renderiza el gateway en el servidor (`apps/gateway/src/merchant-page.ts`), con el nombre del comercio en el `<h1>`.

### Cambiar el dominio después de la aprobación es irreversible

Google revisa una clase abriendo `homepageUri`. Cambiar el host devuelve **todas las clases** que apuntaban al anterior a review, y una clase revisada no vuelve a `draft`. No hay vuelta: es una re-review, no una edición de configuración. Tratar un cambio de host como una decisión de producto.

El mismo razonamiento aplica a `callbackOptions.url` y a `programLogo`: una clase creada contra un host de staging postea a staging para siempre.

### El grant de publicación es del ISSUER, no del comercio

**Una sola aprobación para todo el emisor, no una por clase ni una por negocio.** La solicitud de acceso de publicación se hace una vez, a nivel de emisor. Una vez aprobada, las clases futuras no vuelven a esperar.

Esto es lo que separa "el pase funciona en el teléfono del cliente" de "el pase se puede entregar": `WALLET_DEMO_MODE` en `true` (el default en `workers/wallet/wrangler.jsonc`) antepone el prefijo `[TEST ONLY]` al pase y Google limita la entrega a las cuentas de prueba del emisor, aunque la clase esté aprobada.

---

## 7. Una prueba end-to-end que solo demuestra lo que firma

El 2026-10-08 se ejecutó el circuito completo contra **producción**: gateway → workers → base real,
por HTTP con cabeceras reales y firma real, en proceso. 14 de 14 pasos.

| Paso | Resultado |
|---|---|
| `PUT /v1/loyalty/config` | 201, regla de acumulación por tenant |
| `POST /v1/loyalty/terminals` | 201, secreto `vylt_…` |
| `POST /v1/auth/pos/token` | 200, token de counter |
| `POST /v1/loyalty/passes/resolve` | 200, `known: true` |
| `POST /v1/loyalty/checkins` | **201** |
| Puntos acreditados | sí |
| Reintento del mismo `payment_id` | **200** — idempotente |
| Webhook firmado | **201**, fila escrita en `settled_payments` |
| Firma incorrecta | **401** `PAYMENT_WEBHOOK_SIGNATURE_INVALID` |
| Credencial de Vyloop en la ruta del medio de pago | **403** `PAYMENT_WEBHOOK_CREDENTIAL_NOT_ALLOWED` |

Y el escenario que la función entera vino a cerrar:

```
# el medio de pago liquidó, el terminal nunca lo reportó
$ node scripts/check-payment-reconciliation.mjs
  pay-lost-1791499865748   E2E   $25.00   0 min

# el terminal lo reporta después
$ node scripts/check-payment-reconciliation.mjs
  [OK] every settled payment we recorded has a checkin
```

### Qué prueba y qué no

**El firmante fue el mismo verificador.** La entrega se firmó con HMAC-SHA256 sobre
`` `${timestamp}.${body}` `` en `X-Vyloop-Signature`, que es exactamente lo que
`verifyPaymentWebhookSignature` acepta. Eso prueba que *nuestro* lado del contrato es coherente
consigo mismo: que una firma bien calculada pasa, que una mal calculada no, y que todo lo demás
de la tubería anda.

**No prueba interoperabilidad con Mercado Pago.** No prueba que ellos firmen así, que usen esos
nombres de cabecera, ni que manden el timestamp en ese formato. El esquema no se pudo contrastar
contra su documentación y vive en una función con un docblock que lo dice.

Esta es la misma trampa que la sección 2 documenta desde el otro lado: un test que usa las
credenciales que el actor externo no tiene pasa en verde sin probar el contrato real. Acá el
actor externo es el medio de pago y la credencial que no tiene es **su formato de firma**.

Mientras eso siga sin verificar, la integración del receptor es correcta contra un emisor que
hemos inventado, y nada más.

### Tres cosas que hubo que resolver para correrla en local

Ninguna es un defecto de producto; las tres aparecen igual en cualquier corrida local sobre Node
20 y conviene conocerlas antes de perder una hora con ellas.

1. **`createDb` necesita `WebSocket`.** `drizzle-orm/neon-serverless` se dialea por WebSocket y
   `createDb(dbUrl)` no acepta `webSocketConstructor`. Node 22 tiene el global; esta máquina
   corría v20.20.2. Se inyectó `ws` como global en el harness, sin tocar código de producto.
   Es el mismo desfase que rompe los tests de `customer-web` y `dashboard` con
   `Iterator is not defined` — **el workspace pide `>=22`**.
2. **`DOMAIN_EVENTS_QUEUE` es un binding de Cloudflare Queue.** `creditCheckin` llama a
   `publish()`, que hace `queue.send()`. Sin el binding en el env, `undefined.send` y la ruta
   responde **500**. En el runtime de Workers existe; fuera hay que stubeanlo, igual que los
   tests del gateway stubean los service bindings.
3. **`POS_PLANS = ['premium']`.** Un tenant con `plan: 'free'` —el default— no puede tener
   terminal: el exchange devuelve 400. Hay que sembrar el plan explícitamente.

### La disciplina de no dejar basura en producción

El tenant se crea con `slug = e2e-<timestamp>`, todo lo que el harness crea cuelga de su
`business_id`, y el `cleanup()` borra por `business_id` en cascada manual antes de salir. El
script **afirma** que no quedó nada, y esa aserción es parte de la corrida, no un paso opcional:

```
PASS  cleanup removed everything from production  -- 0 tenants left
```

Verificado a mano después: 0 tenants `e2e-%`, 0 checkins del lote, 0 pagos huérfanos, 0
terminales. Un harness que escribe en producción sin esa aserción es un harness que un día
deja basura sin que nadie se entere.

El harness **no** está versionado. Era una prueba puntual y las cinco suites que ya existen
cubren las rutas.

---

## Documentos relacionados

| Documento | Qué cubre |
|---|---|
| `docs/11-crear-tarjeta-lealtad.md` | El procedimiento de alta de una clase de Google Wallet, con las fuentes citadas |
| `docs/17-Developer-Onboarding.md` | Las reglas de oro del equipo y las variables por worker |
| `docs/14-Backlog.md` | Lo que falta, incluido el gate de migraciones de la sección 5 |
| `scripts/verify-guards.mjs` | La verificación de mutaciones de la sección 2, implementada |
