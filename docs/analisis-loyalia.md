# Levantamiento — Loyalia

> **Fecha**: 7 de octubre de 2026
> **Web**: https://loyalia.app/
> **Alcance**: qué hace el producto y cómo lo hace (secciones 1–14), análisis competitivo (15), y los ítems que Loyalia tiene y Vyloop no, con referencias al código verificado (16).
> **Método**: sesión autenticada en el tenant de prueba "Cafe Lawen". Panel completo, alta de tarjeta, alta de cliente final, escaneo real, y descompresión del `.pkpass` en memoria.
> **Estado del tenant al entrar**: plan `free`, trial de 30 días, 0 tarjetas, 0 clientes.

---

## 1. Qué es

Plataforma de lealtad para negocios locales de LatAm (sede México, opera también Chile). El comercio genera una tarjeta digital, la guarda el cliente en **Apple Wallet** o **Google Wallet** desde un QR, y el cajero le suma sellos escaneando ese pase desde el navegador.

No hay app para el cliente final, no hay plástico, no hay hardware. Las tres promesas del login:
- "Sin comisiones por canje"
- "Apple y Google Wallet nativo"
- "Escáner web para tu equipo"

---

## 2. Arquitectura del sistema

Tres superficies, un mismo dominio.

| Superficie | Ruta | Para qué |
|---|---|---|
| Panel del comercio | `loyalia.app/merchants/*` | Configurar, ver métricas, gestionar clientes |
| Web de escaneo | `scanner.loyalia.app/scanner/*` | Login del operador por código de comercio, layout mobile-first |
| Cliente final | `loyalia.app/c/*` y `/m/*` | Registrarse y guardar el pase. Sin cuenta, sin login |

Encima de eso, dos builds: web app instalable como PWA (instrucciones de "Agregar a inicio" en Ajustes) y app nativa en App Store / Google Play (`app.loyalia.mobile`).

---

## 3. Los cinco motores de tarjeta

Un comercio puede correr varios programas a la vez. Cada tarjeta es un programa con motor, config, diseño, QR y notificaciones propias.

| # | Nombre | Config propia |
|---|---|---|
| 1 | **Sellos / Visitas** | `required`, `reward`, `rewards[]`, `earn_by`, `daily_limit`, `reset_on_redeem`, `welcome_stamps`, `show_reward_on_wallet`, `show_all_stamps` |
| 2 | **Monedero / Cashback** | `percent` (1–100) |
| 3 | **Cupón** | Texto del beneficio, usos por cliente |
| 4 | **Tarjeta recargable** | Saldo inicial |
| 5 | **Membresía** | Logo, imagen destacada, nivel |

### 3.1 `config` completo — motor `stamps`

```jsonc
{
  "required": 10,                            // sellos para el premio
  "reward": "",                              // etiqueta
  "rewards": [ { "label": "", "stamps": 7 } ], // recompensas escalonadas
  "earn_by": "purchase",                     // purchase | visit
  "daily_limit": true,                       // 1 sello/día
  "reset_on_redeem": true,                   // reinicia al canjear
  "welcome_stamps": 0,                       // 0..10 al descargar
  "show_reward_on_wallet": true,             // muestra el nombre del premio en Apple
  "show_all_stamps": false,

  // compartidos por todos los motores
  "registration": { "name": "required", "phone": "optional", "birthday": "optional" },
  "expiration":    { "enabled": false, "days": 30 },
  "links": [],
  "sections": [],
  "custom_fields": [],
  "levels": {
    "enabled": false,
    "metric": "visits",
    "cycle_months": 6,
    "cycle_start_month": 1,
    "threshold_unit": "cents",
    "tiers": []
  },
  "notifications": { /* ver §6 */ }
}
```

### 3.2 `config` — motor `cashback`

```jsonc
{
  "percent": 5,                              // "Cualquier valor de 1 a 100%"
  "reward": "",
  "notifications.purchase.cashback_message": ""
}
```

Al cambiar de motor, los campos del motor anterior **persisten en la fila** y quedan inertes. El motor lee los que le sirven.

### 3.3 `card_type` y `engine` son dos campos

`card_type` es el producto que el comercio compró; `engine` es la máquina que calcula el avance. Hoy coinciden siempre, pero están separados.

---

## 4. Modelo de datos

Extraído de los props de Inertia y de respuestas reales.

### 4.1 Comercio

```jsonc
{
  "id": 2197,
  "name": "Cafe Lawen",
  "slug": "cafe-lawen",
  "status": "approved",
  "statusReason": null,
  "plan": "free",
  "currency": "clp",             // 20 monedas
  "phoneCountry": "CL",          // 24 países
  "cardLocale": "es",            // idioma del FORMULARIO del cliente, separado del panel
  "integrations": true,
  "googleReviews": false,
  "whatsapp": false
}
```

### 4.2 Usuario de comercio

```jsonc
{
  "id": 1960,
  "name": "Jhon Muñoz",
  "role": "owner",               // owner | operador
  "locale": "es",
  "isOwner": true,
  "permissions": ["cards", "scanner", "customers"],  // 3 permisos, sin granularidad
  "showWalkthrough": true
}
```

`currentUser` agrega `tier: "standard" | admin` y `admin: boolean`. Existe una superficie de superadmin separada del merchant, con las props `admin` e `impersonation` en todas las páginas.

### 4.3 Tarjeta

```jsonc
{
  "id": 2166,
  "name": "Tarjeta recargable",
  "slug": "Sryu4tsw",           // 8 chars, URL pública /c/{slug}
  "card_type": "stamps",
  "engine": "stamps",
  "status": "draft",            // draft | active
  "config": { /* §3.1 */ },
  "design": {
    "primary": "#a8492f",
    "text": "#fdf6ec",
    "accent": "#a8492f",
    "glyph": "★",
    "code_format": "qr"
  },
  "logo_url": null,        // cuadrado → Google Wallet + notificaciones
  "logo_wide_url": null,   // horizontal → esquina superior izquierda en Apple
  "hero_url": null,        // foto detrás de los sellos
  "stamp_empty_url": null,
  "stamp_filled_url": null,
  "terms": [ /* 3-4 líneas autogeneradas a partir de la config */ ],
  "public_url": "https://loyalia.app/c/Sryu4tsw"
}
```

### 4.4 Membresía — la fila que une cliente y tarjeta

Vista desde el merchant:

```jsonc
{
  "id": 12092,
  "card_name": "Tarjeta recargable",
  "card_type": "stamps",
  "engine": "stamps",
  "stamps": 2,
  "goal": 7,                        // copia de config.required, desnormalizada
  "balance_cents": 0,
  "redemptions_count": 0,
  "coupon_limit": 1,
  "coupon_redeemed": false,
  "last_visit_at": "2026-10-07T01:57:55.649Z",
  "expires_at": null,
  "expiration_status": "never",     // never | active | due_soon | expired
  "expiration_source": null,
  "reward_ready": false
}
```

Vista desde el cliente (minimal, sin PII):

```jsonc
{
  "name": "Analista QA Vyloop",
  "qr_token": "uAJDfWhjqFSJJqXwjq7Hw2wL",   // 22 chars
  "stamps": 2,
  "balance_cents": 0,
  "redemptions_count": 0,
  "coupon_remaining": 0,
  "coupon_redeemed": false,
  "next_reward": { "stamps": 7, "label": "" },
  "reward_ready": false,
  "level_label": null
}
```

El cliente no recibe su id, ni email, ni teléfono. Solo un nombre y el token.

### 4.5 Cliente

```jsonc
{
  "id": 11917,
  "name": "Analista QA Vyloop",
  "email": "qa.vyloop.test@example.com",
  "phone": "+56912345678",
  "source": "card",               // cómo entró al CRM
  "birthday": "1990-06-15",
  "custom_data": {},              // los custom_fields del wizard
  "cards_count": 1,
  "joined_at": "2026-10-07T01:55:31Z",
  "stats": { "cards_count": 1, "spend_cents": 0, "visits_count": 1, "rewards_count": 0 },
  "last_visit_at": "2026-10-07T01:57:55.649Z",
  "memberships": [ /* §4.4 */ ],
  "notes": []
}
```

El listado de clientes expone contadores `total / with_card / direct`, lo que confirma que el CRM unifica clientes que llegan por la tarjeta y captados por otro lado.

