# 21-Hardening-Tarjetas-Wallet.md
**[DOCUMENTO]:** Endurecimiento del pase Wallet | **[VERSIÓN]:** v1.0 | **[ESTADO]:** Propuesta | **[RESPONSABLE]:** Arquitectura

---

## 0. Cómo leer esto

Este documento nace de un levantamiento cruzado contra FidelitoPass, un producto que resuelve el mismo problema (una tarjeta de fidelidad en Google Wallet) con una tesis distinta. El cruce sirvió para encontrar cinco puntos donde Vyloop puede ser más seguro y más robusto sin cambiar de modelo.

Tres advertencias antes de seguir:

1. **Nada de esto es un juicio sobre el diseño actual.** Varias de estas decisiones están documentadas en el propio código, con el razonamiento y el incidente que las motivaron. El documento no las contradice: las extiende a los bordes que hoy no están cubiertos.
2. **Todo lo que se afirma acá está verificado contra el código**, con archivo y línea. Lo que no se pudo verificar está marcado como tal.
3. **Dos de los cinco puntos son correcciones al diagnóstico inicial**, no hallazgos nuevos: el repo ya los tenía resueltos y el levantamiento los había dado por faltantes. Están en el [Anexo A](#anexo-a--correcciones-al-diagnóstico-inicial), porque un documento de trabajo que se corrige a sí mismo vale más que uno que insiste.

---

## 1. Resumen ejecutivo

| # | Punto | Severidad | Esfuerzo | ¿Rompe contrato? |
|---|---|---|---|---|
| 1 | El QR lleva `global_id`: identificador no rotable | Media-alta | Alto | Sí, requiere aceptar dos formatos |
| 2 | No se confirman los bindings después del `insertObject` | **Alta** | Bajo | No |
| 3 | El `409` del insert cae en un patch de objeto completo | Media | Bajo | No |
| 4 | `passes/resolve` no tiene throttle ni deja de ser un oráculo | Media | Bajo | No |
| 5 | Nada impide que un patch futuro mande arrays | Media | Bajo | No |

El orden de la tabla no es el orden de ejecución. El orden recomendado está en la [sección 7](#7-orden-de-ejecución-recomendado): el punto 2 primero, porque es el más barato y el único que hoy produce un fallo **silencioso**.

---

## 2. El QR lleva `global_id`

### 2.1 Qué pasa hoy

`workers/wallet/src/object.ts:315`

```ts
barcode: { type: 'QR_CODE', value: input.customerGlobalId },
```

y el id del objeto se deriva del mismo valor (`workers/wallet/src/ids.ts:126`):

```ts
export function objectIdFor(issuerId: string, customerGlobalId: string): string {
  return qualify(issuerId, `member-${sanitizeIdPart(customerGlobalId)}`);
}
```

`customers.global_id` es `uuid('global_id').notNull().defaultRandom()` (`packages/db/src/schema.ts:184`). No hay ninguna ruta de escritura que lo modifique: el grep sobre `workers/` y `apps/` devuelve solo lecturas y proyecciones. **Es inmutable.**

El QR lo resuelve `GET /v1/customers/by-global-id/:globalId` (`workers/customer/src/routes.ts:956`), protegido por `requireOperatorRole`. No hay otro consumidor del valor del barcode.

### 2.2 Por qué importa

La conclusión correcta no es "el QR es público, entonces es inseguro". Es más específica, y hay que decirla con precisión o el punto se descarta solo:

- **La resolución está gateada a rol de operador.** Un tercero con una captura de pantalla del pase no puede llamar la ruta. Eso baja la severidad de crítica a media-alta, y hay que reconocerlo.
- **Lo que sí queda expuesto es la permanencia.** Un `global_id` filtrado —una captura compartida, un log de auditoría, un evento de dominio, una exportación de soporte— es un identificador que **no se puede revocar**. La única salida es cambiar `customers.global_id`, y eso arrastra `object_id` (deriva de él), el `id` del objeto en Google y todos los eventos históricos que lo llevan en el payload.
- **El identificador no es un secreto, pero se comporta como uno.** El pase lo muestra en pantalla; el sistema lo usa como clave de resolución. Esa ambigüedad es la que conviene eliminar, no por el riesgo de hoy sino por el costo de arreglarlo después.

Comparación útil: FidelitoPass pone en el QR un token opaco de 64 hex y guarda en la base **solo su SHA-256**. Rotar es cambiar el token; el hash viejo deja de matchear y el pase anterior muere. La identidad pública (`public_id`) y la credencial (`validation_token_hash`) son columnas distintas, y esa separación es la que permite revocar.

### 2.3 Opciones

**Opción A — Token opaco resuelto por `passes/resolve`.**
Agregar `credential_token_hash` al pase, poner el token crudo en el barcode, y extender `POST /v1/loyalty/passes/resolve` para aceptar `card_token` además de `member_code`. El POS no cambia de flujo: ya llama a `resolve` para el código manual.

- *A favor:* usa una ruta que ya existe, con el gate de counter que ya existe. Rotación = generar token nuevo + reescribir el barcode del objeto.
- *En contra:* el barcode de un objeto existente **no** se puede actualizar por el camino actual, porque `reconcile.ts` lo omite a propósito (ver [sección 5](#5-nada-impide-que-un-patch-futuro-mande-arrays)). Hay que abrir una ruta de escritura explícita y confirmada.

**Opción B — Segundo identificador, sin tocar `global_id`.**
Columna nueva `card_token_hash` en `customer_wallet_passes`. El barcode lleva el token; `global_id` sigue siendo la identidad interna y el `object_id` se sigue derivando de él. Rotar no toca la identidad ni el objeto: solo el valor escaneable.

- *A favor:* la rotación no rompe ninguna relación. Es la separación limpia entre identidad y credencial.
- *En contra:* requiere la misma ruta de escritura confirmada que A, más una columna y su migración.

**Opción C — Aceptar la no rotabilidad con controles compensatorios.**
Documentar `global_id` como identificador no secreto, agregar throttle y auditoría en `by-global-id`, y no prometer rotación.

- *A favor:* costo casi nulo.
- *En contra:* deja el problema. Si mañana aparece un incidente de filtración, la respuesta es "no se puede hacer nada", y eso es exactamente el estado que este documento existe para evitar.

### 2.4 Recomendación

**Opción B**, con la ruta de escritura de la Opción A como paso previo obligatorio. El paso previo tiene valor por sí solo: hoy no existe ninguna forma de reescribir campos del objeto que no sean `loyaltyPoints`, y esa ausencia es la causa del punto 2 del [Anexo B](#anexo-b--hallazgos-menores).

Si se elige C por costo, entonces la decisión tiene que quedar escrita acá y no en un comentario de código, porque el próximo que lea `object.ts` va a asumir rotabilidad como en cualquier otro sistema de credenciales.

### 2.5 Criterios de aceptación

- [x] Un pase emitido antes del cambio sigue funcionando: el POS acepta `global_id` en el barcode y resuelve por la ruta actual. Un cliente cuyo objeto en Google ya tiene el uuid no recibe token hasta que se rote.
- [x] Un pase emitido después lleva el token. **Corrección:** no resuelve por `passes/resolve`, porque esa ruta solo acepta terminales `pos:` y hoy no existe ninguna. El único lector del QR es la cámara del POS del dashboard, así que el token resuelve por `GET /v1/customers/by-card-token/:token` (operador), con la misma respuesta que `by-global-id`.
- [x] Existe una operación que rota el token: `rotateCardToken` en el wallet, disparada por "Revocar QR" en el POS (`POST /v1/customers/:id/card-token/rotate`). Sube la versión, hace un patch solo del barcode, lo confirma con `confirmObjectBindings`, y el token anterior deja de coincidir con el hash.
- [x] Un token rotado responde el mismo 404 que uno desconocido o malformado, sin revelar si el pase existe.
- [x] `object_id` no cambia al rotar (`workers/wallet/src/rotate-card-token.test.ts`).

Diseño final: el token es `vyc1.` + HMAC-SHA256(`CARD_TOKEN_SECRET`, tenant, `global_id`, `card_token_version`). Se **deriva**, no se guarda: la base tiene la versión y el SHA-256. Así el wallet vuelve a dibujar el QR de customer-web y el link de guardado sin almacenar la credencial. La contracara es que `CARD_TOKEN_SECRET` no se puede cambiar (ver `docs/17-Developer-Onboarding.md`). El QR de customer-web muestra el mismo token, y el POS deja de aceptar el uuid de un cliente que ya tiene token, tanto al escanear como en el buscador.

---

## 3. Separar credencial de identidad

Esta sección es el mecanismo de la anterior; está separada porque el principio vale más allá del QR.

### 3.1 El principio

| Concepto | Propiedad | Se puede cambiar |
|---|---|---|
| Identidad (`customers.id`, `customers.global_id`) | interna, estable, referenciada por eventos y objetos | no |
| Credencial escaneable | presentada al mostrador, revocable | sí |
| Objeto de Wallet (`object_id`) | derivado de la identidad | no, mientras la identidad no cambie |

Hoy las tres son el mismo valor. La propuesta es que la segunda sea independiente.

### 3.2 Por qué no alcanza con "el QR no es un secreto"

Porque el sistema ya lo trata como secreto en todos los demás lugares:

- El `member_code` se derivó con pepper precisamente para que no fuera correlacionable (`workers/wallet/src/member-code.ts`).
- La ruta `by-global-id` está gateada a operador.
- `passes/resolve` está gateada a counter, con el comentario explícito de que un cliente no debe poder aprender si un código pertenece a un tenant.

Es decir: la postura del sistema es que el valor escaneable es semi-privado. Un valor semi-privado no puede ser inmutable.

### 3.3 Criterios de aceptación

- [x] Existe al menos un camino de revocación de la credencial escaneable que no toque `global_id` ni `object_id`: "Revocar QR" en el POS, con motivo obligatorio.
- [x] La revocación queda auditada en `customer_credential_revocations` (operador, fecha, motivo, versión anterior y nueva), en la misma sentencia que cambia la versión.
- [x] Un test verifica que revocar no escribe en `points_transactions`, en el tier ni en el pase, y que el patch no lleva `loyaltyPoints`.

---

## 4. Confirmar bindings antes de decir "issued"

### 4.1 Qué pasa hoy

`workers/wallet/src/routes.ts:725`

```ts
await client.insertObject(issued.loyaltyObject);
console.log(`[wallet] Created pass object ${issued.objectId} at Google.`);
```

El recurso que Google devuelve se **descarta**. No se compara `id`, `classId`, `accountId`, `barcode.type` ni `barcode.value`.

Y después, `reconcilePass` solo lee dos cosas del objeto remoto: `state` y `loyaltyPoints.balance.string` (`workers/wallet/src/reconcile.ts:313`). **Los bindings no se vuelven a leer nunca.**

Consecuencia concreta: si Google normalizara o truncara `accountId` o `barcode.value` al insertar —y Google normaliza cosas, por eso existe `normaliseGoogleObjectState`— el sistema no lo sabría. El pase se marcaría `issued`, el cliente lo guardaría, y el escaneo en el mostrador devolvería "cliente no encontrado" sin ningún error en ningún lado. Es exactamente la clase de fallo que el comentario de `object.ts:59-85` describe para el estado en minúsculas, y la razón por la que ese normalizador existe.

### 4.2 Qué propone

Confirmar antes de entregar el link, con el mismo criterio que ya usa FidelitoPass en `GoogleWalletPassCreator::matchesObjectBindings`:

1. Tomar el recurso que devuelve `insertObject`.
2. Comparar, con igualdad exacta de strings: `id`, `classId`, `accountId`, `barcode.type` (normalizando `qrCode`/`qrcode` → `QR_CODE`) y `barcode.value`.
3. Si algún campo **presente** difiere: no entregar el link, responder `409` con un código propio, y loguear el campo —nunca el valor—.
4. Si un campo **falta**: hacer un `getObject` del mismo `objectId` y reintentar la comparación una vez.
5. Si tras eso sigue faltando: tratar como no confirmado, no como éxito.

El paso 4 importa porque Google puede devolver un recurso parcial en el insert; el paso 5 importa porque "no lo pude confirmar" y "está mal" son dos respuestas distintas para el operador.

### 4.3 Por qué es el punto más urgente

- Es el único de los cinco donde el fallo es **silencioso**: no hay error, no hay log, no hay 409. El pase simplemente no sirve.
- No requiere migración, ni cambio de contrato, ni coordinación con el POS.
- El `insertObject` ya devuelve el recurso: se está descartando información que ya se pagó.

### 4.4 Criterios de aceptación

- [x] Un insert cuyo `accountId` vuelve distinto no produce link y responde con un código distinguible (`WALLET_PASS_BINDINGS_NOT_CONFIRMED`).
- [x] Un insert cuyo `barcode.value` vuelve distinto no produce link.
- [x] Un insert con respuesta parcial dispara un `getObject` y se confirma o se rechaza con el resultado.
- [x] Un insert correcto no agrega ninguna llamada extra (test sobre el fake que cuente llamadas).
- [x] Los valores nunca aparecen en el log: solo el nombre del campo y una categoría (`different` / `invalid` / `missing`).

**Estado:** implementado en `workers/wallet/src/bindings.ts`, conectado en el `insertObject` y en el patch de recuperación del `409` de `routes.ts`. La comprobación también cubre el patch del `409`, porque ese camino igual termina entregando un link.

---

## 5. Nada impide que un patch futuro mande arrays

### 5.1 Qué está bien hoy

`reconcile.ts` hace lo correcto y lo documenta (`workers/wallet/src/reconcile.ts:229-232`):

> `accountName`, `barcode` y `textModulesData` se omiten para que la semántica de patch de Google los deje en paz. Esto importa más de lo que parece: Google documenta que patchear un array **lo reemplaza entero**, así que un patch que reconstruyera `textModulesData` borraría la fila del tier en vez de refrescarla.

Y el patch realmente manda solo el balance (`reconcile.ts:313`).

### 5.2 Dónde se rompe la disciplina

Hay dos puertas abiertas:

**a) El `409` del insert.** `routes.ts:738`

```ts
await client.patchObject(issued.objectId, issued.loyaltyObject);
```

Esto manda el **objeto completo**, incluidos `textModulesData` y `barcode`. Es intencional (el objeto proyectado es el mismo), pero es el único lugar del worker que patchea arrays, y no confirma el resultado como sí hace `reconcile`.

**b) `patchClass` no tiene callers.** Estaba implementado y testeado contra un fake, y **ningún código de producción lo llamaba**. Es el mismo patrón que el repo ya identificó como peligroso en `docs/11-crear-tarjeta-lealtad.md` ("método escrito, testeado contra un fake, jamás ejercitado"). El día que alguien hiciera rebrand de `promoCopy` o `linksModuleData`, iba a escribir el primer patch de clase del sistema, sin guardrail y sin caso de producción que lo hubiera probado.

### 5.3 Qué propone

- Un tipo `LoyaltyObjectPatch` que **no permita** arrays, salvo en una variante explícita `{ replaceArrays: true }` que obligue al lector a ver el riesgo.
- Un contract test que falle si un `patchObject` lleva `textModulesData`, `pushNotifications` o `merchantLocations` sin declarar la variante completa.
- Confirmar el resultado del patch del `409` igual que `reconcile`: leer el campo y comparar.
- O bien borrar `patchClass`, o bien darle un caller real y un test de integración. Un método sin caller es deuda con interés.

### 5.4 Criterios de aceptación

- [x] El tipo de patch no admite arrays sin una marca explícita.
- [x] El patch del `409` verifica el recurso devuelto y falla si el balance aplicado difiere.
- [x] `patchClass` tiene caller y test de contrato, o no existe.

**Estado:** implementado. `LoyaltyObjectPatch` es una unión: la variante mínima omite los tres campos de array, y la variante completa exige `replaceArrays: true`. `patchObject` quita esa marca del body —no es un campo de Google— y lanza `GoogleWalletPatchArrayError` si llegan arrays sin ella, que es lo que produce un `as never` en un fake. `patchClass` y `LoyaltyClassPatch` se borraron junto con sus fakes: el tipo encontró un caller real que el levantamiento inicial no había visto, `applyLocations` en `locations-sync.ts`, que sí reemplaza la lista entera y ahora lo declara.

---

## 6. `passes/resolve`: throttle y oráculo

### 6.1 Lo que ya está bien

Acá hay que corregir el diagnóstico inicial: **Vyloop no depende del escaneo**. Ya tiene código manual de primera clase:

- `customers.member_code` con índice único parcial `uq_customers_business_member_code` sobre `(business_id, member_code)` (`packages/db/src/schema.ts:247`).
- `POST /v1/loyalty/passes/resolve` (`workers/growth/src/routes.ts:2133`) gateado a `requireCounterSubject`, tenant-scoped por header, y con la regla explícita de que **su fallo nunca debe costarle una venta al comercio**: `known: false` es información, no un veto.
- El espacio es 32⁶ ≈ 1.1 × 10⁹, cuatro órdenes más que los 10⁵ de un código de cinco dígitos.

Eso está mejor resuelto que en la referencia. Lo que falta es el borde.

### 6.2 Lo que falta

**a) No hay throttle.** No hay rate limiting a nivel de aplicación en `passes/resolve`, `checkins` ni `by-global-id`. El grep sobre `workers/growth/src`, `workers/wallet/src` y `workers/customer/src` devuelve cero implementaciones, y los `wrangler.jsonc` no declaran ninguna regla. Cloudflare WAF podría estar cubriéndolo por fuera, pero eso no está verificado en el repo y no debería ser la única capa.

**b) `known: true` es un oráculo.** El código reconoce el riesgo y lo mitiga con el gate de counter —correcto— pero un terminal comprometido puede enumerar el espacio de códigos y aprender qué personas son miembros del tenant. Con 1.1 × 10⁹ de espacio y sin throttle, la enumeración completa no es viable, pero la enumeración **dirigida** (probar códigos derivados de teléfonos, nombres o folios) sí lo es, y es la que importa porque el pepper hace el código determinístico.

**c) El pepper es la única barrera de correlación.** Si `MEMBER_CODE_PEPPER` se filtra, cualquiera que además conozca `tenants.id` y `customers.global_id` puede reproducir el código de esa persona.

