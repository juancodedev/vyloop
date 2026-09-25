# 11-Customer-Web-Design-Implementation-Plan.md
**[DOCUMENTO]:** Plan de rediseño por etapas para la web de clientes | **[VERSIÓN]:** v1.0 | **[ESTADO]:** Planning | **[RESPONSABLE]:** Producto y Frontend

> **Decisión:** reemplazar la experiencia actual de `apps/customer-web` por una versión `club-barrio` cálida, clara y orientada a retorno, inspirada en el prototipo aprobado. Cada etapa produce un resultado visible en navegador y queda bloqueada hasta recibir aprobación visual explícita.

---

## 1. Decisión de ejecución

- **Dirección visual:** `club-barrio`; superficies de papel y leche, tinta oscura, cereza como acción principal y dorado reservado para sellos/estado de recompensa.
- **Jerarquía:** cada vista tiene un foco. En `/` es entrar al programa; en registro es completar la inscripción; en perfil es comprender el progreso real; en recompensas es elegir una recompensa válida.
- **Metáfora:** fila de sellos abierta, progreso visible y alternativa legible por personas. El arte no reemplaza los datos estructurados ni el registro autoritativo.
- **Verdad de producto:** la web muestra el estado que devuelve la API. No simula la emisión de Google Wallet o Apple Wallet, la sincronización ni recompensas no configuradas.
- **Orden:** el rediseño visual avanza por etapas. No se implementa una etapa siguiente hasta que la persona usuaria revise el resultado visible y apruebe explícitamente.
- **Paquete:** se reutilizan `@vyloop/design-system`, `lucide-react`, `qrcode` y CSS existente. No se agrega una biblioteca de UI sin una decisión separada.
- **Presupuesto de revisión:** el cambio probable supera 400 líneas. Se recomienda dividir en unidades de trabajo y PRs encadenados; no crear un único PR masivo.

### Decisiones ya tomadas

1. La primera aprobación visual corresponde a `/`, no al perfil.
2. Se conserva el contrato de autenticación por teléfono mientras no exista una corrección mínima necessária para el contexto del tenant.
3. No se muestran consentimientos de marketing, ubicación o WhatsApp preseleccionados.
4. No se muestran niveles, umbrales, progreso, saldo o recompensas con valores hardcodeados.
5. La emisión de pases de billetera queda fuera de este plan. Cualquier referencia futura debe decir **vista previa** o **no disponible**.

---

## 2. Evidencia del estado actual

La inspección se realizó sobre el repositorio actual. No se modificó código fuente, tests, configuraciones ni prototipo.

**Verificación baseline ejecutada:** `pnpm --filter @vyloop/customer-web lint`, `typecheck` y `test` finalizaron correctamente; Vitest reportó que no existen archivos de tests en `apps/customer-web`. Esta ausencia se trata como deuda de cobertura, no como aprobación para omitir tests futuros.

| Evidencia | Hallazgo | Impacto en el plan |
|---|---|---|
| `apps/customer-web/app/page.tsx` | La portada es una tarjeta genérica con “¡Bienvenido!”, un SVG de QR y dos acciones. | Es el primer cambio visible y la primera puerta de aprobación. |
| `apps/customer-web/app/login/page.tsx` | El formulario usa `autoFocus`, mensajes con `...` y no propaga el `businessSlug` de la URL. | La etapa 3 elimina `autoFocus` y preserva el contrato, pasando el slug solo cuando ya exista en el contexto de la URL. |
| `apps/customer-web/app/register/page.tsx` | El formulario está en estilos inline, solicita cuatro campos y no tiene consentimientos. | La etapa 2 lo reduce a nombre y teléfono, agrega contexto real y consentimientos separados. |
| `apps/customer-web/app/profile/page.tsx` | Tiene `TIER_CONFIG` hardcodeado con Bronce/Plata/Oro y umbrales 0/1000/3000, contrario al seed actual 0/500/2000. | Se elimina esa configuración; el progreso se deriva de la proyección del tenant. |
| `apps/customer-web/app/profile/rewards/page.tsx` | Consume recompensas activas y permite canjear; la confirmación se pasa por query string. | Se conserva la API; se agregan estados de saldo, validez y canje sin inventar disponibilidad. |
| `apps/customer-web/app/profile/history/page.tsx` | Consume transacciones filtradas por `customer_id`, con filtros locales. | Se conserva el contrato y se mejora la presentación de estados. |
| `apps/customer-web/app/globals.css` | Tiene 1,309 líneas, mixto de CSS global y estilos de componentes, además de `transition: all` y `outline: none`. | Se reduce la duplicación gradualmente; los tokens semánticos tienen prioridad. |
| `apps/customer-web/app/layout.tsx` | Usa `Inter`, importa tokens del sistema de diseño y fija `maximumScale: 1`. | La etapa 0 define el marco; la etapa 6 elimina la restricción de zoom. |
| `apps/customer-web/app/lib/api.ts` | Expone login, perfil, recompensas, canje, transacciones y consentimiento; el cliente no tiene un modelo de programa completo. | La etapa 4 define una proyección mínima y segura antes de mostrar un progreso. |
| `packages/design-system` | Ya exporta `Button`, `Input`, `Card`, `Badge`, `ProgressBar`, `Avatar` y `Skeleton`. | Se usan como base; no se reconstruyen controles accesibles a mano. |
| `apps/customer-web` | No contiene archivos de tests actualmente; Vitest está configurado con `passWithNoTests`. | Cada etapa que cambie comportamiento debe agregar cobertura enfocada junto con la implementación. |
| `.superpowers/brainstorm/54260-1790304161/content/wallet-experience-v1.html` | El prototipo define la dirección `club-barrio`, sellos 8/10, consentimientos desactivados y advierte que no es una captura nativa. | Se toma como referencia visual, no como contrato de API ni simulación de producción. |
| `docs/10-Wallet-Experience.md` | El registro es autoritativo; la billetera es proyección; el QR no demuestra identidad ni presencia. | Se eliminan promesas de proveedor y se conserva el ID legible junto al QR. |

### Riesgos de contrato detectados antes de implementar

- `GET /v1/customers/me` devuelve el nivel actual, pero no devuelve el nombre del negocio, el nombre del programa, el umbral del siguiente nivel ni la lista de niveles.
- El cliente llama `PUT /v1/customers/me/consent`, pero la ruta de ese endpoint no aparece en `workers/customer/src/routes.ts`; el interruptor actual puede ser una acción sin persistencia real.
- `PUT /v1/customers` acepta `businessSlug` y crea/recupera el cliente, pero no acepta consentimientos.
- El login de la UI acepta `businessSlug` en `app/lib/auth.tsx`, pero `/login` no lo obtiene de la URL.
- `GET /v1/loyalty/rewards?active=true` filtra recompensas no vigentes y sin stock. La UI no debe simular recompensas agotadas o vencidas que la API no entrega.
- `packages/db` sí tiene `consents`, pero el modelo actual no registra todavía la evidencia completa de política/jurisdicción descrita en `docs/10-Wallet-Experience.md`. El plan visual no debe declarar esa cobertura antes de existir.

**Decisión de planificación:** la etapa 2 y la etapa 4 incluyen una corrección aditiva y explícita del contrato solo donde la verdad de datos sea imposible sin ella. Si esa corrección no se aprueba, la UI queda en respaldo seguro y nunca presenta un control o estado como persistido.

---

## 3. Ruta rápida de implementación

1. Capturar el estado actual, fijar tokens y estados compartidos; revisar el marco en navegador.
2. Rediseñar `/` y obtener la primera aprobación visual.
3. Rediseñar `/register`, validar el contrato de inscripción y consentimientos; aprobar.
4. Rediseñar `/login` como continuación del mismo sistema; aprobar.
5. Rediseñar `/profile` con la proyección real del programa; aprobar.
6. Rediseñar recompensas, historial y confirmación; aprobar.
7. Endurecer responsive, accesibilidad y consistencia; aprobar.
8. Ejecutar verificación final, compilación justificada, recorrido de navegador y entrega.