### 4.6 Actividad

```jsonc
{ "kind": "stamp", "amount_cents": null, "purchase_amount_cents": null,
  "member_name": "Analista QA Vyloop", "at": "2026-10-07T01:57:55Z" }
```

Log de append con `kind` discriminante. Dos campos de importe distintos: `amount_cents` (crédito) y `purchase_amount_cents` (lo que el cliente pagó). Eso es lo que permite ticket promedio sin tramposo.

### 4.7 Trial y uso del plan

```jsonc
"trial": { "active": true, "expired": false, "daysLeft": 30, "endsAt": "...", "plan": null }

"plan":  { "plan": "free", "interval": "monthly", "billing_source": null,
           "cards":     { "used": 0, "limit": 1 },
           "customers": { "used": 0, "limit": 100 },
           "branches":  { "used": 0, "limit": 1 },
           "staff":     { "used": 0, "limit": 1 },
           "current_period_end": null }
```

### 4.8 Feature flags

Dos capas:

```jsonc
// global, por usuario
"telemetry": { "user": 1960, "attributes": {
  "surface": "panel",            // panel | public
  "plan": "free",
  "country": "CL",
  "flag.scanner_fetching_spinner": true,
  "flag.tiered_rewards": true,
  "flag.card_icons": true,
  "flag.loyalty_levels": false
}}

// por tarjeta
{ "tiered_rewards": true, "full_stamp_card": true, "show_all_stamps": false,
  "auto_renew_available": true, "stamp_hero": false,
  "club_cards": true, "stamp_card_hero": true, "loyalty_levels": false, "card_icons": true }
```

`loyalty_levels: false` con `config.levels.enabled: false` aparecen los tres a la vez: los niveles/tiers existen en el modelo de datos pero no están lanzados.

### 4.9 Props del escáner

```jsonc
{
  "found": null, "not_found": false, "results": [], "q": null,
  "no_cards_assigned": false,
  "ticket_photo_enabled": true,    // flags por comercio
  "note_required": false,
  "ticket_photo_required": false,
  "cashback_override_allowed": true,
  "customer_search_enabled": true,
  "fetching_spinner_enabled": true
}
```

Cada capacidad del escáner es un flag del comercio. Uno puede exigir foto del ticket, exigir notas, o bloquear la búsqueda por nombre.

### 4.10 Kiosco

```jsonc
"kiosk": { "status": "available", "enabled": false, "cardIds": [],
           "lapseAlerts": false,
           "url": "https://loyalia.app/kiosk/aMPCY2vy613SR3Nr9HAek3tSYmnZqpGq" }
"filters":  { "expiration": null, "q": null, "card_id": null }
"statuses": ["active", "due_soon", "expired"]
"stats":    { "active": 0, "due_soon": 0, "expired": 0 }
"entries":  []
```

El token del kiosk es de 32 caracteres, más largo que el `qr_token` de 22 — como corresponde a un endpoint expuesto sin login.

---

## 5. Flujos

### 5.1 El comercio crea una tarjeta

```
/merchants/dashboard
  └─ empty state: "0 DE 2" Primeros pasos
  └─ "Nueva tarjeta" → /merchants/cards/new
        └─ el servidor crea el registro INMEDIATAMENTE (id 2166, status: draft)
           y redirige a /merchants/cards/2166
        └─ Wizard de 5 pasos, estado en query string
        └─ "Guardar" → toast "Tarjeta guardada." (no sale del wizard)
        └─ "Ir a la tarjeta" → /merchants/cards/:id/detail
  └─ /merchants/cards/:id/detail
        └─ switch activar/desactivar
           (inactiva → /c/{slug} devuelve 404; activa → link compartible)
        └─ "Copiar enlace de la tarjeta" → https://loyalia.app/c/{slug}
        └─ "PDF" → pase imprimible para el mostrador
        └─ stats + clientes + actividad
```

El borrador existe antes de estar completo. `Guardar` es un PATCH parcial que no valida.

### 5.2 El cliente se registra

```
/c/{slug}   (QR del mostrador, o link copiado)
  └─ 404 si la tarjeta está inactiva
  └─ formulario público: Nombre*, Correo*, Teléfono (país + número),
     Fecha de cumpleaños, check de T&C + privacidad
     + los custom_fields que el comercio haya configurado
  └─ POST → crea customer + membership en una transacción
  └─ 302 → /m/{qr_token}
```

Los campos del formulario **se derivan de la config de la tarjeta**. Con `registration: {name:'required', phone:'optional', birthday:'optional'}` aparecen los tres; cambiar a `'none'` los saca. El correo es el único que no se puede desactivar.

### 5.3 El cliente guarda el pase

```
/m/{qr_token}
  └─ "Tu tarjeta está lista"
  └─ "Muestra esto en el mostrador" — preview con TITULAR y sellos reales
  └─ [Agregar a Apple Wallet]   → GET /m/{token}/apple_pass
  └─ [Guardar en Google Wallet] → GET /m/{token}/google_pass
```

`/m/{token}/apple_pass` responde `200` con `content-type: application/vnd.apple.pkpass`. El ZIP firmado se genera en el request, sin job.

`/m/{token}/google_pass` responde con redirección opaca a Google (OAuth de Google Wallet).

### 5.4 El cajero suma un sello

```
/merchants/card_scanner
  ├─ búsqueda por nombre, correo o teléfono → resultados inline
  └─ cámara: "Activar cámara" → lee el QR del pase

/merchants/card_scanner?token={qr_token}
  └─ "CLIENTE IDENTIFICADO" + nombre, correo · teléfono, tarjeta, cumpleaños
  └─ preview del pase del cliente con su estado real
  └─ [Monto de compra (opcional)]  ← moneda del comercio
  └─ [Nota (opcional)]
  └─ [Foto del ticket (opcional)] → "Tomar foto"
  └─ [Registrar visita]
        └─ modal "¿Registrar una visita para X?"
        └─ POST /merchants/card_scans
              {"card_scan":{"qr_token":"...","amount_cents":"","note":""}}
              → 302 de vuelta al scanner
        └─ modal "+1 sello" → [Entendido]
  └─ [Escanear otro]
```

**El QR del pase y el token de la URL son el mismo string.** Por eso `POST /merchants/card_scans` acepta solo `{qr_token, amount_cents, note}`: el token ya identifica la membresía.

Cuando el cajero busca al cliente en vez de escanear, el flujo pasa por `/merchants/card_scanner/customers/:customer_id`: ficha con tarjetas, consumo, visitas, premios, contacto, cumpleaños, fecha de alta, última visita y **notas internas** ("preferencias, seguimiento, lo que sea útil para tu equipo").

### 5.5 El sistema notifica solo

Nada de esto lo dispara el usuario. Vive en la config de la tarjeta y corre por cron.

| Disparador | Condición | Campo de config |
|---|---|---|
| Cumpleaños | `cumpleaños - days_before` | `birthday.{enabled, days_before: 0..90, message}` |
| Win-back | `hoy - last_visit >= days_since` | `win_back.{enabled, days_since: 1..365, message}` |
| Por vencer | `expires_at - days_before` | `expiring.{enabled, days_before, message}` |
| Vencida | `hoy >= expires_at` | `expired.{enabled, message}` |
| Compra / gracias | cada sello o cashback registrado | `purchase.{enabled, stamp_message, cashback_message}` |
| Recompensa lista | el cliente alcanzó el umbral | `reward_ready.{enabled, message}` |
| Geo | el cliente entra al radio de una sucursal | `geolocated`, `geolocated_message` |

### 5.6 El comercio manda un push manual

```
/merchants/broadcasts
  └─ selector de tarjeta (columna izquierda)
  └─ "Se enviará a N clientes con la tarjeta en su Wallet"  ← conteo real
  └─ Tipo: [Inmediata (push)] | [Programada]
  └─ Mensaje (máx 250 caracteres)
  └─ "El título de la notificación será el nombre de tu negocio"
  └─ historial de envíos
```

---

## 6. El wizard de creación

Cinco pasos, navegables por el stepper, con estado en la URL (`?step=type|info|design|details|notifications`).

