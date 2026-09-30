# Crear una tarjeta de lealtad para un negocio nuevo

Cada negocio es un tenant. Cada tenant tiene **una clase de Google Wallet** — la plantilla compartida — y **un objeto por cliente**. El mismo emisor de Google sirve a todos los tenants; lo que cambia por negocio es la clase.

```
emisor de Google (uno, de la plataforma)
  └── clase por tenant      <issuerId>.tenant-<tenantId>
        └── objeto por cliente   <issuerId>.member-<customerGlobalId>
```

## Antes de leer esto: hoy no hay camino automático

`insertClass` existe en el cliente de Google Wallet, está implementado y tiene tests, y **ningún código de producción lo llama**. Es el mismo patrón que tenía `insertObject` antes de que lo arregláramos: método escrito, testeado contra un fake, jamás ejercitado.

Lo que sigue es un procedimiento manual. Es lo que se hizo para Café Central. No es una API y no debería copiarse como patrón: la automatización es el trabajo pendiente (ver *Automatizar esto* más abajo).

## Antes de arrancar, una vez por plataforma

Tres cosas existen a nivel de cuenta, no de negocio, y se hacen **una sola vez**:

| | Qué es |
|---|---|
| **Emisor de Google** | La cuenta de Google Wallet API. `3388000000023206930` en producción. La clave de Lawen Tech Solutions. |
| **Service account** | `vyloop-wallet@vyloop-loyalty.iam.gserviceaccount.com`, con rol **Developer** en el emisor. Firma los JWT y llama a la API. |
| **Google Wallet API** | Habilitada en el proyecto GCP. |

Sus dos credenciales son **secrets** del worker `wallet`, no variables de entorno:

```bash
# El JSON de la service account es la única copia. Está en la raíz del repo y en
# .gitignore. Sus valores van por stdin para que la clave no quede en el historial.
node -e "console.log(require('./vyloop-loyalty-7fbe2a881e3a.json').client_email)" \
  | npx wrangler secret put GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL
node -e "console.log(require('./vyloop-loyalty-7fbe2a881e3a.json').private_key)" \
  | npx wrangler secret put GOOGLE_WALLET_PRIVATE_KEY
```

Cada `secret put` despliega una versión nueva del worker. Son dos despliegues.

## Paso 1 — Crear la clase en Google

El `classId` no se elige: se deriva. Es `<issuerId>.tenant-<tenantId>`, y el código lo vuelve a derivar en cada request para comparar. Si la fila y la fórmula discrepan, la emisión falla en vez de usar la clase equivocada.

```bash
# El tenant_id es el UUID de la fila en `tenants`. Cqué Central:
#   90d5ad58-bc5c-46a3-b82a-9cebb47e00b1
ISSUER=3388000000023206930
TENANT=90d5ad58-bc5c-46a3-b82a-9cebb47e00b1
CLASS_ID="$ISSUER.tenant-$TENANT"
```

Los cuatro campos de imagen que acepta una loyalty class, y solo cuatro. `logo`, `largeLogo`, `smallLogo` e `issuerLogo` **no existen** en este tipo de pase: son de otros. Mandarlos no da error, los descarta en silencio.

```bash
IMG="https://<host>/brand/<slug>.jpg"   # 1000x1000, JPEG, sin canal alpha

curl -s -X PATCH \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{
    \"localizedIssuerName\": { \"defaultValue\": { \"language\": \"es-CL\", \"value\": \"<Nombre del Negocio>\" } },
    \"homepageUri\":          { \"uri\": \"https://<host>/program\", \"description\": \"Programa de lealtad\" },
    \"programLogo\":          { \"sourceUri\": { \"uri\": \"$IMG\" } },
    \"wideProgramLogo\":      { \"sourceUri\": { \"uri\": \"$IMG\" } }
  }" \
  "https://walletobjects.googleapis.com/walletobjects/v1/loyaltyClass/$CLASS_ID"
```

Detalles que importan y que costaron una iteración cada uno:

- **`localizedIssuerName` es el nombre del negocio**, no el de la plataforma. Es lo que el cliente ve arriba en el pase. La plataforma es el emisor de registro ante Google, pero la tarjeta dice del negocio.
- **La imagen tiene que ser una URL pública HTTPS.** Google la baja desde su lado; un archivo local no sirve. En producción se sirve desde `apps/customer-web/public/brand/`, que ya está en el CDN.
- **JPEG sin canal alpha.** El PNG de origen traía `RGBA` y Google no tiene uso para transparencia en un pase. Aplanado a 1000×1000 y 68 KB.
- **No pongas `heroImage` con un logo cuadrado.** Se muestra al 100% del ancho y se deforma. Y `wordMark` está deprecado.
- **`homepageUri` es barato y es el motivo de rechazo más común** en la review de Google.