**Regla de bloqueo:** después de cada etapa, registrar el resultado de comandos, el escenario de navegador y la decisión visual. No iniciar la etapa siguiente hasta recibir una aprobación explícita.

---

## 4. Matriz ruta → etapa

| Ruta o superficie | Etapa principal | Etapa de soporte | Regla |
|---|---:|---:|---|
| `/` | 1 | 0, 6, 7 | Primera pantalla visible y primera puerta de aprobación. |
| `/register` | 2 | 0, 6, 7 | Inscripción corta, contexto del tenant y consentimientos separados. |
| `/login` | 3 | 0, 6, 7 | Mantener autenticación existente; quitar `autoFocus`. |
| `/profile` | 4 | 0, 6, 7 | Pase/progreso real, ID, QR y estado de próxima recompensa. |
| `/profile/rewards` | 5 | 0, 6, 7 | Catálogo activo, saldo y canje con estados reales. |
| `/profile/rewards/confirm` | 5 | 6, 7 | Confirmación posterior a un canje exitoso; no duplicar la fuente de verdad. |
| `/profile/history` | 5 | 0, 6, 7 | Movimientos reales, filtros y vacío/error/carga. |
| `/confirm` | — | 6 | Ruta existente no conectada al flujo actual; no enlazarla ni convertirla en CTA sin decisión de producto. |
| `/not-found` | 6 | 0, 7 | Solo recibe tokens, disposición y foco; no rediseñar como nueva funcionalidad. |
| Marco, viewport y estados compartidos | 0 y 6 | 7 | Evitar duplicación y mantener coherencia en todas las rutas. |

---

## 5. Contrato visual reutilizable

### Lectura de diseño

**Rediseño de una web de consumo para una persona que quiere volver a su comercio, no administrar un panel.** La interfaz debe sentirse como un cuaderno de barrio actualizado: cálida, tangible, legible y con una recompensa que se entienda sin interrogarse si el dato es real.

### Tokens

| Área | Contrato |
|---|---|
| Tinta | `#27201d` para texto principal y bordes fuertes; `#6f625b` para texto secundario. |
| Papel | `#f3eee5` como fondo de página; `#fffdf7` como superficie elevada y zonas de contenido. |
| Cereza | `#a9362b` para CTA, acción principal y estados enfáticos; `#74231d` para texto cereza sobre leche. |
| Dorado | `#c38a35` reservado exclusivamente para sello, marca de comercio o estado de recompensa; no como segundo CTA. |
| Línea | `rgba(39, 32, 29, .16)` para bordes estándar; `.09` para separadores. |
| Foco | Azul `#1e67b1` con anillo visible de 3 px, porque el foco no debe depender del color de la marca. |
| Éxito/advertencia | Tokens semánticos existentes (`--success`, `--warning`, `--error`) para estados, sin inventar una paleta paralela. |
| Proveedor | Esmeralda, menta e imagen de Google Wallet quedan reservados para una futura superficie de proveedor; no se agregan a las rutas actuales. |

### Tipografía

- Mantener `Inter` como cuerpo porque ya está instalada y cargada con `next/font`; no agregar una dependencia de fuente.
- Usar la escala existente de `packages/design-system/src/tokens/typography.css`: 12/13/14/16/18/20/24/30/36/48 px.
- El display puede usar `var(--font-display, system-ui, sans-serif)` hasta que una decisión de marca cargada justifique cargar otra fuente.
- Titulares con `text-wrap: balance`; cuerpo y metadatos con `text-wrap: pretty`; números con `font-variant-numeric: tabular-nums`.
- Evitar títulos mayores de 48 px en la portada y más de 30 px en superficies internas salvo una decisión visual posterior.

### Espaciado, profundidad y forma

- Base de 4 px, con la escala existente de 4/8/12/16/20/24/32/40/48/64 px.
- Página móvil: 16 px laterales; escritorio: contenedor máximo de 1,180–1,280 px y columna de lectura de 45–65 caracteres.
- Profundidad: superficies con cambios de tono sutiles y sombra muy leve; no mezclar sombras dramáticas, glassmorphism y bordes gruesos.
- Radios: `8px` para controles, `12–18px` para tarjetas, `999px` solo para sellos/píldoras y `36px` únicamente para el marco conceptual de un pase.
- Objetivos interactivos mínimos: 44×44 px; los interruptores visibles pueden ser menores si el área total conserva 44 px.
- Una acción principal por vista; las secundarias son enlaces o botones outline/ghost con la misma intención semántica.

### Movimiento

- Solo transiciones de `transform` y `opacity`, con `--transition-fast` y `--ease-out`.
- Entradas breves de 150–250 ms; ninguna animación infinita en contenido informativo.
- `prefers-reduced-motion: reduce` elimina desplazamiento, resplandor, pulso, animación de conteo y cambios de escala.
- El pulso de puntos actual no se conserva si no comunica un cambio real; una actualización de datos puede tener un único pulso corto.

### Imágenes y firma de sello

- La firma es una fila abierta de sellos circulares con completos y vacíos claramente distinguibles; no es una casilla ni una barra genérica.
- La fila se acompaña de texto equivalente: “8 de 10 sellos”, “faltan 2” o el estado real disponible.
- El ID de miembro y una alternativa legible permanecen visibles junto al QR.
- Si el programa es de puntos y no tiene regla de sellos, se muestra una variante de progreso por puntos; nunca se fabrica `8/10`.
- Las imágenes de recompensas usan `imageUrl` real, con `width`, `height`, `alt` y texto alternativo. No se usan imágenes de Google Wallet como recursos visuales de la web actual.
- No se agregan logos de terceros, testimonios, cifras de conversión, “usado por” ni afirmaciones que no estén soportadas.

### Valores por defecto prohibidos

- No usar `Café Central`, `Bronce/Plata/Oro` ni umbrales fijos como contenido de cliente.
- No mostrar `Add to Google Wallet` o `Add to Apple Wallet` como acciones disponibles.
- No afirmar que el QR prueba identidad, presencia o autorización de compra.
- No afirmar PWA instalable: la app actual no tiene manifest ni service worker.
- No usar `autoFocus`, `maximumScale: 1`, `outline: none` sin reemplazo, `transition: all`, elementos clicables sin semántica, emoji como sistema visual ni textos de ejemplo como etiquetas.
- No ocultar errores de API ni presentar un respaldo vacío como “datos reales”.
- No inventar balance, recompensas, stock, nombre del comercio, nivel, fecha de vencimiento o progreso.
- No introducir una librería de UI nueva sin una decisión explícita y una comparación con las primitivas existentes.

---

## 6. Tabla de verdad de datos