> **Corrección (verificada en código).** El diagnóstico inicial decía que rotar el pepper invalidaría todos los códigos memorizados. No es así: `member_code` se **guarda** en la fila y nunca se vuelve a derivar. `ensureMemberCode` devuelve el valor almacenado si es válido (`workers/wallet/src/issuance.ts:323`) y `passes/resolve` busca por igualdad de columna (`resolveMemberCode` en `workers/growth/src/routes.ts`). El pepper solo interviene cuando un cliente todavía no tiene código.

### 6.3 Qué propone

- Throttle por `(business_id, subject)` en `resolve` y `checkins`, con respuesta que **no** sea un veto para la venta: el mostrador debe poder seguir cobrando, igual que hoy con `known: false`.
- Contador de fallos que alimente una alerta, no un bloqueo del comercio.
- ~~Versión de pepper en la fila (`member_code_version`)~~. **No hace falta**, por la corrección de 6.2c: el código guardado sigue funcionando con cualquier pepper. Ver 6.5.
- Evaluar no devolver `fullName` en la respuesta de `resolve` salvo que el mostrador lo necesite para confirmar visualmente. Si no se necesita, es PII servida a un terminal.

### 6.4 Criterios de aceptación

- [x] `resolve` degrada a `known: false` (200, sin consultar la base) cuando el terminal supera 30 consultas por minuto, sin tocar `checkins`. Binding `RESOLVE_RATE_LIMITER` en `workers/growth/wrangler.jsonc`, con clave `business_id:subject`. Cuenta **todas** las consultas y no solo los fallos: el binding no permite leer un contador sin incrementarlo, y un mostrador real escanea pocas tarjetas por minuto. Si el limiter falla o no está configurado, la consulta pasa igual.
- [x] La degradación está testeada (`workers/growth/src/index.test.ts`, describe `throttle`): bajo el límite el miembro se resuelve, sobre el límite no se consulta la base, el limiter con error deja pasar, el body malformado no cuenta y `checkins` no consulta el limiter.
- [x] Rotar `MEMBER_CODE_PEPPER` no invalida los códigos existentes. Procedimiento en 6.5.