## Paso 2 — Guardar la fila

```sql
INSERT INTO tenant_wallet_programs (tenant_id, issuer_id, class_id, review_status, demo_mode)
VALUES (
  '<tenantId>'::uuid,
  '3388000000023206930',
  '3388000000023206930.tenant-<tenantId>',
  'draft',
  true
)
ON CONFLICT (tenant_id) DO NOTHING;
```

`review_status` arranca en `draft` a propósito. `demo_mode` en `true` también: el negocio empieza en modo demo hasta que Google apruebe.

El `class_id` es una función pura del `issuer_id` y el `tenant_id`, y hay un test que lo verifica. Si alguna vez se.discuerda con la fórmula, es un defecto de datos, no una elección.

## Paso 3 — Aprobar

```bash
curl -s -X PATCH -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"reviewStatus":"underReview"}' \
  "https://walletobjects.googleapis.com/walletobjects/v1/loyaltyClass/$CLASS_ID"
```

**De ida.** La documentación de Google: *"Once the review state is changed from `draft` it may not be changed back to `draft`."* Si la rechazan, hay que crear una clase nueva con otro sufijo y corregir el `class_id` de la fila.

Café Central fue aprobada en el acto. No contemos con eso: es una decisión de Google y puede tardar.

## Paso 4 — Sincronizar y salir de demo

El paso que más se olvida, y el que hace que el pase siga diciendo `[SOLO PARA PRUEBAS]` aunque Google ya haya aprobado.

Nuestra fila dice `draft` desde el paso 2 y **nadie la actualiza sola**. Mientras siga así:

- `WALLET_DEMO_MODE=true` fuerza modo demo sobre una clase que ya está aprobada
- el pase sale con `[SOLO PARA PRUEBAS]`, que es lo que el cliente ve
- `demo_mode` efectivo = `env || fila`, así que el env gana siempre

El estado real se lee de Google con la ruta operator-only:

```
POST /v1/wallet/program/sync
```

Espera `review_status = approved` y después baja `WALLET_DEMO_MODE` a `"false"` en `workers/wallet/wrangler.jsonc`. **En ese orden**: si bajás el env antes de sincronizar, la fila sigue en `draft` y la emisión se corta.

## Cómo conseguir el token de Google

La API de `walletobjects` pide un access token de la service account. El MCP de Google no sirve para esto — no expone la API de `walletobjects`. La vía que funciona es el JWT-bearer:

```bash
node --input-type=module -e "
import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
const k = JSON.parse(readFileSync('vyloop-loyalty-7fbe2a881e3a.json','utf8'));
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const n = Math.floor(Date.now() / 1000);
const a = b64({ alg:'RS256', typ:'JWT' }) + '.' +
  b64({ iss: k.client_email, scope: 'https://www.googleapis.com/auth/wallet_object.issuer',
        aud: k.token_uri, iat: n, exp: n + 3600 });
const s = createSign('RSA-SHA256'); s.update(a);
const r = await fetch(k.token_uri, { method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: a + '.' + s.sign(k.private_key, 'base64url') }) });
console.log((await r.json()).access_token);"
```

## Verificar que funcionó

No alcanza con que la API devuelva 200. **Leé el objeto desde Google** y compará con el ledger:

```bash
# el saldo en la tarjeta
curl -s -H "Authorization: Bearer $ACCESS_TOKEN" \
  "https://walletobjects.googleapis.com/walletobjects/v1/loyaltyObject/$ISSUER.member-<customerGlobalId>"
```

```sql
SELECT balance_after FROM points_transactions
WHERE customer_id = '<id>'::uuid ORDER BY created_at DESC LIMIT 1;
```

Si difieren, el pase no se está proyectando. Es la única comprobación que distingue "funciona" de "parece funcionar": una API que devuelve 200 y un link con aspecto correcto no prueban que Google tenga el objeto.

## Automatizar esto

Es el trabajo pendiente real. `insertClass` es el método que falta llamar, y el paso 2 necesita la fila en la misma transacción. La forma correcta es un paso de onboarding en el alta del negocio: derivar el `classId`, insertar la clase, insertar la fila, y dejar el tenant en demo hasta que la review responda.

Mientras sea manual, cada cliente nuevo necesita a alguien que sepa hacer esto. Y esa es la clase de dependencia que no escala.

## Lo que este procedimiento no cubre

- **Publicación.** Una clase `approved` sigue mostrando `[SOLO PARA PRUEBAS]` mientras el emisor no tenga acceso de publicación. Se pide en la consola de Google Pay & Wallet y lo revisa Google.
- **Pruebas de escritura.** No hay tests de integración contra la API real. Cada cosa que se learnió acá — el casing del `state`, el case de los paths, los campos de imagen que no existen — salió de ejecutarla a mano.
