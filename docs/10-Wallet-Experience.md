# 10-Wallet-Experience.md
**[DOCUMENTO]:** Experiencia de Billetera Móvil | **[VERSIÓN]:** v1.0 | **[ESTADO]:** Draft | **[RESPONSABLE]:** Producto y Arquitectura Principal

---

## 1. Decisión

Construir una experiencia de fidelización sin instalación de aplicaciones, respaldada por un registro autoritativo (ledger) de Vyloop y orientada inicialmente a cafés y panaderías. Google Wallet será el primer proveedor porque ofrece la ruta más corta y convincente hacia un pase de fidelidad vendible; Apple Wallet llegará después mediante el mismo adaptador neutral respecto del proveedor.

El cliente comienza desde una página web de inscripción controlada por el comercio, recibe un sello o saldo de bienvenida real y puede agregar un pase sin instalar una aplicación de Vyloop.

La billetera móvil es una superficie de presentación, no la fuente de verdad. Las reglas del comercio, la membresía, los cambios de sellos o puntos, las recompensas, los registros de consentimiento y el estado de canje permanecen bajo la autoridad de Vyloop.

El prototipo visual local es [`.superpowers/brainstorm/54260-1790304161/content/wallet-experience-v1.html`](../.superpowers/brainstorm/54260-1790304161/content/wallet-experience-v1.html). Es una referencia visual local de la dirección `club-barrio`, no código de producción ni una captura nativa.

## 2. Ruta rápida

1. El cliente escanea el QR de inscripción del comercio o abre una URL de inscripción específica del comercio.
2. El cliente ingresa nombre y teléfono, y recibe un sello de bienvenida real y claramente declarado, o un crédito equivalente en el registro.
3. El cliente decide por separado si desea recibir mensajes de servicio por WhatsApp, promociones y notificaciones cercanas. Todas las opciones son voluntarias y comienzan desactivadas.
4. El servidor crea o recupera al cliente y la proyección de billetera, registra evidencia de consentimiento y selecciona el proveedor compatible con el dispositivo.
5. El cliente agrega un pase de Google Wallet. Las visitas posteriores actualizan el registro interno y sincronizan el pase del proveedor.
6. El comercio sella una compra, escanea o confirma el identificador del miembro y el pase se actualiza o revoca según el estado del ciclo de vida.

**Límite del MVP:** demostrar inscripción, ciclo de vida del pase, actualizaciones autoritativas y una operación repetible para cafés y panaderías antes de agregar funciones avanzadas de contexto.

## 3. Razones de la dirección

| Decisión | Motivo |
|---|---|
| Cafés y panaderías primero | Las visitas frecuentes, una promesa simple para el cliente y una razón visible para volver hacen que la fidelización sea fácil de demostrar y operar. |
| Google Wallet primero | Validar el ciclo de vida del pase con la menor fricción y alcance en Android antes de agregar el segundo proveedor. |
| Apple Wallet después | Mantener paridad mediante un adaptador, sin duplicar las reglas de negocio. |
| Inscripción web primero | Evitar la dependencia de una aplicación nativa y la ruta obsoleta de Android Instant App. |
| Progreso con meta inicial revelada | El cliente ve un primer paso real y claramente declarado. Una barra de progreso sin una recompensa respaldada es decorativa. |
| Consentimiento explícito | Las elecciones de notificaciones, marketing y ubicación son separadas, opcionales, auditables y revocables. |

## 4. Recorrido del cliente

### 4.1. Descubrimiento

El comercio coloca un código QR o una URL asociada a un código QR en el mostrador. La URL identifica el negocio, la sucursal, la campaña de inscripción y un contexto de inscripción no secreto. No contiene una credencial reutilizable.

La página utiliza una comunicación neutral en español y muestra qué recibe el cliente; por ejemplo, **1 sello de bienvenida** y la regla exacta de la próxima recompensa. No debe insinuar que una recompensa está disponible si el comercio no la ha configurado y financiado.

### 4.2. Inscripción en aproximadamente 10 segundos

La ruta por defecto solicita únicamente:

- Nombre.
- Número de teléfono almacenado en formato E.164 normalizado, con el contexto del país.

El flujo no debe preseleccionar el consentimiento de notificaciones, marketing o ubicación. Después de crear la cuenta principal, el cliente puede aceptar por separado:

- Mensajes de servicio por WhatsApp relacionados con la cuenta y las recompensas.
- Mensajes promocionales.
- Notificaciones cercanas o por geocercas.