La alerta es la línea `[growth] resolve_throttled` con `business_id` y `subject` en los logs del worker. Falta crear la regla de alerta sobre esa línea en Cloudflare, y eso queda fuera del repo.

`fullName` se sigue devolviendo: el cajero lo usa para confirmar visualmente a la persona, y el throttle limita cuántos nombres puede obtener un terminal comprometido. Si algún día el mostrador deja de mostrarlo, hay que sacarlo de la respuesta.

### 6.5 Rotar `MEMBER_CODE_PEPPER`

1. `wrangler secret put MEMBER_CODE_PEPPER` en `workers/wallet` con el valor nuevo.
2. Los códigos ya guardados siguen funcionando sin cambios. Solo los clientes que todavía no tienen código reciben uno derivado con el pepper nuevo. La unicidad la garantiza `uq_customers_business_member_code`, no el pepper.
3. Después de rotar, no hay que correr la consulta de verificación comentada en `workers/wallet/sql/member-code-backfill.sql`: compara los códigos guardados con los derivados del pepper y marcaría como distintas todas las filas anteriores a la rotación, aunque esas filas estén bien.

Lo caro de una filtración no es rotar, sino que los códigos ya emitidos **siguen** siendo derivables con el pepper viejo. Para invalidarlos hay que volver a emitirlos: poner `member_code` en `NULL` para los clientes afectados y dejar que `ensureMemberCode` derive uno nuevo en la próxima emisión del pase. Eso cambia el código que el cliente memorizó, así que es una decisión de incidente y no un paso de rutina.

