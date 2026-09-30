# Alta de negocios y de clientes, de punta a punta

Dos flujos encadenados. El primero crea negocios sin intervención. El segundo crea clientes y les entrega la tarjeta en el momento.

```
Negocio se registra  →  recibe su QR  →  cliente escanea  →  recibe su tarjeta
   (5 minutos)            (inmediato)      (30 segundos)      (inmediato)
```

Ninguno de los dos existe hoy. No están rotos: nunca se escribieron. Lo único que crea un negocio es `packages/db/scripts/seed.ts`, un script de una sola vez para Café Central.

## Decisiones tomadas

- **El negocio opera antes de que Google apruebe.** El alta no espera. La clase se crea en `draft` y el pase se emite igual, en modo demo. Google aprueba después y el tenant deja de estar en demo cuando alguien lo decide.
- **El negocio sube su logo.** Sin imagen la review de Google no pasa, y la review es lenta. Pedirla en el alta convierte una espera de días en una espera de minutos.

## Lo que hay que construir

### Flujo A — alta de negocio

Cinco escrituras encadenadas, y la quinta está fuera de nuestra transacción:

| # | Qué | Dónde |
| --- | --- | --- |
| 1 | `tenants` | sin escritura en el código hoy |
| 2 | `users` — el administrador | idem |
| 3 | `loyalty_programs` — la moneda de puntos | idem |
| 4 | `membership_tiers` — el nivel inicial | idem |
| 5 | clase de Google + fila en `tenant_wallet_programs` | `insertClass` existe y no lo llama nadie |

La 5 es la única que puede fallar por algo externo, y es la única que decide si el cliente recibe tarjeta hoy o no. Por eso el alta tiene que **terminar aunque Google falle**, y registrar que la clase quedó pendiente para reintentarla.

### Flujo B — alta de cliente con tarjeta inmediata

```
QR del negocio  →  formulario (nombre, teléfono)  →  customer + member code
                                                        ↓
                                            insert del objeto en Google
                                                        ↓
                                            link de Google Wallet al teléfono
```

Esto ya funciona por partes: el pase de Ana se emitió de punta a punta con la API. Lo que falta es el camino sin humano en el medio.

## La restricción que hay que decir antes de construir

**El modo demo impide que un cliente real guarde la tarjeta.**

Google vincula el pase a la cuenta de Google con la que se abre el link. Sin acceso de publicación, solo las cuentas de prueba del emisor pueden guardarlo. Hoy hay una: la nuestra.

Consecuencia concreta: el flujo B se puede construir entero y va a funcionar —el cliente se registra, se le crea su member code, se le emite el pase, Google lo acepta— **pero si lo prueba alguien con su Gmail personal, el pase no le aparece.** Le va a tocar a la cuenta de prueba.

No es un motivo para no construirlo. Es un motivo para saber qué se está prometriendo mientras tanto.

## Decisiones abiertas

1. **Dónde vive el logo.** Google necesita una URL pública HTTPS para descargarlo. El repo no tiene R2 ni almacenamiento de objetos; hay KV en cuatro workers, que no sirve para binarios. Hace falta decidir dónde se suben, y eso crea o reaprovecha un bucket.
2. **Si el logo es obligatorio.** Recomendado sí, por lo de la review. Si es opcional, el alta se frena en la review y el negocio pasa días sin tarjeta.
3. **Normalizar la imagen en el alta.** El PNG de Café Central traía canal alpha y hubo que aplanarlo a JPEG 1000×1000. Si no se normaliza en el alta, cada tenant repite el mismo error y la review lo rechaza.

## Orden de construcción

**A1 — el alta de negocio sin la clase de Google.** Transacción, cinco escrituras, más el usuario administrador. Se prueba registrando un negocio de verdad.

**A2 — la clase y la fila de wallet**, con reintento si Google falla. Recién acá un negocio nuevo tiene tarjeta.

**A3 — el logo**, con su almacenamiento y su normalización. Antes de A3, la clase se crea con el logo por defecto de la plataforma.

**B1 — el formulario de cliente y el QR.** El alta de cliente por sí sola, sin tarjeta.

**B2 — la tarjeta inmediata**, reutilizando el camino ya verificado.

## Lo que no se cubre

- **Pruebas de integración contra la API de Google.** Cada defecto grave de esta historia salió de ejecutarla a mano: el casing de los paths, el `state` en minúscula, los campos de imagen que no existen. Ese es el patrón que se repite y ninguno se cazó con un test.
- **La publicación.** Es de Google y no depende de nada que hagamos.
- **Aislamiento entre tenants en las lecturas.** `RLS` sigue desactivado y el aislamiento vive en los filtros del store. Un alta que crea cinco filas tiene que escribirlas con el mismo cuidado con el que las lee.

## Riesgo principal

El orden importa en un punto: **B2 sin A2 emite pases contra clases que no existen.** El error de Google en ese caso es `Class not approved`, que no dice "el alta está a medias" sino "tu clase no sirve". Un tenant en ese estado se ve vivo y no tiene tarjeta, y no hay nada en el producto que lo señale.