Cada aceptación registra propósito, canal, jurisdicción, versión de la política, fecha y hora, origen y evidencia. La revocación debe detener los envíos futuros para ese propósito sin eliminar la cuenta de fidelización ni el historial del registro.

### 4.3. Agregar el pase

El servidor determina las capacidades del dispositivo y del navegador, y luego muestra únicamente la acción del proveedor compatible. La interfaz puede mostrar las etiquetas conceptuales **Add to Google Wallet** y **Add to Apple Wallet** para revisión de diseño, pero en producción debe mostrar una sola ruta compatible a la vez. La acción oficial y el comportamiento del SDK y del proveedor determinan la interacción final.

El pase de billetera móvil se crea a partir de campos estructurados. Los códigos QR y de barras nunca se incrustan en el arte del pase.

### 4.4. Regreso y acumulación

El comercio registra en Vyloop la visita o compra que cumple la condición. El registro interno evalúa las reglas del comercio, agrega el sello o los puntos correctamente declarados, actualiza la proyección de nivel o recompensa y emite un evento de dominio para sincronizar el proveedor.

El cliente puede ver:

- Un pase actualizado con un nuevo saldo o cantidad de sellos estructurada.
- Un mensaje de servicio si aceptó ese canal.
- Una notificación cercana solo si la aceptó y las restricciones del proveedor lo permiten.

La sincronización del pase no promete una visualización instantánea en la pantalla de bloqueo.

### 4.5. Canje y salida

El canje se valida contra el registro autoritativo y la autorización del comercio. El pase del proveedor puede actualizarse, marcarse como utilizado o revocarse según el ciclo de vida de la recompensa y la membresía. Un código de barras es un artefacto de interacción para el comercio, no una prueba general de identidad.

### 4.6. Revocación del consentimiento

El cliente puede revocar el consentimiento de comunicaciones y notificaciones cercanas desde la cuenta web o una superficie de soporte autenticada. El registro permanece disponible para fines de servicio y contabilidad legítimos, sujeto a la política de retención del comercio y de la jurisdicción.

## 5. Experiencia del pase

### 5.1. Apple Wallet / `storeCard`

El concepto de Apple toma como referencia un cuaderno de sellos de barrio: tono leche, tinta de espresso, cereza oxidada y tinta de sello de latón. La fila incompleta permanece como la firma visual del producto a lo largo de la inscripción, el pase y la confirmación de la próxima recompensa.

El pase debe hacer legibles estos hechos:

- Comercio e identificador del miembro.
- Progreso actual de sellos o puntos, como **8/10**.
- Próxima recompensa y su regla claramente declarada.
- Condiciones de vencimiento o validez.
- Un código legible por máquina con alto contraste y una alternativa legible por personas.

El prototipo visual muestra 8 sellos completos y 2 sellos vacíos con bordes punteados. La implementación de producción debe derivar tanto los campos estructurados de progreso como el texto alternativo desde la misma proyección del registro.

**Correcciones actuales del diseño de Apple:**

| Activo o campo | Orientación actual |
|---|---|
| `storeCard` icon | Cuadrado de 38 × 38 pt. |
| Logo | De 50–160 pt de ancho por 50 pt de alto. |
| Strip | 375 × 144 pt; los PNG proporcionados son 750 × 288 px a @2x y 1125 × 432 px a @3x. |
| Contenido crítico | No depender del arte de logo o strip para mostrar saldo, nivel, canje o información alternativa. |
| Ubicación | Apple admite ubicaciones geográficas configuradas e identificadores iBeacon opcionales. Un iBeacon no es necesario para la relevancia por coordenadas habitual. |

Las dimensiones de strip proporcionadas por el usuario, 624 × 246 y 1032 × 336, no son las dimensiones actuales del strip `storeCard` de Apple. No deben utilizarse como requisitos de producción.

### 5.2. Pase de fidelidad de Google Wallet

Google Wallet es el primer objetivo de proveedor. El prototipo visual utiliza un programa Bistro contrastante con verde esmeralda, menta y negro, un logo circular, una fotografía real para el encabezado y una jerarquía de fidelidad clara.

El pase debe hacer legibles estos hechos:

- Saldo actual, como **$18.50**.
- Tasa de reembolso, como **5%**.
- Nivel actual, como **GOLD**.
- Progreso hacia el siguiente nivel, como **63% a PLATINUM**.
- Una acción de código de barras para la interacción con el comercio.