| Dato o estado | Fuente actual | Derivación segura en UI | Respaldo permitido | No falsificar |
|---|---|---|---|---|
| Identidad del cliente | `GET /v1/customers/me` | Nombre y `globalId` del perfil autenticado | “Tu perfil” sin nombre | No usar `Café Central` ni un nombre de demo. |
| Tenant/sucursal | `businessSlug` en la URL; `businessId` del JWT; `tenants` en backend | Mostrar nombre solo si el endpoint entrega nombre; si no, texto genérico y el slug solo como contexto técnico no destacado | “Este programa” | No convertir el slug en un nombre comercial inventado. |
| Nombre del programa | `loyaltyPrograms.name`, actualmente no expuesto al cliente | Mostrar si la proyección mínima lo entrega | “Programa de fidelidad” | No usar “Programa de Lealtad Demo” como producto. |
| Moneda/puntos | `pointsCurrency`, hoy no expuesto en `/me` | Usar el valor del tenant si existe; si no, “puntos” | “puntos” | No convertir puntos a dinero. |
| Saldo | `CustomerProfile.points` | Número real, con `Intl.NumberFormat` | `0` solo cuando la API confirme saldo cero | No precargar saldo de ejemplo. |
| Total acumulado | `CustomerProfile.totalPointsEarned` | Mostrar solo como contexto secundario | `—` si la API no lo entrega | No inferirlo desde el saldo. |
| Nivel actual | `currentTier`, `currentTierId`, `tier` | Nombre de la API | “Tu nivel” | No usar Bronce/Plata/Oro por defecto. |
| Umbral siguiente | `membershipTiers.minPoints` / `displayOrder` | Obtener una proyección de niveles o agregar campos aditivos a `/me` | Barra de progreso sin umbral y texto “Tu progreso actual” | No usar 1000/3000 ni el seed 500/2000 en cliente. |
| Sello/progreso | Proyección de programa, si existe | `completados/total` solo cuando el tenant lo define | Variante de puntos o estado sin progreso numérico | No mostrar un porcentaje de sellos pendiente. |
| Próxima recompensa | Regla del programa + catálogo/recompensa configurada | Nombre, costo y regla solo si la API entrega una referencia válida | “Tu saldo está disponible para revisar recompensas” | No inventar café, descuento, vigencia o fecha. |
| QR | `globalId` | QR generado con `qrcode`; ID legible y texto de uso | Mostrar ID y explicar que el código se habilita al cargar | No afirmar autenticación ni presencia. |
| Recompensas | `GET /v1/loyalty/rewards?active=true` | Nombre, descripción, costo, stock/imagen si vienen | “No hay recompensas disponibles” | No mostrar recompensas vencidas o agotadas como canjeables. |
| Canje | `POST /v1/loyalty/rewards/redeem` | Confirmar solo con respuesta 201 y `balance_after` | Error con siguiente paso | No mostrar éxito por click optimista. |
| Transacciones | `GET /v1/loyalty/points/transactions` | Tipo, puntos, saldo posterior y fecha | Empty state real | No inventar actividad ni convertir eventos técnicos en mensajes de marketing. |
| Consentimientos | `consents` en DB; falta la ruta de actualización visible | Casilla independiente, inicialmente `false`; persistir solo con contrato aprobado | Mostrar control deshabilitado con explicación de indisponibilidad, nunca fingir guardado | No marcar por defecto ni agrupar marketing con servicio. |
| Billetera/proveedor | No existe ciclo de vida en el customer-web | Solo texto “La integración con billeteras estará disponible más adelante” si se necesita | Omitir la sección | No ofrecer emisión, agregar a la billetera o sincronización instantánea. |

---

## 7. Etapas de implementación

### Etapa 0 — Baseline y contrato visual

**Resultado visible:** baseline reproducible y marco con tokens compartidos, sin cambiar la arquitectura de las rutas ni introducir una nueva narrativa de producto.

**Alcance de usuario:** cambios de superficie, tipografía, foco, estados base y espaciado consistente. El texto y la composición de las rutas permanecen iguales hasta la etapa 1.

**Archivos probables:**

- `apps/customer-web/app/layout.tsx`
- `apps/customer-web/app/globals.css`
- `packages/design-system/src/tokens/colors.css` — solo si se decide compartir el contrato con otras aplicaciones; por defecto no se modifica.
- `packages/design-system/src/components/*` — solo si una primitiva existente impide cumplir el contrato; no crear una biblioteca paralela.
- `apps/customer-web/app/components/` — **ruta nueva propuesta**, actualmente inexistente; aquí pueden vivir `club-status.tsx`, `club-empty-state.tsx` y `club-shell.tsx`.

**Dependencias y precondiciones:**

- Capturar el estado actual antes de editar.
- Confirmar que `packages/design-system` mantiene sus exportaciones actuales.
- No modificar el prototipo aprobado.

**Tareas:**

- Capturar `/`, `/register`, `/login`, `/profile` sin sesión y las vistas de error/alcance local en 390×844 y 1440×1000.
- Inventariar colores, radios, espaciado, superficies, anillo de foco y estados ya usados.
- Definir alias semánticos `club-*` en el ámbito de customer-web, usando primero los tokens del sistema de diseño.
- Decidir si se mantiene `Inter` y se usa `system-ui` como respaldo para display; no agregar paquetes de fuente.
- Extraer solo estados compartidos que se reutilicen en al menos dos rutas: carga, vacío, error, enlace de regreso y marco de página.
- Mantener `lucide-react` como familia de iconos; no mezclar otra.
- Preparar una lista de verificación de movimiento reducido, foco visible, contraste y área segura.

**Datos/API y errores:**

- No cambia endpoints ni datos.
- El baseline debe distinguir la carga del error y no convertir una API no disponible en contenido de ejemplo.
- La documentación de contrato debe registrar qué campos no están disponibles todavía.

**Aceptación de adaptación y accesibilidad:**

- Zoom 200% sin bloqueo; el ajuste de `maximumScale` queda registrado para etapa 6, pero la etapa 0 no reintroduce una restricción.
- Foco visible en cualquier control, sin `outline: none` sin reemplazo.
- Contraste AA en texto, placeholder, borde de control y CTA.
- `prefers-reduced-motion` no elimina información ni estados.
- Layout sin overflow horizontal a 320 px.

**Verificación exacta:**

```bash
pnpm --filter @vyloop/customer-web lint
pnpm --filter @vyloop/customer-web typecheck
pnpm --filter @vyloop/customer-web test
pnpm --filter @vyloop/customer-web dev
```

En navegador: `http://localhost:3001/`, `/register`, `/login` y `/profile` sin sesión, en 390×844 y 1440×1000. El servidor se ejecuta en una terminal separada; no cerrar el proceso al terminar la revisión.

**Puerta de aprobación visual:** el usuario revisará el baseline antes/después, la muestra de tokens, el anillo de foco, la escala tipográfica, el espaciado, los radios, la densidad y el comportamiento de carga/error. No se evalúa todavía la propuesta de portada.

**Rollback:** revertir solo `layout.tsx`, `globals.css` y los nuevos componentes compartidos; no tocar rutas, API ni prototipo.

**Riesgo y líneas:** bajo a medio, 150–260 líneas. Riesgo principal: mezclar tokens nuevos con estilos existentes y producir una segunda escala visual.

**Fuera de alcance:** cambiar `/`, reescribir formularios, cambiar APIs, agregar billeteras, modificar el sistema de diseño global o corregir el prototipo.

---

### Etapa 1 — Bienvenida / entrada sin instalación

**Resultado visible:** `/` deja de ser una tarjeta genérica y explica en una pantalla clara qué gana una persona al entrar al programa, cómo escanea el QR del comercio y qué puede hacer desde cero, sin prometer una app o una billetera disponible.

**Alcance de usuario:** nueva portada de entrada con un hero editorial de club de barrio, explicación de QR, valor real del programa y CTAs `Ingresar` / `Registrarme`. La redirección de sesión autenticada a `/profile` se conserva.

**Archivos probables:**

- `apps/customer-web/app/page.tsx`
- `apps/customer-web/app/globals.css`
- `apps/customer-web/app/components/club-shell.tsx` — nuevo propuesto; no existe actualmente
- `apps/customer-web/app/components/club-qr-explainer.tsx` — nuevo propuesto; no existe actualmente

**Dependencias y precondiciones:**

- Etapa 0 aprobada.
- No depender de una API nueva para el primer render.
- Si existe `?biz=...`, conservar el contexto solo como parámetro de navegación; no inventar el nombre visible del tenant.

**Tareas:**

- Reemplazar la tarjeta por una composición dividida o asimétrica aprobada: texto/acción a la izquierda y explicación visual del QR a la derecha en escritorio; una columna en móvil.
- Escribir una propuesta de valor neutra: acumular progreso y revisar recompensas del programa, sin afirmar una recompensa concreta no configurada.
- Mostrar un diagrama estático de “escanea → regístrate → muestra tu código”, con iconos semánticos y texto equivalente.
- Mantener `Ingresar` y `Registrarme` como únicas acciones principales; no agregar “Descargar aplicación” ni CTA de billetera.
- Mostrar el programa/tenant solo si hay contexto real disponible; en la portada raíz usar texto genérico seguro.
- Mantener el estado de carga de sesión, sin parpadeo de contenido ni tarjetas de características genéricas.
- Usar `Button`/`Link` y estados existentes de hover, foco, pulsación y deshabilitado.

**Datos/API y errores:**