---

## 7. Orden de ejecución recomendado

| Orden | Punto | Por qué en este lugar | Estado |
|---|---|---|---|
| 1 | [4 — Bindings](#4-confirmar-bindings-antes-de-decir-issued) | Único fallo silencioso. Sin migración. Se paga solo. | Hecho |
| 2 | [5 — Guardrail de arrays](#5-nada-impide-que-un-patch-futuro-mande-arrays) | Barato y protege el camino que el punto 1 del orden va a tocar. | Hecho |
| 3 | [6 — Throttle y pepper](#6-passesresolve-throttle-y-oráculo) | No requiere migración de datos. La versión de pepper resultó innecesaria (ver 6.2c). | Hecho |
| 4 | [2 y 3 — Credencial rotable](#2-el-qr-lleva-global_id) | El más caro. Necesita el paso 2 de esta lista ya hecho. | Hecho |

El punto 1 de la ejecución se puede cerrar en una sesión y no toca ningún contrato externo.

---

## 8. Qué NO cambiar

Para que este documento no se lea como una invitación a reescribir:

- **La emisión no debe esperar a Google para fallar el tap.** El comentario de `routes.ts:496-512` es correcto: reconciliar es un efecto secundario que no puede tumbar la request. Confirmar bindings es distinto —ocurre antes de entregar el link, en el único momento donde el link todavía no se prometió— y no contradice esa regla.
- **`recordPass` debe seguir escribiendo `not_issued`.** La distinción `not_issued` / `not_saved` es la mejor decisión del módulo: separa un estado del cliente de un agujero en nuestro conocimiento. No tocarla.
- **El patch de balance debe seguir mandando solo el balance.** La disciplina de `reconcile` es correcta; lo que falta es extenderla, no relajarla.
- **`classReadinessFor` debe seguir fallando cerrado** con igualdad exacta contra `approved`. Un estado desconocido no es una autorización.
- **El código manual no debe volverse un veto.** La regla de `passes/resolve` —nuestro fallo no le cuesta una venta al comercio— es correcta y el throttle tiene que respetarla.

---

## Anexo A — Correcciones al diagnóstico inicial

Dos de los cuatro puntos que originaron este documento ya estaban resueltos en el repo. Se dejan acá para que la próxima persona no los vuelva a "descubrir".

| Punto inicial | Estado real | Qué queda |
|---|---|---|
| "Vyloop hoy depende del escaneo; el código manual debería ser ciudadano de primera" | **Incorrecto.** Ya lo es: `member_code` con unique parcial, `passes/resolve` con gate de counter y tenant scope por header. | Throttle y revisión de `fullName`: hechos. La versión de pepper no hacía falta, porque el código se guarda y no se vuelve a derivar. Ver [sección 6](#6-passesresolve-throttle-y-oráculo). |
| "El patch de `textModulesData` reemplaza el array entero y eso es un footgun" | **Parcialmente incorrecto.** `reconcile.ts` lo omite a propósito y lo documenta; el patch manda solo el balance. | El `409` sí manda el objeto completo, y `patchClass` no tiene callers ni guardrail. Ver [sección 5](#5-nada-impide-que-un-patch-futuro-mande-arrays). |
| "Separar credencial de identidad" | Válido. `global_id` es inmutable y el `object_id` deriva de él. | [Secciones 2](#2-el-qr-lleva-global_id) y [3](#3-separar-credencial-de-identidad). |
| "Confirmar bindings antes de dar por emitida la card" | Válido. `insertObject` descarta la respuesta y nadie vuelve a leer los bindings. | [Sección 4](#4-confirmar-bindings-antes-de-decir-issued). |

---

## Anexo B — Hallazgos menores

Ninguno bloquea; todos son baratos.

1. **Drift en los comentarios de ruta.** `object.ts:13` y `member-code.ts:13` dicen `GET /v1/customers/n/:globalId`. La ruta real es `/v1/customers/by-global-id/:globalId` (`workers/customer/src/routes.ts:956`). Un comentario que nombra una ruta inexistente manda al lector equivocado.
2. **`patchClass` sin caller.** Resuelto: se borró. Ver [5.2](#52-dónde-se-rompe-la-disciplina).
3. **Sin throttle de aplicación** en `resolve`, `checkins` y `by-global-id`. Ver [6.2](#62-lo-que-falta).
4. **El `409` del insert no confirma el patch.** `reconcile` sí lo hace y lanza `PassPatchNotAppliedError`; el `409` no.
5. **Los `getObject` de `reconcile` no leen los bindings.** Es la razón por la que el punto 4 no se detecta nunca, ni siquiera por el sweep.