**Correcciones actuales de los activos de Google:**

| Activo | Orientación actual |
|---|---|
| Logo | PNG cuadrado mínimo de 660 × 660 px con un margen del 15%. |
| Imagen de encabezado | 1032 × 812 px, aproximadamente 5:4, según la recomendación actual. |
| Contenido crítico | Los campos estructurados del pase son autoritativos; el arte no es un registro. |
| Actualizaciones | La sincronización de Google Wallet es posterior desde la perspectiva de Vyloop; no se garantiza una visualización instantánea. |

La imagen de encabezado de 1032 × 336 proporcionada por el usuario no es la proporción recomendada actualmente para el encabezado de Google. Una franja corta puede ser útil en otro contexto, pero no debe presentarse como el requisito actual del activo principal de Google.

## 6. Códigos de barras, códigos QR e identidad

Ambos proveedores renderizan códigos de barras y códigos QR desde campos estructurados. Vyloop no debe incrustar un código QR o de barras en el arte del pase.

Requisitos de implementación:

1. Generar el valor desde un identificador estable de miembro o canje con el alcance seguro más pequeño posible.
2. Preservar una zona silenciosa de cuatro módulos para el código QR y validar el tamaño final y el contraste.
3. Incluir una alternativa legible por personas para atención al cliente y recuperación ante errores.
4. No tratar el código de barras de la billetera como prueba de identidad de la cuenta ni como un inicio de sesión web general.
5. No inventar un tamaño físico universal mínimo de 2 × 2 cm; validar según la carga útil, la corrección de errores, la pantalla y el contexto del escáner.

No existe un tamaño físico universal mínimo para un código QR. El límite seguro está en el modelo de autorización y canje, no únicamente en las dimensiones de la imagen.

## 7. Registro interno autoritativo

Vyloop tiene actualmente un dominio de fidelización orientado a un registro de puntos y no cuenta con una tabla de billetera dedicada. Growth posee las reglas de fidelización. La experiencia de billetera móvil no debe convertirse en una segunda fuente de verdad que entre en conflicto con el registro existente.

El MVP debe introducir una proyección de billetera, no un motor de saldo paralelo:

| Responsabilidad | Fuente autoritativa | Comportamiento de la billetera |
|---|---|---|
| Negocio, sucursal y tenant | Vyloop core | Limitar cada pase y consulta al tenant y la sucursal. |
| Identidad del cliente y teléfono | Customer/Growth domain | Usar la sesión autenticada del cliente cuando se requiera identidad. |
| Reglas de acumulación y canje | Growth domain | Mostrar solo las reglas que el comercio haya configuradas y claramente declaradas. |
| Saldo de sellos o puntos | Registro de Vyloop | Proyectar el estado actual hacia los campos del proveedor. |
| Elegibilidad de recompensa y canje | Growth domain | Autorizar en el momento de uso; actualizar o revocar el pase después de la transición de estado. |
| Consentimiento | Registro de consentimiento y versión de política | Controlar WhatsApp, promociones y canal cercano de forma independiente. |
| Sincronización del proveedor | Estado de entrega de la billetera | Registrar el objeto del proveedor, la versión de actualización, los reintentos y los errores. |

El ciclo de vida mínimo de un proveedor debe registrar:

- `provider`.
- `provider_object_id` o referencia del pase.
- `customer_id`.
- `business_id` y `branch_id`.
- `status`: `pending`, `active`, `revoked`, `expired` o `failed`.
- Última versión o secuencia sincronizada.
- Último error y metadatos de reintento.
- Fechas y horas de creación, revocación y expiración.

Cada actualización del proveedor debe ser idempotente. Un evento o invocación de Worker reintentada no debe crear un segundo sello, duplicar un pase ni avanzar dos veces al cliente.

## 8. Adaptador neutral respecto del proveedor

Growth debe conservar la semántica de fidelización. El adaptador de billetera móvil debe encargarse de la traducción y entrega específicas de cada proveedor.

```text
Evento de fidelización
    → proyección del registro de Growth
    → proyección del pase de billetera móvil
    → WalletAdapter
        ├─ GoogleWalletAdapter
        └─ AppleWalletAdapter
    → ciclo de vida del objeto del proveedor
```

El adaptador debe exponer capacidades internas estables, en lugar de filtrar campos específicos del proveedor hacia Growth:

| Capacidad interna | Google primero | Apple después |
|---|---|---|
| Crear pase de fidelidad | Objeto de fidelidad de Google Wallet | Pase `storeCard` de PassKit |
| Actualizar estado estructurado | Actualización de Google Wallet | Actualización de pase de PassKit |
| Revocar o desactivar el pase | Ciclo de vida admitido por el proveedor | Ciclo de vida admitido por el proveedor |
| Código de barras del comercio | Campo estructurado | Campo estructurado |
| Notificación cercana | Notificación push o cercana de Google con cuotas y restricciones de privacidad | Contexto de ubicación o pase admitido por Apple, sujeto a las reglas vigentes de la plataforma |
| Autorización de pago | Google Pay | Apple Pay |

**Corrección:** Apple Pay y Google Pay autorizan pagos. No son autenticación general de identidad. Para identidad, se deben usar OTP, passkeys o la sesión de cuenta existente, sujeto a los requisitos de seguridad y jurisdicción del producto.

## 9. Inscripción, actualización y revocación

### 9.1. Contrato de inscripción

La inscripción debe ser neutral respecto del proveedor hasta que se conozca la capacidad del dispositivo. El servidor debe:

1. Validar el tenant, la sucursal, el contexto de inscripción y los datos del cliente.
2. Crear o recuperar al cliente sin combinar identidades de forma silenciosa a partir de señales débiles.
3. Aplicar exactamente una vez la recompensa de bienvenida configurada.
4. Registrar las decisiones de consentimiento por separado.
5. Construir la proyección canónica del pase.
6. Crear el objeto del proveedor y almacenar su referencia.
7. Entregar un resultado de inscripción persistente sin exponer los datos de otro cliente.

### 9.2. Contrato de actualización

Las actualizaciones del proveedor deben dispararse por cambios canónicos en el registro, no por la edición directa de un pase de billetera. Cada actualización incluye una versión de proyección, una clave de idempotencia y los campos estructurados mínimos que requiere el proveedor.

Una actualización fallida no debe revertir el registro autoritativo. Debe marcar la entrega como pendiente o fallida, exponer el estado operativo y reintentarse de forma segura.

### 9.3. Contrato de revocación

La revocación corresponde a la eliminación de la cuenta, la terminación del programa del comercio, la sospecha de fraude, la expiración de la membresía o una regla explícita del comercio o del programa. El historial de auditoría del registro permanece disponible según la política de retención. El pase debe comunicar el estado actual sin insinuar que los eventos históricos fueron eliminados.

## 10. Sellador del comercio

El comercio necesita una forma pequeña y confiable de agregar el sello real. El MVP debe admitir:

- Un QR de sucursal o una URL corta de inscripción.
- Un cajero u operador autenticado ante el negocio.
- Un sellador web/PWA que acepte una referencia de pase o miembro y la visita o compra que cumple la condición.
- Un estado explícito de éxito, ya aplicado, no elegible y error.
- Idempotencia y un evento de auditoría para cada mutación.

El POS emulado actual y el QR codificado explícitamente de Café Central no constituyen un sellador de producción. La ruta de cliente `/c/[globalId]` y la proyección orientada al cliente también deben completarse antes de considerar real el flujo. Los niveles de cliente codificados explícitamente deben reemplazarse por configuración del tenant o por la proyección canónica de Growth.

El sellador del comercio es la fuente del evento que cumple la condición. El pase de billetera móvil no debe fabricar un sello solo por ser abierto, capturado de pantalla o copiado.

## 11. Reclamación opcional mediante recibo

Un QR en el recibo puede permitir una atribución blanda, pero no demuestra que el cliente estuviera presente.

Si se habilita posteriormente, debe utilizar:

- Tokens opacos y de corta duración.
- Consumo atómico de un solo uso.
- Idempotencia del lado del servidor y protección contra repeticiones.
- Autorización de la cuenta antes de acreditar a un miembro.
- Controles de dispositivo, IP, frecuencia y fraude.
- Un rastro de auditoría claro y una ruta de conciliación operativa.

Una firma por sí sola no convierte un token en un token de un solo uso. Un token firmado pero reproducible no es suficiente.

Para canjes de alto valor, es preferible utilizar escaneo por parte del cajero o NFC. La reclamación mediante recibo es apropiada solo cuando el comercio acepta el límite de confianza más débil y se comprenden sus efectos frente al fraude.

## 12. Compañero PWA opcional

