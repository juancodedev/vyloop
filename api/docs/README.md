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

**No existe un endpoint de webhook en este repositorio.** No hay receptor
implementado y esta especificación no documenta ninguno. Lo que sigue es
arquitectura, no un contrato.

- **La llamada al mostrador es el único canal que lleva la atribución.** Sólo el
  terminal sabe que hubo un pase escaneado. Una webhook del medio de pago trae el
  pago y el monto, pero **no** el hecho de que hubiera un pase de lealtad
  involucrado — así que **una webhook no puede reemplazar a la llamada**.
- **El papel de la webhook es la reconciliación.** "El medio de pago dice que el
  pago X se liquidó y no tenemos checkin para él" es la señal de que **se perdió
  una atribución**. Sin ese control, una atribución perdida es silenciosa.
- **Por eso la llamada lleva `payment_id`.** Es lo que permite comparar los dos
  lados. Sin esa columna, la conciliación no se puede escribir.

Aclaración importante: `scripts/check-checkin-backlog.mjs` **no** es esto. Ese
script ve la mitad del problema — las ventas que se registraron y no se
acreditaron. No ve las ventas que nunca llegaron, que es justo lo que una webhook
o un poll encontrarían.

---

## 7. Cómo obtener `terminal_id` y `secret`

**Nada los crea todavía.** No hay ruta, no hay script, no hay pantalla. La tabla
`pos_terminals` existe y el emisor de token está completo y desplegado, pero
**ninguna fila se escribe** por ningún camino de la API.

Mientras tanto hay que acordarlo **por fuera del sistema**. Si necesitás una prueba
de punta a punta, hay que insertar la fila a mano en la base con `key_hash`
generado por `hashPassword` (formato `saltHex:hashHex`, el mismo de
`users.password_hash`), porque el texto plano nunca se guarda ni se puede volver a
leer.

Esto está registrado como pendiente en
[`docs/18-Trabajo-Pendiente.md`](../../docs/18-Trabajo-Pendiente.md) § Etapa 0b, y
es lo único que bloquea la prueba de punta a punta.

Cuando el endpoint de alta llegue, el secreto se mostrará **una sola vez** en el
momento de la creación.

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