| Paso | Contenido |
|---|---|
| **1 · Tipo** | Los 5 motores, cada uno con un ejemplo como chip ("10 marcas · café gratis", "5% de cashback en saldo", "2x1 en bebidas", "$500 de saldo recargable", "Club del negocio · nivel Oro") |
| **2 · Información** | Nombre, campos del motor, vigencia, datos de registro, custom fields |
| **3 · Diseño** | Temas, logos, colores, ícono, imágenes de sello |
| **4 · Detalles** | Enlaces y secciones del pase |
| **5 · Notificaciones** | Los 6 gatillos + geo |

### 6.1 Paso de Diseño

- **Temas por giro**: Manglar, Océano, Selva, Medianoche, Arena — desde un popover "Temas de negocio / Por giro".
- **Contraste calculado en vivo**: al elegir el fondo aparece "Buen contraste · 5.3:1 — El texto se lee bien sobre el fondo." Check de accesibilidad WCAG dentro del selector de color, no un error tardío.
- **Tres assets de logo, con instrucciones distintas**:
  - *Logotipo cuadrado* → "Para Google Wallet y la imagen de las notificaciones. Si no lo subes, se usa el color de fondo. JPG, PNG o WebP."
  - *Logotipo horizontal* → "Solo para Apple Wallet (esquina superior izquierda). Lo ajustamos solo al espacio de Apple, así que no necesitas medidas exactas; entre más apaisado, mejor se aprovecha. Si no lo subes, se muestra el nombre de la tarjeta."
  - *Imagen destacada* → "Foto de tu negocio detrás de los sellos, en la tarjeta y en el pase de wallet."
- **Ícono del sello**: presets `★ ◆ ● ♥ ▲ ✦` + selector abierto + subida propia.
- **Imágenes de sello**: `Sello vacío` y `Sello puesto`, con "Opcional. Si subes imágenes, reemplazan al ícono."

### 6.2 Vista previa

Panel derecho fijo, con tabs **Apple / Android**, que se actualiza mientras se edita. En el paso de Detalles rota a la segunda pantalla del pase de Apple, con el ejemplo de `backFields` real ("SELLOS PARA EL PREMIO / 10 · Así se ven los detalles en Apple Wallet (iOS)").

### 6.3 Opciones con copy propio

- **Mostrar la tarjeta completa**: "El cliente ve los 10 sellos desde el principio y recibe cada recompensa al llegar a ella, **sin perder su avance**. La tarjeta vuelve a empezar al canjear la última." (pizza + puntos, no dos productos)
- **Sellos al descargar**: "Cantidad de sellos que recibe el cliente al descargar la tarjeta por primera vez."
- **Límite de 1 sello por día**: "Recomendado para la mayoría de negocios" (default activo)
- **Reiniciar al canjear**: "Empieza un nuevo ciclo tras el premio"
- **Recompensas**: "Crea una o varias recompensas, cada una con sus sellos."
- **Vigencia**: "Elige cuándo caduca la membresía." con tres modos: `Ilimitada` (nunca caduca), `Término fijo` (todas caducan en una fecha), `Plazo fijo tras añadirla` (N días después del alta).

---

## 7. Las notificaciones automáticas en detalle

Configuradas por tarjeta. UI de cada gatillo:

```
[dialog] "Notificaciones automáticas"
         [switch ON]

  Cumpleaños                    "Felicita a tus clientes en su día."
      [switch] [días antes: 7]  "0 = el mismo día del cumpleaños"
      Mensaje (default: "¡Feliz cumpleaños! 🎂🥳 Queremos celebrarte. Pasa por tu sorpresa.")
      VISTA PREVIA ─┐
      ┌─────────────┴──────────────┐
      │ Cafe Lawen                 │
      │ ahora                      │
      │ ¡Feliz cumpleaños! 🎂🥳...    │
      └────────────────────────────┘

  Última visita                 "Invita a volver a quien lleva tiempo sin pasar."
      [switch] [días desde la última visita: 30]
      Mensaje (default: "Ha pasado tiempo... ¡Te extrañamos! Vuelve y sigue juntando recompensas.")

  Tarjeta vencida               "Avisa cuando la tarjeta del cliente caduca."
      [switch]
      Mensaje (default: "¡Ups! Tu tarjeta ha vencido. Renuévala en sucursal para seguir disfrutando sus beneficios.")

  Compra / gracias              "Agradece al cliente cada vez que registras una visita o cashback."
      [switch]
      Mensaje al registrar un sello (default: "¡Sello registrado! Gracias por tu visita.")
      [y un mensaje de cashback aparte]

  Recompensa lista              "Avisa cuando el cliente tiene una recompensa por reclamar."
      [switch]
      Mensaje (default: "¡Tienes una recompensa esperándote! 🥳 Pásala a recoger.")

  Notificaciones geolocalizadas "Envía notificaciones cuando el cliente se encuentre cerca de tu negocio."
      [switch]
      "Aún no tienes sucursales. Agrega una para enviar notificaciones cuando tus clientes estén cerca."
      [Agregar sucursal]
      Mensaje (placeholder: "Ej: ¡Estás cerca! Pasa a visitarnos.")
```

Tres detalles del diseño:

- **La vista previa renderiza el push real**, con el nombre del negocio como título y "ahora" como timestamp. Se edita y se ve, sin publicar.
- **Los mensajes por defecto están escritos.** No son placeholders. Un comercio que activa "Cumpleaños" y no toca nada manda algo que suena a persona.
- **Win-back corre sobre `last_visit_at`**, que existe en la membresía.

---

## 8. El `.pkpass`

Descomprimí el ZIP en memoria. 11 entradas:

```
icon.png  icon@2x.png  icon@3x.png
logo.png  logo@2x.png  logo@3x.png
strip.png strip@2x.png strip@3x.png
pass.json
manifest.json
signature
```

### 8.1 `pass.json` exacto

```json
{
  "formatVersion": 1,
  "passTypeIdentifier": "pass.com.chukitow.chummy",
  "teamIdentifier": "3M3M35BZPF",
  "organizationName": "Cafe Lawen",
  "description": "Tarjeta recargable",
  "serialNumber": "uAJDfWhjqFSJJqXwjq7Hw2wL",
  "webServiceURL": "https://loyalia.app/passkit/",
  "authenticationToken": "2c7138dbd351373342303eec41e35083",
  "logoText": "Tarjeta recargable",
  "foregroundColor": "rgb(255, 255, 255)",
  "backgroundColor": "rgb(47, 93, 107)",
  "labelColor": "rgb(255, 255, 255)",
  "suppressStripShine": true,
  "storeCard": {
    "secondaryFields": [
      { "key": "member", "label": "Titular", "value": "Analista QA Vyloop" }
    ],
    "backFields": [
      { "key": "last_notification", "label": "Mensaje",
        "value": "¡Sello registrado! Gracias por tu visita.", "changeMessage": "%@" },
      { "key": "required", "label": "Sellos para el premio", "value": "7" }
    ]
  },
  "barcode":  { "message": "uAJDfWhjqFSJJqXwjq7Hw2wL", "format": "PKBarcodeFormatQR", "messageEncoding": "iso-8859-1" },
  "barcodes": [ { "message": "uAJDfWhjqFSJJqXwjq7Hw2wL", "format": "PKBarcodeFormatQR", "messageEncoding": "iso-8859-1" } ]
}
```

### 8.2 Qué revela

1. **`webServiceURL` + `authenticationToken`** — el pase se actualiza contra el servidor. Eso permite que el sello suba en la pantalla del cliente sin que vuelva a abrir la app, y habilita el registro de push de Apple.
2. **`barcode.message == serialNumber == qr_token`** — el mismo string identifica pase, membresía y operación de escaneo.
3. **`changeMessage: "%@"` en `backFields.last_notification`** — convención de Apple para "este campo cambió a: %@". El último mensaje automático que se envió queda **escrito en el reverso del pase**.
4. **`storeCard` como template**, no `coupon` ni `eventTicket`. Todo el catálogo se renderiza como store card. `formatVersion: 1`.
5. **`suppressStripShine: true`** — control cosmético fino.
6. **El color del comercio fluye directo**: `backgroundColor: "rgb(47, 93, 107)"` es el `#2f5d6b` elegido en el paso de Diseño. `foregroundColor` es el `text`.
7. **`passTypeIdentifier: pass.com.chukitow.chummy`** con `teamIdentifier: 3M3M35BZPF` — ambos públicos por diseño.

---

## 9. Integraciones

`/merchants/integrations` lista tres, con `planRequired: true` y estado individual.