Un compañero PWA puede mejorar la inscripción, la gestión de consentimiento y el sellado por parte del comercio sin convertirse en un requisito para tener un pase. Es opcional y no reemplaza la tesis de cero instalación.

Debe utilizarse cuando entregue una razón concreta para que el cliente regrese:

- Actualizar preferencias y revocar consentimiento.
- Consultar la actividad del registro y el estado de las recompensas.
- Reclamar un recibo cuando la función esté disponible.
- Usar un sellador del comercio.
- Recibir mensajes de servicio cuando el cliente los haya aceptado.

No se debe exigir la instalación de una PWA para canjear o consultar el pase básico. No se debe presentar como una Android Instant App; Google Play Instant está retirado para nuevas distribuciones en 2026.

## 13. Notificaciones por geocerca

Las notificaciones cercanas son un canal opcional, no un requisito de inscripción. Apple y Google ofrecen mecanismos distintos de ubicación y notificación. Las notificaciones push o cercanas de Google están sujetas a cuotas, preferencias del usuario, restricciones de privacidad y políticas de la plataforma; las actualizaciones del pase se sincronizan, pero no garantizan una visualización instantánea.

Comportamiento del MVP:

- Mantener la aceptación de notificaciones cercanas separada de los mensajes de servicio y promocionales.
- Mantenerla desactivada por defecto.
- Almacenar el propósito del consentimiento y la versión de la política.
- Utilizar una estrategia mínima de ubicación o proximidad, con reglas de retención y eliminación.
- Respetar la revocación y la configuración de notificaciones del sistema operativo.
- Evitar que la proximidad sustituya la autorización del comercio o un evento del registro.

El prototipo visual incluye una vista previa de notificación solo como concepto. No demuestra que un pase active una notificación en la pantalla de bloqueo de todos los dispositivos compatibles.

## 14. Diseño conductual con recompensas reales y claramente declaradas

La experiencia debe utilizar progreso con meta inicial revelada solo cuando la recompensa exista y el comercio haya declarado claramente la regla. El cliente puede comprender un sello de bienvenida o una ruta visible de 8/10 porque corresponden a un estado real del registro. Una cuenta regresiva falsa, una barra de progreso precargada o una recompensa que el comercio no puede honrar son dañinas.

La referencia de investigación es Nunes & Drèze (2006), que informa un resultado de fidelización en un lavadero de 34% frente a 19% dentro del contexto estudiado. Esto respalda la importancia general del progreso con meta inicial revelada, pero no justifica una previsión de conversión para Vyloop.

No debe repetirse la siguiente afirmación: una comparación universal de abandono entre billetera móvil y aplicación de menos del 5% frente al 60%. No se encontró una fuente primaria creíble para esa comparación, por lo que se considera no respaldada y se elimina del discurso del producto.

Orientaciones de comportamiento:

- Mostrar la próxima acción significativa, no un panel lleno de funciones.
- Mantener visible la fila de sellos incompleta.
- Declarar claramente la próxima recompensa, su valor y su vencimiento.
- Evitar la urgencia que no sea verdadera.
- Permitir que el cliente salga del programa sin perder el historial del registro.

## 15. Privacidad y consentimiento

Vyloop es custodio de los datos del cliente, no su propietario. La experiencia de billetera móvil debe aplicar privacidad por diseño a la relación entre comercio, cliente y proveedor.

| Propósito del consentimiento | Valor por defecto | Ejemplos | Control requerido |
|---|---|---|---|
| Cuenta de fidelización | Requerido para el servicio solicitado | Creación de cuenta, ciclo de vida del pase y contabilidad de recompensas | Aviso claro y base legal o comercial según la jurisdicción. |
| Mensajes de servicio por WhatsApp | Desactivado | Actualizaciones de saldo y confirmaciones de recompensa | Aceptación separada y gestión de preferencias. |
| Promociones | Desactivado | Ofertas del comercio | Separado de los mensajes de servicio; con revocación sencilla. |
| Notificaciones cercanas | Desactivado | Oferta local relevante o recordatorio | Elección granular de ubicación y notificación, además de los controles del sistema operativo. |
| Enriquecimiento de analítica o marketing | Desactivado salvo que sea necesario o se autorice por separado | Perfilamiento y audiencias entre comercios | Propósito separado, minimización, retención y ruta de exportación o eliminación. |

Reglas técnicas:

- Almacenar la versión de la política, fecha y hora, origen, canal y propósito de cada decisión.
- Hacer que la revocación sea efectiva para el procesamiento futuro.
- No inferir consentimiento por abrir la billetera móvil, aceptar el pase o crear una cuenta.
- No agrupar promociones o notificaciones cercanas con la cuenta de fidelización.
- Mantener el alcance de tenant y sucursal en la evidencia de consentimiento.
- Aplicar políticas de retención y eliminación a los datos crudos de ubicación y mensajes por separado del historial del registro.

## 16. Correcciones técnicas y afirmaciones obsoletas

| Afirmación o propuesta | Corrección |
|---|---|
| El strip de Apple es 624 × 246 o 1032 × 336. | El strip actual de `storeCard` es 375 × 144 pt, con PNG de 750 × 288 a @2x y 1125 × 432 a @3x. |
| La imagen de encabezado de Google es 1032 × 336. | La recomendación actual es 1032 × 812, aproximadamente 5:4. |
| El QR o código de barras está incrustado en el arte del pase. | Los proveedores renderizan códigos desde campos estructurados; el arte no debe contener el código. |
| El QR debe medir físicamente 2 × 2 cm. | No existe un mínimo físico universal. Se deben validar carga útil, corrección de errores, zona silenciosa, contraste y contexto de visualización. |
| iBeacon es necesario para la relevancia por ubicación habitual. | Apple admite ubicaciones geográficas configuradas; iBeacon es opcional. |
| Las actualizaciones de la billetera móvil son instantáneas garantizadas. | La sincronización del proveedor es posterior y está limitada por su comportamiento. |
| Apple Pay o Google Pay autentican la identidad. | Autorizan pagos; para identidad se deben usar OTP, passkeys o la sesión de cuenta. |
| Android Instant App forma parte de la ruta actual. | Google Play Instant está retirado para nuevas distribuciones en 2026. |
| App Clip es la superficie de inscripción del MVP. | App Clip requiere una aplicación correspondiente; se difiere y se utiliza una inscripción web optimizada. |
| El QR del pase demuestra que el cliente estuvo presente. | Solo demuestra lo que el servicio emisor decidió codificar; la reclamación de recibos requiere token, autorización y controles de fraude. |
| Referencia universal de abandono entre billetera móvil y aplicación. | Eliminar la afirmación no respaldada de menos del 5% frente al 60%. |
| El diseño de progreso se puede copiar de cualquier aplicación de fidelización. | El progreso solo es valioso cuando existe una recompensa real, claramente declarada y respaldada. |

## 17. Hoja de ruta por fases

### Fase 0 — Fortalecer el registro y el límite de reclamación

- Definir la proyección canónica de fidelización y el ciclo de vida del proveedor.
- Reemplazar los supuestos de QR codificado explícitamente de Café Central, niveles de cliente y POS emulado.
- Implementar comandos idempotentes de sellado y canje con eventos de auditoría.
- Construir registros por propósito de consentimiento y operaciones de revocación.
- Agregar la ruta de cliente ausente y verificar el aislamiento por tenant y sucursal.

### Fase 1 — Inscripción web y ciclo de vida Google primero

- Entregar la ruta de inscripción web optimizada para un café y una panadería.
- Crear clases y objetos de fidelidad de Google Wallet desde el estado estructurado del registro.
- Agregar creación, actualización, error, reintento y revocación del pase.
- Agregar un sellador web/PWA para el operador del comercio.
- Exponer un identificador de miembro legible y una alternativa para el código de barras.
- Instrumentar inscripción, adopción del pase, primer sello, canje y revocación sin asumir una previsión de conversión.

### Fase 2 — Paridad con Apple

- Agregar el adaptador de Apple `storeCard` y su ciclo de vida.
- Validar las dimensiones actuales de activos, campos, ubicaciones y comportamiento alternativo de Apple.
- Mantener las reglas de Growth neutrales respecto del proveedor; no bifurcar la lógica de fidelización por proveedor.

### Fase 3 — Mejoras de PWA y contexto

- Agregar un compañero PWA opcional para preferencias, actividad y sellado por parte del comercio.
- Agregar la reclamación de recibos solo con el límite de seguridad descrito anteriormente.
- Agregar notificaciones por geocerca detrás de consentimiento explícito y cuotas.
- Agregar NFC o escaneo por parte del cajero cuando el modelo de fraude lo permita.

### Fase 4 — Contexto avanzado opcional