- `useAuth` sigue siendo la única fuente de estado de sesión.
- Sin sesión: mostrar la portada. Con sesión: mantener `router.replace('/profile')`.
- Carga: esqueleto o estado equivalente, con el texto “Cargando…”.
- API de negocio no disponible: la portada no debe mostrar datos ficticios; puede presentar el flujo genérico de entrada.

**Aceptación de adaptación y accesibilidad:**

- El hero y ambos CTAs son visibles en el viewport inicial de 390×844 y 1440×1000.
- Titular de máximo dos líneas en escritorio y sin desbordamiento en 320 px.
- Cada enlace tiene destino, nombre accesible y foco visible; el diagrama no es la única explicación.
- Las imágenes o ilustraciones tienen dimensiones reservadas; si son decorativas, `alt=""` y `aria-hidden="true"` donde corresponda.
- No hay autoFocus, scroll horizontal ni CTA duplicados con la misma intención.

**Verificación exacta:**

```bash
pnpm --filter @vyloop/customer-web lint
pnpm --filter @vyloop/customer-web typecheck
pnpm --filter @vyloop/customer-web test
pnpm --filter @vyloop/customer-web dev
```

**Escenarios de navegador:**

- Móvil 390×844: `/` sin sesión; verificar valor, explicación QR, CTAs, foco por teclado y ausencia de desbordamiento.
- Escritorio 1440×1000: `/` sin sesión; verificar jerarquía, primera pantalla, alineación de QR y CTAs.
- Con sesión válida: confirmar redirección a `/profile` sin mostrar brevemente contenido incorrecto.
- Con `?biz=demo-shop`: confirmar que el contexto no produce nombres inventados.

**Puerta de aprobación visual:** el usuario revisará la portada en móvil y escritorio, la primera lectura del valor, la explicación de cero instalación, el peso de los CTAs, la dirección `club-barrio` y la ausencia de afirmaciones falsas. Esta es la primera puerta de aprobación.

**Rollback:** revertir `app/page.tsx`, `globals.css` y los componentes de portada; no revertir autenticación, marco base ni datos.

**Riesgo y líneas:** medio, 180–280 líneas. Riesgo principal: volver a una página de marketing genérica o convertir el QR en una promesa de billetera.

**Fuera de alcance:** registro, login, perfil, contrato de API, emisión de billetera, fotografía de proveedor, analítica y cambios en el panel.

---

### Etapa 2 — Registro y consentimiento explícito

**Resultado visible:** `/register` se convierte en un flujo corto, con contexto del comercio/programa, campos esenciales y consentimientos separados, todos inicialmente desmarcados.

**Alcance de usuario:** nombre y teléfono como campos principales; email y fecha de nacimiento solo como opcionales si el producto los mantiene. Se agregan tres controles separados: servicio por WhatsApp, promociones y avisos cercanos. La explicación de QR y programa se mantiene breve.

**Archivos probables:**

- `apps/customer-web/app/register/page.tsx`
- `apps/customer-web/app/lib/api.ts`
- `apps/customer-web/app/globals.css`
- `apps/customer-web/app/components/form-field.tsx` — nuevo propuesto; no existe actualmente
- `apps/customer-web/app/components/consent-list.tsx` — nuevo propuesto; no existe actualmente
- `workers/customer/src/routes.ts` — **corrección aditiva condicional** para persistir consentimientos en `PUT /v1/customers`
- `workers/customer/src/index.test.ts` — tests de contrato, si se aprueba la corrección

**Dependencias y precondiciones:**

- Etapa 1 aprobada.
- Confirmar con backend si `businessSlug` identifica un tenant válido y si el programa tiene una recompensa de bienvenida real.
- No mostrar una recompensa de bienvenida hasta que el programa la configure y la pueda explicar.

**Tareas:**

- Reemplazar estilos en línea por clases globales o componentes compartidos.
- Mantener `PUT /v1/customers` y `POST /v1/auth/customer/token`; no cambiar nombres de campos existentes.
- Extraer `businessSlug` de forma segura en cliente, preservándolo en la navegación y en el login posterior.
- Mostrar nombre del negocio y programa únicamente desde un contexto de API aprobado; si no existe, usar “este programa” como texto de respaldo.
- Reducir la primera vista a nombre y teléfono; mantener email/fecha en una sección opcional claramente separada.
- Agregar `name`, `type`, `inputMode`, `autoComplete`, etiquetas, textos de ayuda y errores en línea.
- Agregar casillas independientes, con `checked={false}` inicial, etiquetas descriptivas y texto de estado `Desactivado`.
- No agrupar WhatsApp de servicio, marketing y geocerca en un único consentimiento.
- Mostrar carga, error de validación, error de tenant, error de red y éxito de inicio de sesión automático.
- Si el backend no acepta consentimientos en esta etapa, mostrar el control como no disponible en vez de fingir persistencia.

**Contrato mínimo propuesto, sujeto a aprobación:**

- `PUT /v1/customers` puede aceptar `consents: { serviceWhatsapp: boolean; promotions: boolean; nearbyNotifications: boolean }` opcional.
- El backend persiste cada propósito en la tabla existente `consents`, con `granted`, timestamps y `businessId`/`customerId`; no se requiere una nueva tabla para esta primera corrección.
- La respuesta sigue siendo compatible con el registro actual.
- La evidencia de política/jurisdicción completa queda como trabajo de cumplimiento separado; la UI no la promete.

**Datos/API y errores:**

- Nombre y teléfono siguen siendo obligatorios.
- `businessSlug` ausente: no se debe inventar tenant; mostrar estado de contexto faltante y permitir volver al inicio.
- Tenant inexistente: error 404 con siguiente paso, sin enviar datos a otro tenant.
- Error 4xx: conservar mensaje del servidor solo cuando sea seguro y útil; ante error desconocido usar texto neutral con acción “Intentar de nuevo”.
- `loginCustomer` se mantiene como inicio de sesión automático; si falla después de crear el cliente, informar que la cuenta fue creada pero el ingreso no se pudo completar, sin repetir registro destructivamente.

**Aceptación de adaptación y accesibilidad:**

- Campos en una columna a 390×844, sin saltos ni campos ocultos.
- Etiquetas visibles arriba, error debajo y foco en el primer error tras el envío.
- La casilla completa es un objetivo de 44 px; no usar una casilla pequeña con zona muerta.
- `aria-describedby`, `aria-invalid` y estado de carga correctos; mensajes de estado con `aria-live="polite"` cuando corresponda.
- Objetivo táctil mínimo de 44 px en botones y consentimientos.

**Verificación exacta:**

```bash
pnpm --filter @vyloop/customer-web lint
pnpm --filter @vyloop/customer-web typecheck
pnpm --filter @vyloop/customer-web test
pnpm --filter @vyloop/customer-web dev
```

Si se toca el contrato backend:

```bash
pnpm --filter @vyloop/customer lint
pnpm --filter @vyloop/customer typecheck
pnpm --filter @vyloop/customer test
```

**Escenarios de navegador:**

- Móvil 390×844: `/register?biz=demo-shop`; completar solo nombre/teléfono, enviar, verificar que los tres consentimientos nacen desmarcados.
- Escritorio 1440×1000: misma ruta; verificar que el formulario no se estira, que el contexto del programa tiene jerarquía y que la acción primaria no se parte.
- Envío vacío: foco en nombre, error de teléfono y ninguna solicitud de registro.
- Tenant inexistente: estado 404 legible y sin caída de página.
- Backend caído: estado de error con reintento; tras recargar, el formulario conserva solo datos permitidos por la política.

**Puerta de aprobación visual:** el usuario revisará la longitud real del formulario, la separación de consentimientos, el contexto del comercio, los estados desmarcados, la jerarquía del CTA y la continuidad con `/` en móvil y escritorio.

**Rollback:** revertir la página, estilos y `lib/api.ts`; si se aprobó la corrección backend, revertir su commit separado sin afectar endpoints de lectura existentes.

**Riesgo y líneas:** medio-alto, 260–430 líneas. Riesgo principal: mostrar consentimiento persistido cuando el contrato todavía no existe o duplicar clientes por una normalización de teléfono incompatible.