### 9.1 Loyverse POS (OAuth)

> "Conecta tu punto de venta para que cada ticket cobrado cuente como visita en Loyalia. **El cliente se identifica con el correo que ya usa en su tarjeta.**"

Tres selling points: **Visita automática** ("Se registra al cobrar el ticket"), **Cliente reconocido** ("Por el correo del cliente en el ticket"), **Solo lectura** ("Loyalia nunca modifica tus ventas").

Cada tarjeta mapeada trae `linkId`, `goalStamps`, `rewardLabel`, `members`, más `recentActivity` y `oauthAvailable`.

### 9.2 Campañas de email (créditos prepagados)

| Pack | Créditos | Precio | Por email |
|---|---|---|---|
| `e1000` | 1.000 | US$12,00 | 1,2 ¢ |
| `e5000` | 5.000 | US$44,00 | 0,88 ¢ |
| `e20000` | 20.000 | US$129,00 | 0,645 ¢ |
| `e50000` | 50.000 | US$249,00 | 0,498 ¢ |

Props: `credits: 0`, `lowBalance: true`, `campaigns: []`, `customers: 1`, `timezone`, `settingsPath`, `checkout`, `connection`.

### 9.3 Kiosco de check-in

Check-in self-service en la entrada del local, con alertas de lapse (`due_soon` / `expired`) y log de check-ins en `entries`. El endpoint devuelve error mientras `enabled: false`.

---

## 10. El panel, sección por sección

| Sección | Ruta | Qué hace |
|---|---|---|
| **Dashboard** | `/merchants/dashboard` | 5 KPIs (tarjetas activas, miembros, sellos entregados, saldo en monederos, ingresos del programa), gráfico de nuevos miembros últimos 7 días, miembros recientes, actividad reciente, checklist "Primeros pasos", banner de trial con días restantes |
| **Tarjetas** | `/merchants/cards` | Lista con preview del pase, badge de estado, "Sin vigencia" |
| **Wizard** | `/merchants/cards/:id` | 5 pasos |
| **Detalle de tarjeta** | `/merchants/cards/:id/detail` | Preview Apple/Google, activar/desactivar, copiar link, PDF, 3 stats con delta, clientes, actividad, "Configurar" notificaciones (badge "6 activas"), eliminar |
| **Escáner** | `/merchants/card_scanner` | Buscar o escanear, registrar visita con monto/nota/foto |
| **Clientes** | `/merchants/customers` | Lista paginada (20/pág), contadores `total / with_card / direct`, ficha por cliente con memberships y notas |
| **Analítica** | `/merchants/insights` | **LOCKED en free** |
| **Reportes** | `/merchants/reports` | **LOCKED en free** |
| **Notificaciones** | `/merchants/broadcasts` | Push manual inmediato o programado |
| **Sucursales** | `/merchants/branches` | Alta con Google Places + pin en mapa; habilita geo-notificaciones |
| **Integraciones** | `/merchants/integrations` | Loyverse, email, kiosco |
| **Equipo** | `/merchants/staff` | Código del negocio, link al escáner, descarga de la app, alta de operadores |
| **Facturación** | `/merchants/plan` | Plan actual, barras de uso de los 4 límites, toggle mensual/anual, toggle USD/MXN, 3 tarjetas de plan |
| **Soporte** | `/merchants/support` | Formulario en 5 categorías: technical, cards, billing, account, other. Prellena `userEmail` |
| **Ajustes del canal** | `/merchants/settings` | Nombre de usuario, nombre del negocio, idioma de plataforma, zona horaria, país+moneda, idioma de la tarjeta, contraseña, instrucciones de PWA, exportar movimientos, eliminar cuenta |

### 10.1 Detalles de UI

**Dashboard con datos**: gráfico de barras de "Nuevos miembros · Últimos 7 días" con las iniciales de los miembros en la barra más alta, y "ACTIVIDAD RECIENTE" como feed de eventos con timestamp en la zona horaria del comercio ("6 oct, 10:57 p.m.").

**Pantalla bloqueada**: en vez de un 403, un skeleton de la pantalla real + candado + "Contrata un plan para consultar tu analítica" + "todo se activa en cuanto contratas uno de nuestros planes" + CTA.

**"Ajustes del canal"** es el nombre del menú de configuración. Dentro, "Idioma del registro" con la explicación *"El idioma en el que tus clientes ven el formulario para registrarse a la tarjeta. No cambia el idioma de tu panel."* — separa dos concerns que se confunden.

**"Eliminar tarjeta" se deshabilita si la tarjeta está activa**, con tooltip "Necesitas desactivar la tarjeta primero." Acción destructiva en dos pasos.

**"Eliminar mi cuenta"** con copy explícito: "Elimina tu negocio y todo lo que cuelga de él: tus tarjetas, tus clientes, tus sellos y saldos, el historial de movimientos, tus sucursales y las cuentas de tu equipo. Es permanente y no se puede deshacer."

**Tour de 14 pasos**: modal de 2 minutos, se puede cerrar y reabrir ("Ver recorrido"), con tres salidas — terminar, cerrar por ahora, seguir viendo. Persistido en `showWalkthrough`.

---

## 11. Precios

### 11.1 Panel (USD)

| | Free | Inicial | Pro | Negocio |
|---|---|---|---|---|
| **Mensual** | $0 | $14 | $24 | $39 |
| **Anual (por mes)** | — | $11 | $19 | $29 |
| Programas | 1 | 3 | 8 | 15 |
| Sucursales | 1 | 2 | 8 | 15 |
| Usuarios de equipo | 1 | 3 | 15 | 25 |
| Clientes | 100 | ∞ | ∞ | ∞ |

Features idénticas en los tres pagados: `push`, `geo_notifications`, `advanced_analytics`, `reports`, `customer_deletion`.

`free_limits: {cards:1, branches:1, staff:1, customers:100}`.

### 11.2 Marketing (MXN)

| | Prueba | Inicial | Pro | Negocio |
|---|---|---|---|---|
| **Mensual** | 30 días gratis | $249 | $449 | $699 |
| **Anual (por mes)** | — | $199 | $349 | $549 |

Mismos límites, otro precio, otra moneda. `$14 = $249 MXN` y `$24 = $449 MXN` son la misma serie con redondeo psicológico.

### 11.3 Gating

Tres superficies bloqueadas en free: **Analítica**, **Reportes**, **Integraciones**. Dan el mensaje y el CTA, nunca un error.

### 11.4 Revenue adicional

- **Créditos de email** prepagados.
- **"Ingresos del programa"** como KPI del dashboard — noción de monetización del programa del merchant, además del SaaS. No está desarrollada en la UI de plan free.

---

## 12. Marketing y adquisición

### 12.1 Landing

Headline: **"Tu plataforma de lealtad, completa."**
Sub: "Crea tarjetas digitales, premia cada visita y mira quién vuelve. Tu equipo la opera desde cualquier teléfono, sin instalar nada. 30 días gratis, sin tarjeta."
CTAs: `Crear mi tarjeta gratis` (primario) / `Ver demo` / badges de App Store y Google Play.
Métricas del hero: **+38% clientes que regresan**, **2 min para lanzar**, badge "Tus clientes no instalan apps".

El hero no muestra un dashboard. Muestra un **iPhone con un pase de Apple Wallet** y cuatro tarjetas de wallet flotantes con datos de clientes reales ("TITULAR María González / PREMIO Un café gratis / NIVEL Oro", "SALDO $350.00", "CASHBACK 5%", "VÁLIDO POR 2x1 en pizzas artesanales").

### 12.2 Carrusel por giro

Barra horizontal de pases de marcas reales: **LIX Helados**, **La Barbería PV**, **Metamorfosis Day Spa**, **Pastelería Pavlova**, **L'Angolo di Napoli**, **Auto Spa**, **The Fit Club**. Cada uno con su color, ícono y recompensa.

### 12.3 Geo-notificaciones como sección principal

Fondo oscuro, mapa con radio de 300m, tres pasos:
1. **Detecta cuando están cerca** — "Defines un radio alrededor de tu negocio. Cuando un cliente entra en la zona, recibe una notificación amable en su celular."
2. **El recordatorio justo a tiempo** — "Nada de spam. Solo un aviso oportuno: «te falta 1 sello», «tienes una recompensa lista» o tu promo del día."
3. **Convierte cercanía en visitas** — "El cliente ya estaba cerca; un pequeño empujón lo trae adentro. Mides cuántas visitas genera cada notificación."