- Evaluar App Clip solo si una aplicación correspondiente y un caso de uso validado justifican el mantenimiento adicional.
- Evaluar NFC, contexto cercano más rico, fidelización cruzada y atribución avanzada del comercio.
- Revisar analítica y ML solo después de contar con eventos y consentimientos reales.

## 18. Fuera del alcance del MVP

- Arquitectura de Android Instant App.
- App Clip como ruta de inscripción predeterminada.
- Apple Pay o Google Pay como autenticación de identidad.
- Incrustar QR o códigos de barras en el arte.
- Garantizar una visualización instantánea del pase.
- Consentimiento preseleccionado de notificaciones, marketing, ubicación o notificaciones de cercanía.
- Una previsión universal de conversión derivada de investigación genérica de fidelización.
- Una segunda fuente de verdad dentro del pase del proveedor.
- Un QR de recibo que acredite a un miembro sin autorización de cuenta y controles de un solo uso del servidor.
- La instalación de una aplicación nativa como requisito previo para la experiencia básica de fidelización.

## 19. Criterios de aceptación

### 19.1. Inscripción y consentimiento

- [ ] Un cliente puede inscribirse desde una URL web específica del comercio o un contexto QR en aproximadamente 10 segundos.
- [ ] Nombre y teléfono son los campos principales por defecto.
- [ ] Una recompensa de bienvenida configurada y claramente declarada, de un sello o crédito equivalente, se aplica exactamente una vez.
- [ ] Los mensajes de servicio por WhatsApp, las promociones y las notificaciones cercanas son controles separados y permanecen sin marcar por defecto.
- [ ] La evidencia de consentimiento registra propósito, canal, versión de política, fecha y hora, origen, tenant y sucursal.
- [ ] La revocación evita envíos futuros para ese propósito sin eliminar el registro.
- [ ] En producción, la interfaz muestra únicamente la acción del proveedor compatible.

### 19.2. Pase y registro

- [ ] Un pase se crea desde campos estructurados y una proyección autoritativa del registro.
- [ ] La creación, actualización, el reintento y la revocación del pase de Google Wallet funcionan para el piloto.
- [ ] La creación y actualización de `storeCard` de Apple funcionan mediante el mismo contrato neutral respecto del proveedor en la Fase 2.
- [ ] Las dimensiones actuales de activos de Apple y Google están representadas en las herramientas de diseño y validación.
- [ ] Se prueban las zonas silenciosas de QR y códigos de barras, el contraste y las alternativas legibles por personas.
- [ ] Los reintentos y eventos duplicados no pueden duplicar un sello, una recompensa o un canje.
- [ ] Los estados de revocación y expiración son auditables y no eliminan los eventos históricos del registro.

### 19.3. Operación del comercio

- [ ] Un comercio puede aplicar un sello real que cumpla la condición desde una superficie de operador con alcance de sucursal.
- [ ] El sellador informa estados de éxito, ya aplicado, no elegible y error.
- [ ] El QR codificado explícitamente, los niveles de cliente y el comportamiento del POS emulado ya no forman parte de la ruta de producción.
- [ ] Una reclamación de recibo, si se habilita, utiliza tokens opacos de corta duración, consumo atómico de un solo uso, idempotencia del servidor, autorización de cuenta y controles de fraude y frecuencia.

### 19.4. Privacidad y comunicaciones

- [ ] No se infiere consentimiento de notificaciones o marketing al crear la cuenta o aceptar el pase.
- [ ] Las notificaciones cercanas requieren consentimiento explícito y respetan la configuración del sistema operativo y del proveedor.
- [ ] El cliente puede inspeccionar y revocar cada propósito de comunicación.
- [ ] El texto del producto no contiene estadísticas genéricas de abandono entre billetera móvil y aplicación ni previsiones de conversión no respaldadas.

## 20. Decisiones abiertas