**Fuera de alcance:** OTP, términos legales completos, geolocalización real, notificaciones, Google Wallet/Apple Wallet, cambio del esquema de consentimientos y nuevos beneficios.

---

### Etapa 3 — Ingreso coherente

**Resultado visible:** `/login` se siente parte de la misma experiencia de entrada, explica el contexto mínimo y mantiene el login por teléfono existente.

**Alcance de usuario:** formulario de teléfono, acción primaria `Ingresar`, enlace a registro y estados de error/carga. No `autoFocus` en móvil ni acceso innecesario a otros campos.

**Archivos probables:**

- `apps/customer-web/app/login/page.tsx`
- `apps/customer-web/app/lib/auth.tsx` — solo si se requiere aceptar explícitamente el contexto de query sin cambiar el contrato
- `apps/customer-web/app/globals.css`

**Dependencias y precondiciones:**

- Etapa 2 aprobada.
- `api.loginCustomer(phone, businessSlug?)` y el token actual se conservan.
- No se agrega OTP en esta etapa.

**Tareas:**

- Reutilizar el marco, campo y botón, además de los estados de la etapa 2.
- Eliminar `autoFocus`.
- Mantener la normalización existente de teléfono, pero documentar y probar `+56`, espacios y guiones.
- Leer `businessSlug` de la URL si existe y pasarlo a `login`; no mostrar el slug como nombre de comercio.
- Mantener el error por número no registrado y diferenciar el error de red.
- Cambiar `...` por `…` en estados visibles y en la carga accesible.
- Mantener la redirección exitosa a `/profile`.
- En escritorio se puede seguir el foco natural al cargar la página; en móvil no se fuerza el foco ni se abre el teclado.

**Datos/API y errores:**

- Se mantiene `POST /v1/auth/customer/token`.
- Teléfono vacío: validación local, sin solicitud.
- Teléfono no registrado: texto actual o equivalente neutral, con enlace a registro.
- Backend caído: error accionable y botón habilitado de nuevo.
- Token existente: el guard de las rutas protegidas conserva su comportamiento.

**Aceptación de adaptación y accesibilidad:**

- El formulario mantiene una sola columna y un CTA visible.
- `label`, `name`, `type="tel"`, `inputMode="tel"` y `autoComplete="tel"` presentes.
- Error asociado al campo y foco visible en teclado.
- Sin `autoFocus`, sin zoom bloqueado y sin una disposición dependiente de `100vh`.

**Verificación exacta:**

```bash
pnpm --filter @vyloop/customer-web lint
pnpm --filter @vyloop/customer-web typecheck
pnpm --filter @vyloop/customer-web test
pnpm --filter @vyloop/customer-web dev
```

**Escenarios de navegador:**

- Móvil 390×844: `/login`; confirmar que el teclado no se abre automáticamente, que el formulario es usable y que el botón tiene un objetivo suficiente.
- Escritorio 1440×1000: `/login`; confirmar continuidad con la portada y alineación del bloque.
- `/login?biz=demo-shop`: confirmar que el contexto se pasa al contrato de login sin inventar nombre.
- Teléfono inválido, no registrado y backend caído: verificar un estado por caso y recuperación sin doble envío.

**Puerta de aprobación visual:** el usuario revisará que login se perciba como la continuación de la portada, la jerarquía del campo, el CTA, la ausencia de autoFocus y los estados de error.

**Rollback:** revertir solo `login/page.tsx` y el ajuste de `auth.tsx`; conservar las primitivas compartidas.

**Riesgo y líneas:** bajo-medio, 140–220 líneas. Riesgo principal: cambiar el alcance del token o romper la selección de tenant.

**Fuera de alcance:** OTP, passkeys, recuperación de contraseña nueva, login social, emisión de billetera y cambios en el backend de autenticación.

---

### Etapa 4 — Perfil y pase web

**Resultado visible:** `/profile` se convierte en el pase web: saludo, tenant/programa real, saldo y progreso de una fila de sellos o variante de puntos, próxima recompensa si está soportada, ID legible, QR y accesos a recompensas/historial.

**Alcance de usuario:** reemplazo del perfil actual, manteniendo autenticación, logout, consentimiento de WhatsApp, QR y navegación existentes donde el backend los respalde.

**Archivos probables:**

- `apps/customer-web/app/profile/page.tsx`
- `apps/customer-web/app/lib/api.ts`
- `apps/customer-web/app/globals.css`
- `apps/customer-web/app/components/member-pass.tsx` — nuevo propuesto; no existe actualmente
- `apps/customer-web/app/components/stamp-progress.tsx` — nuevo propuesto; no existe actualmente
- `apps/customer-web/app/components/member-qr.tsx` — nuevo propuesto; no existe actualmente
- `workers/customer/src/routes.ts` — **contrato aditivo condicional** para proyección de programa/nivel y estado de consentimiento
- `workers/customer/src/index.test.ts` — tests de contrato, si se modifica backend

**Dependencias y precondiciones:**

- Etapa 3 aprobada.
- Confirmar que `GET /v1/customers/me` está protegido por tenant y que el token de cliente tiene acceso a la proyección necesaria.
- No mostrar una recompensa o `8/10` hasta que el programa exponga una regla real.
- Resolver antes la ruta de consentimiento; si no existe, no exponer un interruptor que parezca guardar.

**Tareas:**

- Eliminar `TIER_CONFIG`, umbrales, emojis de nivel y afirmaciones de “cliente más valioso”.
- Crear una función de presentación que reciba el perfil y una progresión canónica, sin mezclar valores de negocio por defecto en el componente.
- Usar el perfil real para nombre, puntos, nivel y actividad; no mostrar un saldo de demostración.
- Derivar progreso únicamente de:
  - `points` y `currentTierId` más umbrales del tenant; o
  - una proyección explícita `stampsCompleted/stampsTotal` si existe.
- Si no existe regla de sellos, usar una variante de puntos y un texto explicativo neutral.
- Mostrar `memberId` legible derivado de `globalId` o el identificador real disponible; no fabricar un formato comercial tipo `OR-0428-17`.
- Mantener QR real generado desde `/c/${globalId}` o el identificador seguro que el backend autorice; agregar texto alternativo legible.
- Mantener la sesión de WhatsApp solo cuando el endpoint de consentimientos esté confirmado; si no, quitarla o mostrarla deshabilitada con explicación.
- Separar el pase de la actividad reciente, recompensas e historial; no convertir cada sección en una tarjeta genérica.
- No añadir CTA de Apple Wallet o Google Wallet. Si se incluye una mención de futuro, usar texto deshabilitado y explícito: “La conexión con billeteras estará disponible más adelante”.

**Contrato mínimo propuesto, sujeto a aprobación:**

- Agregar a `GET /v1/customers/me` campos aditivos como `business`, `program`, `tiers`, `nextTier` y `consents` sin eliminar ni renombrar campos actuales.
- Si el worker no puede consultar el programa desde el contexto de cliente, crear una proyección segura para clientes; no exponer endpoints de operador sin validar alcances.
- Crear o corregir `PUT /v1/customers/me/consent` con autenticación y tenant, upsert por propósito y `granted` real. La UI no debe llamar un endpoint inexistente.

**Datos/API y errores:**

- Carga: esqueleto del pase, progreso, QR y actividad.
- Sin sesión: redirección a `/login` sin revelar perfil.
- Error de perfil: error contextual con reintento; no usar un perfil de respaldo con nombre o nivel inventados.
- Perfil sin nivel: “Tu progreso actual” y saldo real, no Bronce implícito.
- Perfil sin nivel siguiente: estado de progreso completo solo si la API realmente lo indica; si no, “Tu programa está configurándose”.
- QR no generado: mantener ID legible y texto de reintento; no convertir el fallo en un código falso.
- Consentimiento: carga del interruptor, reversión ante error del servidor y anuncio del resultado.

**Aceptación de adaptación y accesibilidad:**