### 12.4 Estructura de páginas

| Ruta | Tipo | Estado |
|---|---|---|
| `/` | Landing | ✅ |
| `/tarjetas-de-lealtad-digitales` | Guía SEO | ✅ |
| `/alternativas` | Índice de comparativas | ✅ |
| `/alternativas/{bonusqr,boomerangme,fidelify,loopy-loyalty,luyoa,stampeo,woncards}` | 7 comparativas | ❌ 404 |
| `/programa-de-lealtad-para-{restaurantes,cafeterias,barberias,salones-de-belleza,spas,gimnasios,nutriologos,autolavados,veterinarias,panaderias,heladerias,nails-spa}` | 12 verticales SEO | ✅ enlazadas |
| `/mx/precios` | Precios MXN | ✅ |
| `/support` | Email + WhatsApp | ✅ |
| `/terminos-del-servicio`, `/terminos-de-uso`, `/privacidad` | Legal | ✅ |
| `/merchants/sign_in` | Auth (email + Google Sign-In) | ✅ |
| `/merchants/sign_up`, `/merchants/password/new` | Auth | ✅ |

**12 verticales SEO** con el mismo esqueleto, una por giro. `/alternativas` está preparada para 7 comparativas contra BonusQR, Boomerangme, Fidelify, Loopy Loyalty, Luyoa, Stampeo y Woncards, pero **las páginas aún no existen** — el índice ya las lista y devuelven 404.

Analytics: `useSignupConversions` como módulo separado, con eventos `form_start` / `form_submit` / `page_view` en el pipeline de Google Ads.

### 12.5 FAQ (7 preguntas)

Orden: ¿necesitan app? → ¿necesito hardware? → ¿puedo usar mis colores? → ¿cuánto tarda? → ¿el plan limita clientes? → ¿qué es Loyalia? (definición de marca).

La quinta: **"No. El límite de los planes es de programas de lealtad activos... no de clientes."**

---

## 13. Modelo técnico

### 13.1 Stack

| Capa | Tecnología | Evidencia |
|---|---|---|
| Backend | **Ruby on Rails** | `POST /merchants/sign_in → 302`, `x-request-id`, `x-runtime: 0.871151`, `/merchants/*`, Devise (`/password/new`), `x-csrf-token` + `x-xsrf-token` |
| Frontend | **React + Inertia.js + Vite** | `<script type="application/json" data-page>`, `/vite/assets/*.js`, headers `X-Inertia` / `X-Inertia-Version`, nombres de componente (`Merchants/Cards/Wizard`) |
| Build | Vite con code splitting por ruta | `Index-Ej3XLriA.js`, `New-CVBP2fT8.js`, `cardEngine.js`, `QrCanvas.js` |
| Hosting | **DigitalOcean App Platform** | `x-do-app-origin: b66e1c2c-...`, `x-do-orig-status: 302` |
| CDN/WAF | **Cloudflare** | `server: cloudflare`, `cf-ray: ...-SCL`, `alt-svc: h3`, HSTS `max-age=63072000` |
| Errores | **Sentry** | `sentry-public_key: 42b7c68ea265f6d63bf39b831f81d932`, `sample_rate: 0.1` |
| Analytics | Ahoy, GTM `GTM-MS2TB2DS`, GA4 `G-J4466E68QM`, Google Ads `AW-18275264552` | cookies `ahoy_visitor`, `ahoy_visit` |
| Pagos | **Stripe** | `stripeConfigured: true`, `checkout`, `decline`, `billing` |
| Auth comercio | Devise + **Google Sign-In (GIS)** | iframe `accounts.google.com/gsi/button` |
| Ubicación | **Google Places API** | `placesApiKey` en las props |
| Wallet | Apple PassKit + Google Wallet API | `application/vnd.apple.pkpass` |

### 13.2 Contrato Inertia

Props compartidas en **toda** página:

```jsonc
{ "errors": {}, "oauthPending": false,
  "auth": { "merchantUser": {...}, "merchant": {...}, "trial": {...}, "billing": null },
  "currentUser": { "tier": "standard", "admin": false, ... },
  "admin": null, "impersonation": null, "flash": {},
  "vapidPublicKey": null,
  "telemetry": { ... } }
```

El front nunca necesita un endpoint "me". Cada página añade su propio bloque (`dashboard`, `card`, `customer`, `kiosk`, `pricing`, `plan`...).

Componentes observados:

```
Merchants/Dashboard/Index      Merchants/Cards/Wizard     Merchants/Cards/Detail
Merchants/Cards/Members        Merchants/Customers/Index  Merchants/Customers/Show
Merchants/CardScanner/Index    Merchants/Insights/Index   Merchants/Reports/Index
Merchants/Broadcasts/Index     Merchants/Branches/Index   Merchants/Integrations/Index
Merchants/Integrations/Loyverse        Merchants/Integrations/EmailCampaigns
Merchants/Integrations/CheckInKiosk    Merchants/Staff/Index
Merchants/Plan/Index           Merchants/Support/Index    Merchants/Settings/Index
Cards/Public/Show              CardMembers/Show
```

`CardMembers/Show` es la vista del cliente final. `Cards/Public/Show` es el registro.

### 13.3 Sesión del cliente final

El cliente no tiene cuenta. Su estado vive en una cookie firmada:

```
card_members=eyJfcmFpbHMiOnsibWVzc2FnZSI6IklqRXlNRGt5SWc9PSIsImV4cCI6IjIwNDYtMTAtMDdUMDE6NTU6MzEuNDkzWiIsInB1ciI6ImNvb2tpZS5jYXJkX21lbWJlcnMifX0%3D--0d7b47...
```

Decodificada:

```json
{ "_rails": { "message": "IjeEMkKyIg==", "exp": "2046-10-07T01:55:31.493Z", "pur": "cookie.card_member" } }
```

- `purpose: "cookie.card_member"` — el mensaje está cifrado, no solo firmado.
- `exp` en **2046**.
- El estado real del cliente se resuelve por el token de la URL; la cookie solo evita re-preguntar datos.

### 13.4 Endpoints del cliente

```
GET  /c/{slug}                     → 404 si la tarjeta está inactiva
POST /c/{slug}                     → crea customer + membership, 302 → /m/{token}
GET  /m/{qr_token}                  → CardMembers/Show
GET  /m/{qr_token}/apple_pass       → 200 application/vnd.apple.pkpass
GET  /m/{token}/google_pass         → redirect a Google
GET  /passkit/...                  → web service URL del pase (updates + push)
GET  /kiosk/{32-char-token}        → check-in self-service
```

### 13.5 Módulos del bundle

```
cardEngine.js           → isStamps | isCashback | isClub
cardIcons.js            → flag.card_icons
expiry.js               → lógica de expiración
QrCanvas.js             → render de QR
benditaDemoCard.js      → tarjeta de demo hardcodeada
ChatgptConnectScene.js  → escena de "conectar con ChatGPT"
useSignupConversions.js → instrumentación del funnel de signup
useMoney.js  money.js  banknote.js  coins.js
```

`benditaDemoCard.js`: la página 404 ("Tarjeta no encontrada") renderiza una tarjeta de demo con el nombre del negocio hardcodeado. Los componentes de UI y el contenido de marketing comparten bundle.

---

## 14. Observaciones

Con evidencia.

### 14.1 `placesApiKey` de Google viaja al cliente

Está en las props del wizard:

```jsonc
{ "placesApiKey": "AIzaSyC1DRRdtIOl0tmQhSY_v3dZT8kovD5nv6o" }
```

Cualquier merchant autenticado lo extrae de DevTools. El impacto depende de las restricciones de la key en Google Cloud, que no se pueden verificar desde fuera.

### 14.2 El `passTypeIdentifier` delata al desarrollador

`pass.com.chukitow.chummy` con `teamIdentifier: 3M3M35BZPF`. Ambos públicos por diseño y su relación con la marca "Loyalia" es inmediata.

### 14.3 La geo-notificación no se sostiene con el pase

Tres hechos verificados:

1. `vapidPublicKey: null` en las props de **todas** las páginas del panel.
2. El `pass.json` **no** tiene `locations` ni `relevantDate` — PassKit no puede geofencear.
3. `notifications.geolocated: true` está activo en la card.