| Decisión | Motivo de apertura | Valor por defecto hasta decidirla |
|---|---|---|
| Nombre de las clases de Google Wallet y clases específicas por tenant | El modelo de clases debe admitir el primer vertical sin crear una proliferación descontrolada de clases. | Una familia de clases validada por cada forma de programa de recompensas. |
| Política de recompensa de bienvenida | Algunos comercios prefieren un sello; otros, un pequeño crédito de saldo o ninguna recompensa de bienvenida. | Configurar una recompensa real y claramente declarada por programa; no inventar una regla global. |
| Fortaleza de la identidad del cliente | La inscripción solo con teléfono es rápida, pero no es suficiente para todos los canjes o reclamaciones. | Inscripción rápida para crear el pase; sesión más fuerte para reclamaciones propias y acciones sensibles. |
| Reclamación mediante recibo | Requiere que el comercio acepte la atribución blanda y los controles de fraude. | Mantener desactivada hasta que un piloto tenga una persona responsable del riesgo. |
| Radio y retención de notificaciones cercanas | Dependen de la densidad de comercios, la compatibilidad del dispositivo y la política de privacidad. | Sin notificaciones de cercanía por defecto; medir solo después del consentimiento explícito. |
| Manifiesto y service worker de la PWA | La web de clientes actual se describe como PWA, pero aún no ofrece una PWA instalable completa. | Tratar la PWA como compañera opcional, no como requisito previo. |
| Frescura de actualización del pase | El comportamiento del proveedor y la configuración del usuario limitan lo que puede prometerse. | Indicar “sincronizado” y medir la entrega de forma asíncrona. |
| Flujo de producción del arte de Apple y Google | Los activos del proveedor y los campos estructurados tienen restricciones diferentes. | Mantener el arte solo para presentación y generar códigos en el momento de renderizado. |
| Pase por sucursal o por tenant | Un cliente puede visitar varias sucursales con reglas diferentes. | Limitar cada evento de acumulación y canje al programa y a la política de sucursal configurados. |

## 21. Fuentes y referencias oficiales actuales

Consultadas el 2026-09-25. Son referencias de implementación; no afirman que Vyloop haya completado la certificación o aprobación de producción de los proveedores.

- [Apple Human Interface Guidelines — Wallet](https://developer.apple.com/design/human-interface-guidelines/wallet)
- [Apple Developer — PassKit](https://developer.apple.com/documentation/passkit)
- [Apple Developer — Crear un pase de `storeCard`](https://developer.apple.com/documentation/walletpasses/creating-a-store-card-pass)
- [Apple Developer — Agregar un pase a la billetera del usuario](https://developer.apple.com/documentation/walletpasses/adding-a-pass-to-the-user-s-wallet)
- [Apple Developer — Agregar un servicio web para actualizar pases](https://developer.apple.com/documentation/walletpasses/adding-a-web-service-to-update-passes)
- [Apple Developer — Mostrar un pase en la pantalla de bloqueo](https://developer.apple.com/documentation/walletpasses/showing-a-pass-on-the-lock-screen)
- [Google Wallet — Descripción general de las tarjetas de fidelidad](https://developers.google.com/wallet/retail/loyalty-cards)
- [Google Wallet — Cómo funcionan las clases y los objetos](https://developers.google.com/wallet/retail/loyalty-cards/overview/how-classes-objects-work)
- [Google Wallet — Flujo para agregar a Google Wallet](https://developers.google.com/wallet/retail/loyalty-cards/overview/add-to-google-wallet-flow)
- [Google Wallet — Actualizaciones de pases](https://developers.google.com/wallet/retail/loyalty-cards/use-cases/updates)
- [Google Wallet — Notificaciones push](https://developers.google.com/wallet/retail/loyalty-cards/use-cases/trigger-push-notifications)
- [Google Wallet — Pautas de marca](https://developers.google.com/wallet/retail/loyalty-cards/resources/brand-guidelines)
- [Google Wallet — Solicitar acceso de publicación](https://developers.google.com/wallet/retail/loyalty-cards/test-and-go-live/request-publishing-access)
- [Android — Retiro de Google Play Instant](https://developer.android.com/topic/google-play-instant)
- [Nunes & Drèze — “The Endowed Progress Effect: How Artificial Advancement Increases Effort”](https://doi.org/10.1086/500480)

## 22. Contexto relacionado del repositorio

- `docs/00-Product-Vision.md` — principios de producto enfocados en valor, privacidad por diseño, API-first y preparación global.
- `docs/05-System-Design-Document.md` — stack edge-native existente y dirección del adaptador de billetera móvil.
- `docs/07-Architecture.md` — límites de dominio orientados a eventos, estado en PostgreSQL y Cloudflare Queues.
- `docs/14-Backlog.md` — backlog actual del MVP, incluida la ruta de cliente aún ausente, la mutación de consentimiento verificado y el trabajo de integración con POS.
- `docs/09-Database-Design.md` — detalles de persistencia y tenancy que deben alinearse antes de agregar tablas del ciclo de vida de la billetera móvil.