- El pase es el foco principal en escritorio y móvil; no se presenta como una tabla de métricas.
- La fila de sellos tiene texto equivalente, estado `aria-label` y contraste suficiente.
- QR tiene `alt` descriptivo, dimensiones fijas y texto alternativo.
- Timeline usa listas semánticas, `min-width: 0` y números tabulares; no solo color para ganar/perder puntos.
- Foco visible en apertura del QR, interruptor, enlaces, reintento y cierre de sesión.
- Sin animaciones excesivas, `autoFocus`, gradientes que oculten texto ni contenido que dependa de hover.

**Verificación exacta:**

```bash
pnpm --filter @vyloop/customer-web lint
pnpm --filter @vyloop/customer-web typecheck
pnpm --filter @vyloop/customer-web test
pnpm --filter @vyloop/customer-web dev
```

Si se toca el contrato backend:

```bash
pnpm --filter @vyloop/customer lint
pnpm --filter @vyloop/customer typecheck
pnpm --filter @vyloop/customer test
```

**Escenarios de navegador:**

- Móvil 390×844: sesión válida con tenant `demo-shop`; verificar saldo real, nivel real, progreso, ID de miembro, apertura del QR y navegación.
- Escritorio 1440×1000: sesión válida; verificar que el pase domina, que la actividad no compite y que el QR tiene texto alternativo legible.
- Cliente con cero puntos: estado vacío o progreso inicial honesto, sin “Oro” ni “8/10”.
- Error 401/404/500 de `/me`: retry visible y no exposición de otro tenant.
- Consentimiento activado y falla de persistencia: el interruptor vuelve al estado anterior y anuncia el error.
- Zoom 200%, teclado y movimiento reducido: revisar foco, scroll, animación y legibilidad.

**Puerta de aprobación visual:** el usuario revisará el pase, la derivación real del progreso, la fila de sellos o variante de puntos, el saldo, la próxima recompensa si existe, el ID de miembro, el QR, los estados de carga/vacío/error y la ausencia de emisión falsa.

**Rollback:** revertir `profile/page.tsx`, `lib/api.ts`, estilos y componentes nuevos; revertir el contrato backend en un commit separado. No revertir login/register porque comparten solo primitives visuales.

**Riesgo y líneas:** alto, 320–520 líneas. Riesgo principal: mostrar un progreso visualmente atractivo pero no autoritativo, o abrir un endpoint de Growth en el ámbito equivocado.

**Fuera de alcance:** Apple Wallet, Google Wallet, SDK de proveedor, códigos de barras nativos, POS, sellado por cajero, modificaciones de la base de datos y nueva fuente de saldo.

---

### Etapa 5 — Recompensas, canje e historial

**Resultado visible:** recompensas e historial dejan de ser pantallas aisladas y forman una segunda capa del mismo programa. El usuario ve saldo, costo, disponibilidad real, resultado del canje y movimientos reales.

**Alcance de usuario:** rediseño de `/profile/rewards`, `/profile/rewards/confirm` y `/profile/history`, conservando `getRewards`, `redeemReward` y `getTransactions`.

**Archivos probables:**

- `apps/customer-web/app/profile/rewards/page.tsx`
- `apps/customer-web/app/profile/rewards/confirm/page.tsx`
- `apps/customer-web/app/profile/history/page.tsx`
- `apps/customer-web/app/lib/api.ts`
- `apps/customer-web/app/globals.css`
- `apps/customer-web/app/components/reward-card.tsx` — nuevo propuesto; no existe actualmente
- `apps/customer-web/app/components/movement-list.tsx` — nuevo propuesto; no existe actualmente

**Dependencias y precondiciones:**

- Etapa 4 aprobada.
- El backend mantiene la respuesta paginada de transacciones y las recompensas activas.
- No se agrega un endpoint de canje nuevo; la autorización sigue siendo del backend.

**Tareas:**

- Reutilizar encabezado, enlace de regreso, estados de carga, vacío y error, botones y espaciado del perfil.
- Mostrar saldo actual junto al catálogo usando `api.getProfile()` ya disponible en la página.
- Mostrar nombre, descripción, costo, imagen y stock solo cuando la API los entregue.
- Resaltar `Canjear` solo si el saldo alcanza el costo; el servidor sigue siendo la autoridad final.
- Mostrar estados distintos para saldo insuficiente, sin stock, recompensa no disponible y error de red, sin inventar vigencia.
- Mantener el `reference_id` único generado por el canje; evitar doble clic y mostrar `Canjear…` durante la solicitud.
- En confirmación, usar los datos de la respuesta exitosa y no una recompensa hardcodeada; proteger el acceso directo sin datos.
- En historial, mantener filtros `Todos`, `Ganados`, `Canjeados`, con `aria-pressed` o pestañas accesibles, estado vacío por filtro y actualización deshabilitada durante la solicitud.
- Formatear fechas con `Intl.DateTimeFormat('es-CL', …)`; no usar strings de fecha fijos.
- No mostrar recompensas "agotadas" si `active=true` ya las excluye; si el producto necesita mostrarlas, eso requiere otro contrato.

**Datos/API y errores:**

- `GET /v1/loyalty/rewards?active=true` y `GET /v1/customers/me` en paralelo.
- `POST /v1/loyalty/rewards/redeem` conserva `customer_id`, `reward_id`, `points` y `reference_id`.
- 201: navegar a confirmación con `name`, `points` y `balance` como contexto no autoritativo; volver a cargar perfil si la UI necesita saldo actualizado.
- 409: mapear `INSUFFICIENT_POINTS`, `INSUFFICIENT_BALANCE`, `REWARD_OUT_OF_STOCK`, `REWARD_INACTIVE` a texto accionable.
- Error de red: conservar el catálogo visible si ya se cargó y marcar la acción como reintentable; no mostrar éxito.
- `getTransactions`: error de perfil/missing customer id devuelve instrucción de volver a `/profile`, no pantalla en blanco.

**Aceptación de adaptación y accesibilidad:**

- Catálogo en una columna móvil y cuadrícula de dos columnas solo en escritorio cuando el contenido lo justifique; no tres tarjetas iguales.
- Las tarjetas tienen encabezados, metadatos legibles e imagen con dimensiones; si la imagen falla, usar texto alternativo.
- Los botones mantienen 44 px de alto y no dependen del color para el estado deshabilitado o sin stock.
- Las pestañas y los filtros son navegables por teclado y anuncian su estado.
- Las listas de movimientos tienen estructura semántica, foco visible y texto completo para nombres largos.
- `aria-live` para error/éxito de canje; movimiento reducido para cualquier resaltado.

**Verificación exacta:**

```bash
pnpm --filter @vyloop/customer-web lint
pnpm --filter @vyloop/customer-web typecheck
pnpm --filter @vyloop/customer-web test
pnpm --filter @vyloop/customer-web dev
```

**Escenarios de navegador:**

- Móvil 390×844: recompensas con saldo suficiente, insuficiente, catálogo vacío y error de API; verificar que la acción refleja el estado real.
- Escritorio 1440×1000: mismo catálogo; verificar cuadrícula, imágenes, enlace de regreso y jerarquía del saldo.
- Canje exitoso: una sola solicitud, carga, confirmación y saldo actualizado.
- Doble clic durante el canje: no se duplica `reference_id` ni la recompensa.
- Historial: `Todos`, `Ganados`, `Canjeados`, estado vacío por filtro, actualización y error.
- Confirmación directa sin parámetros de consulta: redirección segura a recompensas, sin éxito falso.

**Puerta de aprobación visual:** el usuario revisará catálogo, saldo, estados de disponibilidad, botón de canje, confirmación, línea de tiempo, filtros, estados de carga/vacío/error y la coherencia con el pase.

**Rollback:** revertir las tres rutas, `lib/api.ts`, estilos y componentes de recompensa; conservar el perfil porque usa primitives compartidos.

**Riesgo y líneas:** medio-alto, 220–380 líneas. Riesgo principal: tratar saldo local como autorización o mostrar recompensas que el backend ya excluyó.

**Fuera de alcance:** reembolso, nuevos endpoints de catálogo, reglas de recompensas, pago dividido, canje en billetera, notificaciones y otorgamientos automáticos.