Un pase de Apple o Google Wallet **no reporta la ubicación del cliente al servidor**. El único camino es la app nativa del cliente. No se pudo confirmar desde el panel.

### 14.4 El tipo de tarjeta no persistía al guardar

Al crear la tarjeta 2167: elegí "Monedero / Cashback" → `Guardar` → el servidor devolvió `card_type: "cashback"`. Luego elegí "Cupón" → la UI cambió a "Beneficio del cupón / Usos por cliente" → `Guardar` → el servidor **seguía devolviendo `card_type: "cashback"`**, con los campos de cupón sin persistir.

Los campos de cashback sí se guardaron. Lo que no se commitea es el **cambio de motor** en un borrador existente.

### 14.5 El token del cliente es bearer

`/m/{qr_token}` no requiere sesión, cookie ni ningún secreto. Expone nombre, sellos, saldo y recompensas pendientes. El mismo token va impreso en el QR de la mesa, en el Apple Pass y en el Google Pass — tres superficies físicas imposibles de rotar. `authenticationToken` del pass es un MD5 (32 hex), criptográficamente débil como secreto.

No hay rotación ni revocación desde el merchant. Una tarjeta desactivada deja de aceptar registros nuevos, pero los pases emitidos siguen funcionando.

### 14.6 Superficie de superadmin

`admin` e `impersonation` en las props de todas las páginas, con `currentUser.tier` creando una superficie de administración global con impersonación de comercio.

### 14.7 El `.pkpass` se genera en el request

Firma PKCS#7 + manifiesto por request, sin caché observable. Funciona a escala de PyME.

---

## 15. Análisis competitivo

> Esta sección es la única que compara. Todo lo anterior es descripción de Loyalia; esto es lectura contra el estado real de Vyloop (`packages/db/src/schema.ts`, 24 tablas, 9 workers, 3 apps, 7 packages).

### 15.1 La brecha estructural: 1 programa vs. N programas

No es una feature, es una decisión de schema. Es el gap #1.

**Vyloop:**
```ts
export const loyaltyPrograms = pgTable('loyalty_programs', {
  businessId: uuid('business_id').notNull().unique()   // ← UNIQUE: un programa por tenant
    .references(() => tenants.id, ...),
  pointsCurrency: text().default('puntos'),
  earnRate: numeric(10, 4).default('1.0'),
  minRedeemPoints: integer().default(100),
  pointsExpiryDays: integer(),
  promoCopy: text(),
  isActive: boolean().default(true),
})
```

**Loyalia:** un comercio tiene N tarjetas, cada una con motor, diseño, config, QR, estadísticas y notificaciones propias.

| Capacidad de Loyalia | Viabilidad en Vyloop | Nota |
|---|---|---|
| Múltiples programas por comercio | **No** | `businessId` es `UNIQUE`. Requiere quitar el unique y agregar `type`/`engine` |
| Sellos/visitas como mecánica | **No** | El modelo es 100% puntos (`earnRate`, `pointsCost`). No hay contador de sellos |
| Cupón / recarga / membresía | **No** | No hay `balance_cents` en la membresía, ni `coupon_remaining` |
| Recompensas escalonadas por umbral | **Parcial** | `rewards.autoGrantThreshold` existe, pero en puntos |
| N notificaciones por programa | **No** | No hay config por programa; `workflows` es genérico |
| Escáner por token | **No** | No hay `qr_token` por membresía |
| Membresía con expiración | **Parcial** | `pointsExpiryDays` expira puntos, no la membresía |

Todo lo demás (diseño, wizard, escáner) es UI sobre el modelado. Si el schema no soporta N programas con mecánicas distintas, el producto no existe.

### 15.2 Copiar tal cual

| Idea | Por qué funciona | Esfuerzo en Vyloop |
|---|---|---|
| **Vista previa Apple/Google en vivo en el wizard** | Elimina la mitad de los tickets de soporte sin escribir docs | Medio — ya hay `design-system` y el pase de Google; falta el mock de Apple |
| **`webServiceURL` en el pase de Apple** | Convierte un pase estático en una tarjeta viva | **Vyloop no tiene Apple Wallet.** Ver §15.5 |
| **`barcode.message == serialNumber == token`** | Un identificador para pase, membresía y escaneo | Bajo, si se diseña el schema desde ahora |
| **`changeMessage: "%@"` en el reverse del pase** | El último push queda escrito en el pase | Bajo (solo Apple) |
| **Sellos de bienvenida** | La palanca de adquisición | Bajo |
| **Límite diario por default** | Defensa anti-fraude de mostrador | Bajo |
| **Tres modos de vigencia** | "Membresía anual" sin republicar el programa | Bajo |
| **Mensajes por defecto escritos** | Decide la tasa de apertura | Muy bajo, alto retorno |
| **Vista previa del push al editar** | Editar y ver sin publicar | Muy bajo |
| **Canje sin perder el avance** | "Pizza + puntos" resuelto, no dos productos | Bajo |
| **Códigos de comercio para operadores** | El onboarding de cajeros decide cuántos negocios usan el producto | Bajo |
| **Créditos de email prepagados** | Revenue transaccional de margen alto | Medio (Stripe ya está) |
| **Carrusel de pases de negocios reales** | El disparador de alta más barato que existe | Muy bajo |

### 15.3 Copiar la idea, mejorar la ejecución

| Tema | Loyalia | Cómo lo haría Vyloop |
|---|---|---|
| **Config como JSON blob** | `config: {...}` con 20 campos, un motor activo, el resto inertes y acumulados | Vyloop es event-driven con schema-first. Un JSON blob es lo contrario a la filosofía de `packages/schema-registry`. **Columnas tipadas + `program_mechanics` por motor.** Más trabajo ahora, migraciones más baratas después |
| **Niveles / tiers** | `flag.loyalty_levels: false` — en el modelo, no lanzado | Vyloop **ya tiene** `membershipTiers` y `crossLoyaltyAlliances`. Cantera, no gap |
| **Cron de notificaciones** | 7 `if` en un cron de Rails | Vyloop ya tiene `workflows` + `workflowExecutions` + `customerEvents` + `messageLog`. Los gatillos de Loyalia son exactamente un workflow. **No copiar los `if`** |
| **Localización** | `cardLocale` por comercio, 2 idiomas | Vyloop tiene `localizationConfigs` y la regla "nunca un fork por país". Loyalia tiene 20 monedas y 24 países hardcodeados |
| **Sobrevuelo de credenciales** | Sin hints de nil-safety en la UI | Vyloop tiene el contrato de "`DATABASE_URL` no es una variable: son tres". Mantener esa cultura |
| **Analítica / Reportes gated** | Locked screen con skeleton + CTA | Copiar el patrón. Es correcto |
| **SEO vertical vs. comparativas** | 12 verticales vivas, 7 comparativas en 404 | Las verticales ganan por volumen sin riesgo legal. Las comparativas contra nombrados son riesgo legal y reputacional |

### 15.4 Lo que no copiar

| No copiar | Por qué |
|---|---|
| **Token bearer como única identidad del cliente** | 22 chars en un QR impreso, en un pass físico y en una URL, sin rotación ni revocación. Vyloop ya tiene `customers` + `identity` + RLS |
| **Cookie del cliente con `exp` en 2046** | Sin logout, sin revocación |
| **`placesApiKey` en el cliente** | Vyloop ya tiene la regla de secrets explícita. La key va por backend |
| **Landing pages contra competidores nombrados** | 7 marcas nombradas con "la alternativa a X donde tu cliente solo escanea". Retorno dudoso |
| **Impersonación de comercio** | `impersonation` en todas las props. Target de alto valor, cero aporte al producto |
| **Ventana de cambio de motor sin commit** | Ver §14.4 |
| **Cifras no verificables** | La landing dice "+1.000 negocios con su tarjeta activa" y en otro lado "Ya funciona en negocios reales, todos los días." Con trial de 30 días y free de 1 programa |

### 15.5 La decisión grande: Apple Wallet

Vyloop tiene Google Wallet con la clase aprobada, y hay un **contract test explícito** que verifica que no exista Apple Wallet:

```
apps/customer-web/app/delivery.contract.test.ts
  "The Stage 7 checklist asks for confirmation that there is no Apple Wallet or"
```

