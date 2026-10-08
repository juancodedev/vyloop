# Integración con terminal de pago

Contrato para integrar el terminal de pago de un comercio —el que cobra— con Vyloop.

- **Especificación:** [`openapi.yaml`](./openapi.yaml) (OpenAPI 3.1.0). Es la fuente de verdad.
- **Documento de diseño más amplio:** [`docs/08-API-Design.md`](../../docs/08-API-Design.md)

Si sólo vas a leer una cosa, lee el `info.description` de `openapi.yaml` y las
descripciones de las tres operaciones. Están escritas para que no puedas construir
el flujo equivocado por ignorarlas.

---

## 1. Qué hace esta integración, y qué no

### Hace

Avisa a Vyloop de **hechos que ya ocurrieron**: que se escaneó un pase, y que una
venta se cobró. Vyloop guarda esos hechos y calcula lo que valen.

### No hace

- **No cobra.** El checkout es del comercio. Vyloop nunca recibe un pago.
- **No calcula puntos.** Ver la regla de la sección 3.
- **No es un POS.** La lealtad que exige poseer el checkout sólo crece al ritmo de
  los comercios que instalan nuestro POS. La que escucha al terminal crece al
  ritmo de todos los demás.

---

## 2. La regla: Vyloop es la fuente de la verdad

> **El terminal reporta dinero. La regla del tenant decide qué vale.**

El terminal envía `amount_cents`. El tenant tiene una regla de acumulación
configurada (compra o visita, con su tasa y su unidad monetaria) y Vyloop aplica
esa regla **en el servidor, en el momento de la venta**.

**El terminal no puede fijar el valor de un punto ni asignar puntos.** No hay
campo para eso en ninguna petición, y la credencial de mostrador (`pos:`) es
rechazada explícitamente en la ruta que sí puede asignarlos
(`POST /v1/loyalty/points/assign`), con el mismo código y el mismo mensaje que
recibe un cliente.

Si tu diseño calcula los puntos en el terminal y los manda, ese diseño está mal.
No es una recomendación: es que la ruta no lo acepta.

Lee `points` en la respuesta del checkin para saber cuánto valió la venta. Es un
resultado, nunca una entrada.

---

## 3. El flujo: dos llamadas, en dos momentos distintos

No son una sola llamada porque no son un solo momento. El escaneo del cajero no es
el pago, y fusionarlos haría indistinguible un fallo de conciliación de un fallo
de escaneo.

```
1. El cliente muestra su pase.
2. El cajero lo escanea.
   → POST /v1/loyalty/passes/resolve      { "member_code": "..." }
   → 200 { data: { known: true, customer_id, display_name } }   seguir con atribución
   → 200 { data: { known: false } }                           cobrar igual, sin atribuir
3. Se cobra la venta, normalmente, en el terminal.
4. Cuando el pago se concreta:
   → POST /v1/loyalty/checkins  { payment_id, member_code, amount_cents }
   → 201 primera vez  ·  200 reintento
```

### El paso 2 nunca bloquea la venta

Nuestra falla nunca puede costarle una venta a un comercio. Un `500` en esa
pantalla significaría que le negamos un café a alguien porque de nuestro lado
había un problema. Por eso `resolve` **crea nada, no tiene estado, y responde 200
en los dos casos**.

`known: false` es *información*: el cajero sigue cobrando, sólo que sin atribuir
la venta. **Nunca es un veto.**

Y por eso **no hay un 404** en esa ruta: un código desconocido responde `200` con
`known: false`. Una forma de rechazo se convertiría en un oráculo de existencia —
quien distinguiera "no existe" de "petición mal formada" podría sondear la
membresía del tenant con él.

> Ojo con la asimetría, que es deliberada: en `checkins` un código que no resuelve
> **sí** es `404` (`MEMBER_CODE_NOT_FOUND`). Ahí la venta ya ocurrió, y el
> terminal necesita saber que **su atribución no llegó** — que es lo único útil
> que puede hacer con la respuesta.

### Autenticación

Las dos llamadas de lealtad exigen el token de mostrador:

```
Authorization: Bearer <token>
```

Se obtiene en `POST /v1/auth/pos/token`, que es **público a propósito**: un
terminal guarda un secreto, no una sesión. El token dura **una hora** y no hay
refresh: el terminal lo reintercambia con su credencial guardada, que es
justamente el motivo de guardar un secreto.

---

## 4. Reintentar siempre es seguro

Esto es la parte que sostiene el contrato, y no es opcional.

La idempotencia es `unique(business_id, payment_id)`, garantizada **por la base de
datos** y no por un leer-y-luego-escribir: dos reintentos concurrentes del mismo
pago no pueden ganar los dos.