---

### Etapa 6 — Adaptación responsive, accesibilidad y consistencia

**Resultado visible:** todas las rutas funcionan como un sistema en móvil, tablet y escritorio, con teclado, zoom, contraste, movimiento reducido y estados de error consistentes.

**Alcance de usuario:** endurecimiento transversal. No se agrega una nueva función de negocio; se corrigen defectos de interacción, disposición y texto visible.

**Archivos probables:**

- `apps/customer-web/app/layout.tsx`
- `apps/customer-web/app/globals.css`
- `apps/customer-web/app/page.tsx`
- `apps/customer-web/app/register/page.tsx`
- `apps/customer-web/app/login/page.tsx`
- `apps/customer-web/app/profile/page.tsx`
- `apps/customer-web/app/profile/rewards/page.tsx`
- `apps/customer-web/app/profile/rewards/confirm/page.tsx`
- `apps/customer-web/app/profile/history/page.tsx`
- `apps/customer-web/app/not-found.tsx`
- `apps/customer-web/app/components/` — limpieza de componentes compartidos nuevos

**Dependencias y precondiciones:**

- Etapa 5 aprobada.
- Todas las rutas tienen al menos un estado de carga, vacío y error identificado.
- No cambiar el texto de negocio durante el endurecimiento salvo que el texto actual sea falso o inaccesible.

**Tareas:**

- Eliminar `maximumScale: 1` y confirmar zoom 200%/400% sin pérdida de contenido.
- Eliminar `autoFocus` restante, `transition: all`, `outline: none` sin reemplazo de foco y estilos en línea de estado que impidan usar tokens.
- Normalizar botones, enlaces, inputs, estados de carga, error, vacío y enlaces de regreso a las primitivas o envoltorios existentes.
- Auditar encabezados, etiquetas, `autocomplete`, `name`, `inputMode`, `spellCheck`, `aria-invalid`, `aria-describedby`, `aria-live` y `aria-pressed`.
- Verificar `alt`, width/height, `min-width: 0`, `text-wrap`, números tabulares y contenido largo.
- Agregar comportamiento de `prefers-reduced-motion` para pulso, fundido, animación de conteo, apertura del QR y cualquier resplandor.
- Verificar safe-area, `100dvh`, `touch-action: manipulation`, tap highlight y orden de tabulación.
- Eliminar duplicación de estilos y corregir reglas de layout que dependan de colores o radios arbitrarios.
- No introducir modo oscuro en esta etapa: la dirección aprobada y el prototipo son de tema claro; requiere una decisión y QA propios.

**Aceptación de adaptación y accesibilidad:**

- 320, 390, 768, 1024 y 1440 px sin desbordamiento horizontal ni saltos de foco.
- 44×44 px para acciones; zoom no bloqueado.
- Contraste AA para texto normal, etiquetas, textos de ayuda, errores y CTA; foco con contraste 3:1 o mejor.
- Navegación completa solo con teclado, sin trampas, superposiciones ni acordeones inaccesibles.
- Un mensaje de estado no desaparece antes de ser anunciado.
- No hay cambios de layout por imágenes, estados de carga o texto dinámico.

**Verificación exacta:**

```bash
pnpm --filter @vyloop/customer-web lint
pnpm --filter @vyloop/customer-web typecheck
pnpm --filter @vyloop/customer-web test
pnpm --filter @vyloop/customer-web dev
```

**Escenarios de navegador:**

- Móvil 390×844: recorrer `/`, `/register`, `/login`, sesión autenticada, `/profile`, recompensas, confirmación e historial; probar teclado virtual cuando aplique.
- Tablet 768×1024: verificar transición de una a dos columnas y que el CTA no se corte.
- Desktop 1440×1000: verificar ancho de lectura, alineación y que el contenido no dependa de hover.
- Browser zoom 200% y 400%: verificar que no se pierde CTA, etiquetas, errores o ID de miembro.
- `prefers-reduced-motion: reduce`: verificar que no hay movimiento, pulso ni resplandor.
- Teclado: Tab/Shift+Tab, Enter/Space, Escape donde aplique y foco visible en cada control.

**Puerta de aprobación visual:** el usuario revisará la coherencia final entre rutas, la lectura en ambos tamaños, la navegación por teclado, el contraste, el comportamiento de estados y la ausencia de regresiones de composición.

**Rollback:** revertir solo los archivos de endurecimiento de esta etapa; no revertir las etapas de producto ya aprobadas. Si una primitiva del sistema de diseño fue extendida, aislarla en un commit propio.

**Riesgo y líneas:** medio, 180–320 líneas. Riesgo principal: “limpiar” estilos y borrar accidentalmente estados funcionales o cambiar la composición aprobada.

**Fuera de alcance:** modo oscuro, nuevas rutas, analítica, service worker, manifest PWA, proveedor de billetera, rediseño del panel y cambios visuales no relacionados con customer-web.

---

### Etapa 7 — Verificación final y entrega

**Resultado visible:** no queda ninguna diferencia conocida entre lo aprobado, el código y el comportamiento del navegador. Se entregan evidencia reproducible, no una nueva interpretación visual.

**Alcance de usuario:** cierre de la experiencia existente. Solo se corrigen defectos bloqueantes encontrados durante la verificación; una nueva dirección visual obliga a volver a la etapa correspondiente.

**Archivos probables:**

- `docs/11-Customer-Web-Design-Implementation-Plan.md` — este documento, si se registra el resultado final.
- Archivos de implementación de las etapas 0–6 — solo si aparece un defecto aceptado.
- No se crean rutas de producto nuevas.

**Dependencias y precondiciones:**

- Todas las etapas anteriores tienen aprobación visual explícita.
- El servidor de customer-web y los servicios de API necesarios están disponibles.
- Se cuenta con al menos un tenant demo, un cliente con puntos y un cliente sin movimientos para revisar estados.

**Tareas:**

- Ejecutar lint, typecheck y tests del customer-web.
- Ejecutar `pnpm --filter @vyloop/customer-web build` porque el cambio final modifica rutas, CSS, viewport, metadatos y dependencias en ejecución; es justificado como puerta de entrega.
- Ejecutar lint/typecheck/test de cada worker solamente si su contrato fue cambiado.
- Revisar `/`, `/register`, `/login`, sesión inválida, perfil vacío, perfil con datos, recompensas, historial, 404 y confirmación.
- Capturar capturas de pantalla de escritorio y móvil de las rutas aprobadas.
- Revisar la consola del navegador, solicitudes fallidas, advertencias de hidratación, cambios de layout, desbordamiento, foco y movimiento reducido.
- Confirmar que no hay CTA de Apple Wallet/Google Wallet, afirmaciones de PWA, prueba social, Café Central, niveles o umbrales hardcodeados ni respaldo de datos falso.
- Registrar notas de reversión, archivos por unidad de trabajo, comandos ejecutados y escenario de runtime.
- Si aparece una regresión, revertir a la última etapa aprobada; no mezclar una corrección de backend con un rediseño visual sin una unidad de trabajo propia.

**Datos/API y errores:**

- Verificar 401/token vencido, 404 de tenant o cliente, 409 de recompensa o saldo insuficiente, 5xx y respuestas vacías.
- Confirmar que las operaciones exitosas se reflejan después de recargar, sin estado optimista falso.
- Confirmar que la API no filtra datos entre tenants en la experiencia visible.

**Aceptación de adaptación y accesibilidad:**

- Checklist completo de la etapa 6 aprobado.
- Lighthouse snapshot sin regresiones de accesibilidad, SEO o buenas prácticas; performance se reporta, no se maquilla.
- Walkthrough de teclado y zoom en cada ruta.
- Ningún estado de carga, vacío, error o éxito depende solo del color.

**Verificación exacta:**

```bash
pnpm --filter @vyloop/customer-web lint
pnpm --filter @vyloop/customer-web typecheck
pnpm --filter @vyloop/customer-web test
pnpm --filter @vyloop/customer-web build
pnpm --filter @vyloop/customer-web dev
```