Mientras tanto, Loyalia define su posicionamiento entero sobre "Apple y Google Wallet nativo". Y el `.pkpass` que se desarmó en §8 muestra que la parte difícil ya está resuelta y es razonable:

- Firma PKCS#7 del `pass.json` con la clave del team.
- Generación de `icon`/`logo`/`strip` a `@1x/@2x/@3x` desde los colores y logos del comercio.
- `webServiceURL` + `authenticationToken` para updates y push.
- El barcode es el mismo token del cliente.

El costo de entrada es la revisión del pass type (días) y una cuenta de Apple Developer ($99/año). El costo de seguir sin él es quedarse fuera del wallet que usa la mayoría del mercado Latinoamericano en iPhone.

Es una decisión de producto y negocio, no de ingeniería.

---

## 16. Por hacer — cosas que Loyalia tiene y Vyloop no

> Todas las referencias a "tenemos" están verificadas contra el código, no contra los docs. Varios docs están desactualizados respecto del schema real (ver §16.5).

### 16.1 Bloqueantes estructurales — sin esto el producto no existe

| # | Prioridad | Qué tiene Loyalia | Qué tenemos (verificado) | El gap |
|---|---|---|---|---|
| 1 | **P0** | N tarjetas por comercio, cada una con motor, config, QR y estadísticas propias | `loyalty_programs.businessId` es `UNIQUE` → **1 programa por tenant** (`packages/db/src/schema.ts:226`). `tenantWalletPrograms.tenantId` es PK → "exactamente una clase por tenant" (`docs/09-Database-Design.md:323`) | El eje del modelo de negocio de Loyalia es *N programas, clientes ilimitados*. Nuestro pricing y nuestro schema dicen lo contrario |
| 2 | **P0** | Mecánica de sellos: contador por membresía, recompensas escalonadas con umbral de sellos, reinicio al canjear, límite diario | **Cero.** `grep -i stamp packages/db/src/schema.ts` → 0 resultados. El motor es 100% puntos (`earnRate`, `pointsCost`). La palabra "sello" aparece una sola vez en los 8 docs fundacionales, y solo como crítica al problema | Es el tipo de tarjeta #1 de Loyalia y el más usado por negocios locales. Hoy no es construible |
| 3 | **P0** | Escáner: buscar por nombre o escanear el QR del pase, `POST /merchants/card_scans {qr_token, amount_cents, note}` con confirmación y toast | `workers/growth/src/routes.ts` expone: `loyalty/config` GET/PUT, `loyalty/tiers` CRUD, `loyalty/points/assign`, `loyalty/points/transactions`, `loyalty/rewards` CRUD, `loyalty/rewards/redeem`. **Ningún endpoint de check-in, escaneo, member code ni operador.** `grep -ri "check_in\|scanner"` → 0 resultados reales (los matches son `.scan()` de Postgres) | El verbo diario del negocio no existe. Hoy solo hay `POST /v1/loyalty/points/assign`. El "sellador" está diseñado en `docs/10:232-244` pero no implementado |
| 4 | **P0** | Membresía como entidad: une cliente + tarjeta, con `stamps`, `goal`, `balance_cents`, `coupon_limit/redeemed`, `expires_at`, `expiration_status`, `reward_ready`, `last_visit_at` | **No existe tabla de membresía.** Lo más cercano: `customers.currentTierId` (schema.ts:128) — un solo nivel por cliente, no una instancia por tarjeta. `customerWalletPasses` (schema.ts) es estado de pase, no saldo acumulado | Sin membresía no hay balance, ni cupón, ni expiración por cliente, ni `reward_ready`. El saldo se deriva de `pointsTransactions.balanceAfter` |
| 5 | **P0** | Sucursales con Google Places → lat/lng, para geo-notificaciones con radio | `branches` = `id, businessId, name, address, city, country, timezone, isActive` (`schema.ts:80-90`). **Sin lat/lng, sin radio, sin geocerca** | `docs/10:286,445` habla de "restricción por sucursal" y "radio de notificaciones cercanas" sin ningún campo que lo soporte. La función más diferenciadora del competidor es imposible |

### 16.2 Gaps de producto claros