Al reenviar un `payment_id` ya registrado:

- Se responde **`200`** y **no se acredita dos veces**.
- Si el crédito anterior quedó pendiente (`points` viene `null`), el reintento
  **lo completa**.

O sea: reintentar no sólo evita el doble crédito, **termina** un crédito a medio
hacer. Sin ese segundo paso la falla parcial sería una pérdida en lugar de un
retraso, y sería una pérdida que el comercio ni siquiera puede ver: el mensaje
del terminal era la única evidencia de que había pasado una atribución.

**Reintentar es la recuperación prevista ante cualquier falla transitoria.** No
necesitás un script de reconciliación para reparar un checkin a medio escribir.

Mandá `payment_id` siempre que el medio de pago te lo haya dado. Es la clave de
deduplicación **y** lo único que permite descubrir más adelante una venta que
nunca llegó.

---

## 5. `items`: opcional, melhor-de-melhor, y normalmente ausente

```json
"items": [
  { "product_ref": "SKU-7781", "name": "Flat white", "qty": 2, "unit_price_cents": 3500 }
]
```

Cuatro decisiones, ninguna por conveniencia:

1. **`product_ref` es una cadena opaca tuya o del medio de pago.** No es un
   identificador de Vyloop. **No existe una tabla `products`.** Copiar la
   identidad del producto implicaría mantener una copia que se vuelve mentira en
   el momento en que el comercio renombra algo.
2. **Los valores van en línea porque esto es una foto histórica.** Si el producto
   se renombra o se borra después, la estadística histórica tiene que seguir
   diciendo qué se vendió realmente.
3. **`amount_cents` es lo autoritativo y `items` es mejor-esfuerzo.** Si no
   cuadran, gana el dinero y **la venta nunca se rechaza por metadata que no
   suma.**
4. **Esperá que esté ausente.** Un medio de pago con tarjeta transporta el total,
   no el carrito: los ítems viven en el POS del comercio. `items: null` es el
   caso normal, no un defecto.

---

## 6. La webhook y por qué no reemplaza a esta llamada

**Ahora existe un receptor de webhook en este repositorio:**
`POST /v1/loyalty/webhooks/payments`. Lo que sigue sigue siendo cierto —y es la
razón por la que el receptor no sustituye a la llamada—, pero la frase "no existe"
ya no lo es.

- **La llamada al mostrador es el único canal que lleva la atribución.** Sólo el
  terminal sabe que hubo un pase escaneado. Una webhook del medio de pago trae el
  pago y el monto, pero **no** el hecho de que hubiera un pase de lealtad
  involucrado — así que **una webhook no puede reemplazar a la llamada**.
- **El papel de la webhook es la reconciliación.** "El medio de pago dice que el
  pago X se liquidó y no tenemos checkin para él" es la señal de que **se perdió
  una atribución**. Sin ese control, una atribución perdida es silenciosa.
- **Por eso la llamada lleva `payment_id`.** Es lo que permite comparar los dos
  lados. Sin esa columna, la conciliación no se puede escribir.

### Lo que el receptor hace, y lo que no puede hacer

Graba el pago en `settled_payments` y nada más. **No acredita puntos, no crea un
checkin y no resuelve a un cliente**: el webhook no trae el `member_code`, y el
único que sabe que hubo un pase es el terminal. La ruta vive en el worker de
growth, es pública en el gateway (`EXACT_PUBLIC_PATHS`) y se autentica con una
firma HMAC sobre el cuerpo crudo, no con un token de Vyloop. Si llega con una
credencial de Vyloop —cliente o mostrador— la rechaza con su propio código, que no
es el `UNAUTHORIZED` del middleware: esa ruta es del medio de pago.

> **Una webhook detecta una atribución perdida; no puede repararla.** El pago
> entra, el monto entra, el hecho de que se escaneó un pase no. Así que cuando el
> chequeo encuentre un pago liquidado sin checkin, sabe **que** se perdió una
> atribución y nada más: no sabe **de quién**. La recuperación es que el terminal
> reenvíe el checkin, o que una persona le pregunte al cajero. No hay un botón de
> reparación, y no debe haber uno.

**El esquema de firma todavía no está confirmado contra la documentación de Mercado
Pago.** Por eso la construcción del mensaje firmado vive en una función sola, con su
prueba propia, y por eso la ruta falla cerrada ante una firma ausente, inválida o
ante la ausencia del secreto. Hay que verificarla antes de apuntarla a algo real.

### Los dos chequeos, y por qué no se fusionan