Si hubo contrato backend, agregar según corresponda:

```bash
pnpm --filter @vyloop/customer lint
pnpm --filter @vyloop/customer typecheck
pnpm --filter @vyloop/customer test
```

**Escenarios de navegador:**

- Móvil 390×844 y escritorio 1440×1000 para todas las rutas y estados documentados.
- Login/registro con backend disponible y backend caído.
- Sesión con perfil vacío, saldo positivo, nivel máximo, recompensas activas, historial vacío y canje fallido.
- Revisión visual comparativa contra el prototipo aprobado, sin tratar el prototipo como captura nativa.

**Puerta de aprobación visual:** el usuario revisará el recorrido final, las capturas de pantalla antes/después de cada etapa aprobada, la matriz de estados y la lista de verificación de la definición de terminado. La aprobación final confirma que no queda trabajo visual oculto.

**Rollback:** revertir el último commit o unidad de trabajo aprobado; si el problema es backend, revertir el commit de contrato separado. No eliminar evidencia de verificación ni mezclar una reversión con una nueva etapa.

**Riesgo y líneas:** bajo, 0–120 líneas salvo defectos. Riesgo principal: aceptar la entrega sin haber probado el runtime con la configuración real.

**Fuera de alcance:** nuevas funcionalidades, ciclo de vida del proveedor, rediseño de otras aplicaciones, mejoras de backend no bloqueantes y commits o PRs automáticos.

---

## 8. Dependencias y riesgos

| Riesgo o dependencia | Impacto | Mitigación / gate | Responsable de decisión |
|---|---|---|---|
| No existe contexto público de tenant/programa para la portada y registro | Alto | Confirmar endpoint o aprobar corrección aditiva; usar texto genérico seguro mientras tanto | Producto + Backend |
| `PUT /v1/customers/me/consent` no está visible en el worker | Alto | No mostrar interruptor persistido; implementar/verificar endpoint antes de etapa 4 | Backend + Producto |
| No hay proyección de umbrales/siguiente nivel en `/me` | Alto | Crear un modelo de lectura seguro para clientes o extender `/me`; eliminar `TIER_CONFIG` igual en etapa 4 | Backend + Frontend |
| `getRewards` solo entrega recompensas activas | Medio | Mostrar solo lo que devuelve; no simular recompensas vencidas o sin stock | Frontend |
| Token de cliente sin acceso a endpoints de Growth | Alto | Validar alcances y gateway antes de usar `/v1/loyalty/tiers` o extender la proyección | Backend |
| La app se describe como PWA, pero no tiene manifest o service worker | Medio | No hacer afirmaciones de instalación; PWA es fuera de alcance | Producto |
| Cambiar el sistema de diseño global rompe el panel u otras superficies | Medio | Empezar con tokens de ámbito customer-web; extender el paquete solo con evidencia | Frontend |
| Duplicación de CSS y estilos en línea | Medio | Extraer solo componentes con segunda reutilización; medir diff por unidad de trabajo | Frontend |
| Texto de inscripción promete recompensas no configuradas | Alto | Tabla de verdad de datos + revisión de textos en cada puerta | Producto + Frontend |
| `qrcode` y `/c/{globalId}` no equivalen a autorización de compra | Alto | Mantener ID legible y texto prudente; no cambiar el contrato del QR en este plan | Producto + Backend |
| El cambio total supera 400 líneas | Alto | PRs encadenados y aprobación etapa por etapa | Revisión |
| No hay tests de customer-web actuales | Medio | Agregar tests de render, derivación y mocks de API en cada unidad de trabajo; `passWithNoTests` no es evidencia suficiente | Frontend |

---

## 9. Secuencia recomendada de commits y PRs

No crear commits todavía. Cada subject es una unidad de trabajo revisable:

1. `feat(customer-web): add club-barrio tokens and shared states`
2. `feat(customer-web): redesign welcome entry`
3. `feat(customer): persist explicit enrollment consent`
4. `feat(customer-web): redesign registration with consent controls`
5. `feat(customer-web): redesign login flow`
6. `feat(customer): expose customer loyalty program projection`
7. `feat(customer-web): redesign member pass`
8. `feat(customer-web): redesign rewards and history`
9. `fix(customer-web): harden responsive accessibility`
10. `test(customer-web): cover customer route states`

Los tests de una etapa deben viajar con su comportamiento, no en un commit final genérico. Si la secuencia necesita separar infraestructura de presentación, preferir el commit de contrato primero y el commit de UI que lo consume después.

### Cortes recomendados para PRs encadenados

- **Slice A:** etapas 0–1. Tokens, estados compartidos y portada.
- **Slice B:** etapas 2–3. Contrato de consentimiento, registro y login.
- **Slice C:** etapa 4. Proyección del programa y pase web.
- **Slice D:** etapa 5. Recompensas, canje e historial.
- **Slice E:** etapas 6–7. Endurecimiento, compilación y entrega.

Cada bloque debe incluir sus comandos, escenario de navegador, límite de reversión y evidencia de aprobación visual. Si un bloque supera 400 líneas, dividirlo una vez más por unidad de trabajo; no reducir el alcance eliminando tests, estados o accesibilidad.

---

## 10. Definición de terminado (DoD)

- [ ] Cada etapa tiene evidencia de lint, typecheck, test y runtime del navegador.
- [ ] Cada etapa tiene una puerta de aprobación visual explícita antes de comenzar la siguiente.
- [ ] `/` comunica valor, QR y entrada sin instalación sin afirmaciones falsas.
- [ ] `/register` tiene contexto seguro, formulario corto y consentimientos separados, desmarcados inicialmente.
- [ ] `/login` mantiene el contrato de autenticación y no usa `autoFocus`.
- [ ] `/profile` deriva saldo, nivel y progreso de datos reales; no contiene niveles ni umbrales hardcodeados.
- [ ] El pase web muestra ID de miembro, QR y texto alternativo legible sin llamarlo identidad ni presencia.
- [ ] No hay CTA o afirmaciones sobre Google Wallet/Apple Wallet.
- [ ] Recompensas, canje e historial muestran solo datos válidos y estados de carga, vacío, error y éxito.
- [ ] No hay afirmaciones de PWA instalable mientras no exista manifest o service worker.
- [ ] No hay `Café Central`, Bronce/Plata/Oro hardcodeado, prueba social inventada ni respaldo de negocio falso.
- [ ] La UI pasa navegación por teclado, foco visible, zoom 200%/400%, contraste AA, objetivos táctiles y movimiento reducido.
- [ ] `pnpm --filter @vyloop/customer-web lint`, `typecheck`, `test` y `build` pasan; los workers afectados también pasan sus verificaciones.
- [ ] No hay desbordamiento horizontal en 320, 390, 768, 1024 y 1440 px.
- [ ] No hay errores de consola, advertencias de hidratación ni solicitudes que revelen datos entre tenants en el recorrido.
- [ ] Capturas de escritorio/móvil, comandos ejecutados, resultados de ejecución y notas de reversión están registrados.
- [ ] La entrega no incluye un commit de emisión de billetera, un segundo registro ni una API falsa de reembolso.

---

## 11. `skill_resolution`

- `interface-design`: sistemas de producto, jerarquía, profundidad, motion y coherencia de superficies.
- `design-taste-frontend`: dirección `club-barrio`, rechazo de valores por defecto de páginas de entrada, composición asimétrica, texto honesto y verificación visual previa.
- `web-design-guidelines`: auditoría de etiquetas, foco, teclado, formularios, movimiento, imágenes, locale y estados.
- `vercel-react-best-practices`: límites cliente/servidor, eliminación de cascadas, memoización, rerenders y requisitos de compilación.
- `cognitive-doc-design`: estructura de decisión primero, tablas, divulgación progresiva y entrega fácil de revisar.
- `work-unit-commits`: cortes por comportamiento, tests junto al código, límites de reversión y umbral de 400 líneas.

**Estado de este documento:** plan de ejecución solamente. No autoriza por sí mismo la implementación de una etapa hasta que se confirme la aprobación visual de la etapa anterior.