| # | Qué tiene Loyalia | Qué tenemos | El gap |
|---|---|---|---|
| 6 | **Apple Wallet** funcionando, con `webServiceURL` para actualizar el pase y `changeMessage: "%@"` en el reverso | Solo Google Wallet. Y hay un **contract test que prohíbe explícitamente** Apple Wallet: `apps/customer-web/app/delivery.contract.test.ts:6` — "The Stage 7 checklist asks for confirmation that there is no Apple Wallet or" | La wallet más usada en iPhone en LatAm. Ver §15.5 |
| 7 | El merchant **ve y gestiona las tarjetas de sus clientes**: `/merchants/customers` con contadores `total/with_card/direct`, ficha con memberships, y `/merchants/cards/:id/members` + feed de actividad por tarjeta | El backlog ya lo marca: *"El merchant no puede ver ni gestionar las tarjetas de sus clientes."* (`docs/14-Backlog.md:248`) | Sin esto el comercio tiene un panel de clientes sin relación con sus programas. Es el circuito principal de Loyalia |
| 8 | El botón "Agregar a Apple Wallet / Guardar en Google Wallet" **inmediatamente después del registro**, con el pase real renderizado | **Resuelto.** `apps/customer-web/app/components/wallet-card.tsx` pide `GET /v1/wallet/pass` en mount, con `lib/wallet.ts` mapeando cada rechazo a su propio mensaje. `docs/14:163-168` quedó viejo | Ninguno. Anotado en §16.5 |
| 9 | El correo del cliente es **obligatorio** y es la llave del sync con POS ("El cliente se identifica con el correo que ya usa en su tarjeta") | El registro no lo pide. **Los 12 clientes en producción tienen `email = NULL`** (`docs/14:147-159`) | El día que el login pase a OTP no hay canal de recuperación. Y bloquea la integración con POS, que es la pieza de mayor valor de Loyalia |
| 10 | `member_code` se genera en el alta | Se genera **al pedir el pase**; solo 4 de 12 clientes lo tienen (`docs/14:170-176`) | El código es el identificador que el escáner necesita (#3). Sin él en el alta, no hay nada que escanear |
| 11 | `/c/{slug}` es el **QR del mostrador**: puerta de entrada pública, con 404 explícito si la tarjeta está inactiva | `/p/{slug}` responde 200 con el nombre del comercio pero **no tiene un solo link** (`docs/14:180-188`) | La página pública existe y no tiene puerta. Nadie llega |
| 12 | 7 automatizaciones configurables **por tarjeta**, con mensaje default escrito y vista previa del push | `workers/automation/src/routes.ts` expone **solo `/health`**. Es un placeholder. Los workflows de cumpleaños e inactividad están en el backlog Fase 3 (`docs/14:114-117`) | El motor de retención es la promesa del marketing y no existe. Ya tenemos la tabla `workflows` + `workflow_executions`: es query sobre tablas que ya existen, no greenfield |
| 13 | Wizard de 5 pasos con **vista previa Apple/Google en vivo** y check de contraste WCAG calculado en vivo | El dashboard tiene vista de configuración del programa (`docs/14:86`) pero no hay wizard de alta ni preview del pase | Elimina la mitad de los tickets de soporte sin escribir docs. Ya tenemos `packages/design-system` |
| 14 | Récord de actividad **por tarjeta** con `kind`, `amount_cents`, `purchase_amount_cents`, `member_name`, `at` — y ticket promedio | `pointsTransactions` es un ledger global del tenant: `type, points, balanceAfter, referenceId, note, branchId`. `GET /v1/loyalty/points/transactions` no está filtrado por programa | No hay forma de responder "¿cuánto consumió este cliente en esta tarjeta?". El `purchase_amount_cents` separado es lo que permite ticket promedio |
| 15 | Kiosco de check-in con alertas de lapse (`active`/`due_soon`/`expired`) y log | No existe | Resuelve el cliente que no vuelve al mostrador. Medio plazo |
| 16 | OnboardingChecklist "0 DE 2", countdown de trial en banner permanente, tour de 14 pasos re-abrible, "Primeros pasos" en el dashboard | El onboarding guiado está en **Fase 4** del backlog (`docs/14:130`). Hay trial de 30 días en el README pero sin conversión en UI | Con trial de 30 días, el checklist es lo que convierte trial en pago. Es UI pura sobre lo que ya existe |
| 17 | Gates de plan por límites de recursos con barras de uso ("1 de 1", "0 de 100") | Hay planes Free/Pro/Business/Enterprise en `docs/03` y tablas de consumo, sin enforcement en UI | El gating es el producto: Analítica y Reportes bloqueados con CTA |
| 18 | Créditos de email prepagados, precio decreciente por volumen (US$12 → US$249) | WhatsApp e IA ya están planteados como add-ons por consumo (`docs/03:32-38`) | El modelo de add-ons ya existe; falta el producto comprable con Stripe |
| 19 | 12 verticales SEO por giro, cada una un funnel | `docs/02` tiene SEO/contenido como canal pero no hay páginas | Adquisición de bajo costo, sin riesgo legal |

### 16.3 Lo que ya tenemos y ellos no tienen

Para no duplicar trabajo, esto ya está resuelto de nuestro lado:

| Capacidad | Vyloop | Loyalia |
|---|---|---|
| Aislamiento multi-tenant | `business_id` + RLS definido con tests (`packages/db/src/rls.ts`) | Sin nada: aislamiento por filtro de aplicación |
| Event sourcing | `customer_events` inmutable + proyección | Sin eventos: estado en columnas mutables |
| Schema Registry | KV, valida antes del bus | Sin contrato de eventos |
| API pública + webhooks | REST + GraphQL, 7 webhooks con HMAC-SHA256 y reintentos | Sin API pública |
| Idempotencia | Regla explícita de desarrollo + `referenceId` en el ledger | No |
| SDK publicado | Node.js | No |
| Analytics cross-tenant | ClickHouse + `benchmarks` | Solo del propio comercio |
| Consentimiento | Tabla `consents` con tipo, fechas, IP y revocación | No hay consentimiento registrado |
| Niveles/tiers | `membershipTiers` con multiplicador y beneficios, CRUD completo | En el modelo pero `flag.loyalty_levels: false`, sin lanzar |
| Recompensas | `rewards` + `rewardGrants` con umbral de auto-otorgamiento e idempotencia | `config.rewards[]` dentro de un JSON blob |
| Desactivación por inactividad | `workers/wallet/src/inactivity.ts` con análisis de ventana y estados reversibles | Sin equivalente |

**Nota sobre la doc**: `docs/09-Database-Design.md` dice que no hay tabla de recompensas. **Sí existe** (`rewards` y `reward_grants`, `schema.ts:408,436`). El doc está desactualizado respecto del código.

### 16.4 Orden de ataque sugerido

```
P0  schema      #1 N programas      → migración de loyalty_programs
P0  schema      #4 membresía        → tabla nueva, PK (customer, program)
P0  schema      #2 sellos           → stampCounter en la membresía o tabla de hitos
P0  feature     #3 escáner          → POST /v1/checkins, una fila, un evento
P0  feature     #10 member_code     → generar en el alta, no al pedir el pase
P0  feature     #8 botón wallet     → una línea en el post-registro
P1  feature     #11 puerta pública  → un link en /p/{slug}
P1  feature     #9 email obligatorio → desbloquea OTP y POS
P1  feature     #7 panel merchant   → clientes por programa + actividad
P1  schema      #5 lat/lng          → habilita geo
P1  feature     #12 automatizaciones→ queries sobre workflows, ya está la tabla
P2  producto    #6 Apple Wallet     → decisión de negocio, no de ingeniería
P2  producto    #13 wizard + preview
P2  producto    #16 onboarding      → UI pura, alto retorno con trial
```

El orden importa. `#3` sin `#10` no tiene token que escanear; `#3` sin `#4` no tiene dónde escribir el sello; `#7` sin `#1` muestra siempre el mismo programa.

### 16.5 Contradicciones internas que hay que arreglar primero

Estas no vienen de Loyalia, pero bloquean el trabajo:

1. **`loyaltyPrograms` es 1:1** con el negocio, pero `docs/03-Business-Model.md` vende el plan Business con "hasta 5 sucursales" y `docs/04-Product-Requirements.md:113` pone "dashboard multi-sucursal consolidado" fuera del PMV. Se vende algo que el scope no construye.
2. **Ningún dominio publica `PurchaseCompleted`**. Los docs lo consumen (growth, mapa de comunicación) pero "no somos POS" (docs/01:56) implica que nadie lo emite. Es el evento raíz del sistema y no tiene dueño.
3. **`branches` sin coordenadas** vs. `docs/10` hablando de radio de notificaciones.
4. **`docs/09` sin tabla `rewards`** vs. el código que sí la tiene.
5. **RLS declarado en `docs/07` pero no desplegado**: `createRlsPolicies()` solo se referencia en tests (`packages/db/src/rls.ts:91`), y `packages/db/src/migration-sql.test.ts:215` **falla si la migración contiene `ENABLE ROW LEVEL SECURITY`**. El aislamiento real hoy son filtros explícitos de `businessId` en los handlers.
6. **Ningún job de CI aplica migraciones**; se aplican a mano (`docs/17:45-46`).
7. **El build no es un gate**: un flag de compatibility inventado pasó lint, typecheck y tests enteros, y el deploy lo rechazó (`TASKS.md:181-187`).

---

## 17. Apéndice: evidencia cruda

### 17.1 Rutas del panel

```
/merchants/dashboard
/merchants/cards
/merchants/cards/new              → 302 a /merchants/cards/:id (crea el borrador)
/merchants/cards/:id               ?step=type|info|design|details|notifications
/merchants/cards/:id/detail
/merchants/cards/:id/members
/merchants/cards/:id/notifications
/merchants/card_scanner
/merchants/card_scanner?token={qr_token}
/merchants/card_scanner?q={busqueda}
/merchants/card_scanner/customers/:customer_id
/merchants/customers               ?q=
/merchants/customers/:id
/merchants/insights                → locked en free
/merchants/reports                 → locked en free
/merchants/broadcasts
/merchants/branches , /merchants/branches/new
/merchants/integrations            → loyverse | email | check_in_kiosk
/merchants/staff
/merchants/plan
/merchants/support
/merchants/settings
```

### 17.2 Rutas públicas

```
/                              landing
/c/{slug}                      registro del cliente (404 si la tarjeta está inactiva)
/m/{qr_token}                  vista del cliente
/m/{qr_token}/apple_pass       → application/vnd.apple.pkpass
/m/{qr_token}/google_pass      → redirect Google
/kiosk/{32-char-token}         check-in self-service
/passkit/                      web service URL del pase de Apple
/tarjetas-de-lealtad-digitales
/alternativas  +  /alternativas/{competidor} (404)
/programa-de-lealtad-para-{12 giros}
/mx/precios  /support  /terminos-del-servicio  /terminos-de-uso  /privacidad
/merchants/sign_in  /merchants/sign_up  /merchants/password/new
```

### 17.3 Artefactos de la sesión de prueba

| Artefacto | Valor |
|---|---|
| Merchant | `Cafe Lawen`, id `2197`, slug `cafe-lawen`, plan `free`, CLP, `America/Santiago` |
| Merchant user | id `1960`, `owner` |
| Merchant code | `58BG-4P` |
| Tarjeta | id `2166`, slug `Sryu4tsw`, motor `stamps`, meta 7 sellos, activa |
| Tarjeta (borrador) | id `2167`, motor `cashback`, `percent: 5` |
| Cliente | id `11917`, `Analista QA Vyloop`, `qa.vyloop.test@example.com`, `+56912345678`, `1990-06-15` |
| Membresía | id `12092`, 2 sellos / 7, saldo 0 |
| `qr_token` | `uAJDfWhjqFSJJqXwjq7Hw2wL` |
| Ticket verificado | `POST /merchants/card_scans` → `+1 sello` |
| Bytes capturados | payload del request de escaneo, `pass.json` completo, manifiesto del `.pkpass` |
| Contrato Inertia | `X-Inertia-Version: 82943cb2a045b1e4acaff941ee4c1063841a8771` |

### 17.4 Datos de prueba creados

Cliente `Analista QA Vyloop` (id 11917) con 2 sellos, y dos tarjetas draft (2166 activa, 2167 sin usar). Se pueden borrar desde el panel: desactivar 2166 y luego "Eliminar tarjeta".