| Script | Pregunta | Qué ve |
|---|---|---|
| `scripts/check-checkin-backlog.mjs` | ¿Ventas grabadas y sin puntos? | `checkins` con `points IS NULL` |
| `scripts/check-payment-reconciliation.mjs` | ¿Pagos liquidados y sin checkin? | `settled_payments` sin fila en `checkins` |

No son la mitad del mismo problema: son dos mitades distintas. El primero necesita
una fila que mirar —`points IS NULL` es la señal— y una venta que nunca se reportó
no tiene ninguna. Por eso el segundo existe, y por eso fusionarlos haría que el
primero reportara como problema algo que no lo es.

---

## 7. Cómo obtener `terminal_id` y `secret`

**Ya no hay que insertar la fila a mano.** Los tres endpoints del ciclo de vida
existen, y `pos_terminals` dejó de ser una tabla que nadie escribe.

Los crea un **operador del comercio** —staff o dashboard—, no el terminal. Viven
bajo el prefijo `/v1/loyalty` y exigen su token: un token de cliente y un token de
mostrador reciben `403 OPERATOR_ROLE_REQUIRED`, el mismo código y el mismo mensaje
que cualquier otra ruta de configuración del programa.

| Operación | Ruta | Status |
|---|---|---|
| Registrar | `POST /v1/loyalty/terminals` | `201` |
| Listar | `GET /v1/loyalty/terminals` | `200` |
| Revocar | `POST /v1/loyalty/terminals/{terminal_id}/revoke` | `200` |

```bash
curl -X POST https://api.vyloop.com/v1/loyalty/terminals \
  -H "Authorization: Bearer <token-de-operador>" \
  -H "Content-Type: application/json" \
  -d '{"name":"Caja 1"}'
```

Después, el intercambio es el de siempre:

```
→ POST /v1/auth/pos/token  { "terminal_id": "<id>", "secret": "<el de arriba>" }
```

### El secreto se muestra una sola vez

Es la única vez que existe fuera del comercio. La fila guarda únicamente
`key_hash`: PBKDF2 en formato `saltHex:hashHex`, el mismo que `users.password_hash`,
porque es lo que `POST /v1/auth/pos/token` verifica.

**No hay endpoint que devuelva el secreto, y no debe haber uno.** Si se pierde, se
revoca esa fila y se registra un terminal nuevo. No se recupera.

El listado nunca devuelve `key_hash`, y `business_id` sale siempre del ámbito de la
credencial, nunca del cuerpo de la petición.

### Revocar es blando

`revoked_at` se marca y la fila **no** se borra: la conciliación por `payment_id`
sigue resolviendo contra ese `id`, y el operador puede ver que esa caja existió y
fue dada de baja en vez de inferir de su ausencia que nunca existió. El efecto es
inmediato —el intercambio comprueba `revoked_at` en cada llamada— y revocar dos
veces no es conflicto.

Revocar un id de otro comercio responde `404 NOT_FOUND`, **idéntico** a un id que no
existe: el `WHERE` incluye `business_id`, así que la fila de otro tenant nunca
coincide y la respuesta no distingue los dos casos.

### Por qué estas tres rutas no están en `openapi.yaml`

`openapi.yaml` es el contrato de **la integración del terminal**, y su conjunto de
rutas se deriva de los dos primitivos de autorización de mostrador
(`requireCounterSubject` y `counterSubject`). Estas tres rutas no los usan —los usa
`requireOperatorRole`— porque las llama un operador y no un mostrador: describen
cómo se crea una credencial, no cómo se reporta una venta. Por eso viven en este
README y no en el spec, y por eso el test de drift del spec no las mira.

Los dos códigos que emiten y que no están en el enum de `openapi.yaml` son
`VALIDATION_ERROR` (nombre ausente o en blanco, y no se escribe nada) y `NOT_FOUND`
más `OPERATOR_ROLE_REQUIRED`, como arriba.

### Por qué el receptor de la sección 6 tampoco está en `openapi.yaml`

`POST /v1/loyalty/webhooks/payments` existe y tampoco está en el spec, por la misma
razón de alcance: el spec es el contrato del **terminal**, y su conjunto de rutas se
deriva de los dos primitivos de autorización de mostrador. El receptor no usa
ninguno —lo autentica una firma, no un token— y no lo llama un terminal: lo llama el
medio de pago. Documentarlo aquí y no en el spec es la misma decisión que la de las
tres rutas de ciclo de vida, por el mismo motivo.

Los códigos que emite, que tampoco están en el enum:

- `PAYMENT_WEBHOOK_CREDENTIAL_NOT_ALLOWED` — llegó una credencial de Vyloop. No es
  `UNAUTHORIZED` a propósito: ese es lo que responde una *cabecera del gateway
  ausente*, y quien lo reciba no podría distinguir que la ruta nunca fue suya —
  así que intentaría mandar un JWT.
- `PAYMENT_WEBHOOK_SECRET_UNAVAILABLE` — no hay secreto configurado. Hoy es el
  estado real en todos los entornos: no existe ninguna credencial de Mercado Pago
  en este repositorio.
- `PAYMENT_WEBHOOK_SIGNATURE_REQUIRED` / `PAYMENT_WEBHOOK_SIGNATURE_INVALID` —
  sin firma, o firma que no calza. Separados a propósito, porque "no configurado",
  "no firmó" y "firmó mal" son tres problemas operativos distintos.
- `PAYMENT_WEBHOOK_UNKNOWN_MERCHANT` — la referencia del cuerpo no resuelve contra
  `tenants`.
- `PAYMENT_WEBHOOK_INVALID_PAYLOAD` — cuerpo mal formado tras verificar la firma.

---

## 8. Errores

Todos los errores usan la misma envoltura:

```json
{ "error": { "code": "...", "message": "..." } }
```

- **`code` es el contrato.** Ramificá sobre el código, nunca sobre el texto.
- **`message` es para humanos** y puede cambiar de redacción. Los valores
  documentados están copiados literalmente del código fuente: si tu cliente los
  compara como texto, **no los corrijas**, porque esos strings hoy son correctos.

Los códigos documentados: `VALIDATION_ERROR`, `AUTH_TOKEN_INVALID`,
`POS_PLAN_REQUIRED`, `COUNTER_SUBJECT_REQUIRED`, `INVALID_MEMBER_CODE`,
`INVALID_AMOUNT_CENTS`, `MEMBER_CODE_NOT_FOUND`, `CONFLICT_WITHOUT_ROW`,
`INTERNAL_ERROR`.

Dos casos que merecen atención al integrar:

- **`AUTH_TOKEN_INVALID` es una sola respuesta para tres fallas**: id desconocido,
  secreto incorrecto y terminal revocado. Es intencional: un 401 distinguible
  entre "revocado" y "existe" es medio trabajo de enumerar terminales. No
  intentes deducir nada de ese 401 más allá de "esa pareja no sirve ahora".
- **`POS_PLAN_REQUIRED` es un código distinto, también a propósito.** No filtra
  nada que el comercio no sepa ya, y le da un nombre a la pregunta que una persona
  va a hacer en voz alta.

---

## 9. Sobre `docs/08-API-Design.md`

[`docs/08-API-Design.md`](../../docs/08-API-Design.md) es el documento de diseño de
la API **completa**: filosofía, autenticación, versionamiento, GraphQL, la envoltura
de error estándar. Leelo para entender el sistema.

**Esta especificación es más angosta y más actual.** `08` describe la API como se
planeó; lo que hay acá es lo que está desplegado y verificado hoy para la
integración del terminal. Donde se separen, **gana esta**:

- `08` describe OAuth 2.0 + OIDC para autenticación. El terminal usa un intercambio
  de credencial propio, público, porque un terminal no tiene sesión.
- `08` describe una envoltura de error con `request_id`. La real no lo tiene.
- `08` es *Draft* y cubre toda la superficie. Esto cubre tres endpoints.

Cuando algo cambie, se cambian los dos lados o se cambia el 08 para que diga la
verdad.

---

## 10. Mantener honesto el contrato

`openapi.yaml` está escrito a mano, así que se va a desincronizar.

`apps/gateway/src/api-openapi.contract.test.ts` lee el documento **y el código
fuente** de los workers, y falla si se separan en las dos direcciones:

- una ruta documentada que ningún worker registra, y
- una ruta del mostrador registrada y **no** documentada.

También comprueba que cada `code` documentado lo emita de verdad el código, y que
cada `code` que el mostrador puede emitir esté documentado.

El conjunto de rutas **no está escrito a mano en el test**: se deriva de los dos
primitivos de autorización (`requireCounterSubject` y `counterSubject`), así que
agregar un endpoint nuevo rompe el test aunque nadie se acuerde de que este
documento existe.

Correlo con:

```bash
pnpm --filter @vyloop/gateway test
```

**Lo que ese test NO cubre**, dicho explícitamente: los *shapes* de request y
response, ni los status codes por endpoint. Eso necesitaría un parser y una
librería de esquema. El test prueba que el documento y el código coinciden sobre
**qué rutas existen y qué códigos emiten**; un verde es necesario y no suficiente.