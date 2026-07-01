# Análisis Completo de FidelidApp — Plataforma de Fidelización

> **Fecha**: 29 de junio de 2026
> **Web**: https://www.fidelidapp.cl/
> **Propósito**: Levantamiento detallado de todas las funcionalidades para crear un producto competitivo mejorado.

---

## 1. DATOS GENERALES DE LA EMPRESA

| Dato | Valor |
|------|-------|
| **Nombre** | FidelidApp |
| **Eslogan** | "Plataforma de fidelización N°1 en Chile" |
| **Propuesta de valor** | "Vende más sin esforzarte tanto" |
| **Industria** | SaaS — Loyalty & Customer Engagement |
| **Mercado objetivo** | Pymes chilenas y latinoamericanas (restaurantes, cafeterías, clínicas, estéticas, bares, etc.) |
| **Público** | Negocios con operación local que buscan retener clientes sin invertir en apps nativas |
| **Clientes declarados** | 40k+ clientes (usuarios finales), 40+ negocios activos |
| **País** | Chile (Santiago) |
| **Contacto** | contacto@fidelidapp.cl / +56 9 9670 6983 |
| **Redes** | Instagram, LinkedIn |
| **Año** | © 2026 |

---

## 2. MODELO DE NEGOCIO

### 2.1 Propuesta de Valor Central

Plataforma SaaS que permite a cualquier negocio **implementar un programa de fidelización en minutos**, sin necesidad de desarrollar una app. El cliente final escanea un QR, accede a una landing personalizada y acumula puntos. El negocio obtiene un CRM, automatizaciones de marketing y reportes.

### 2.2 Flujo de Funcionamiento (3 pasos)

1. **Registro instantáneo**: El cliente escanea un QR en el local, entra por WhatsApp o desde la landing personalizada → queda automáticamente en el CRM.
2. **Compra y acumula puntos**: Cada compra suma puntos. El cliente accede a promociones, descuentos y premios definidos por el negocio.
3. **Automatización de retención**: Mensajes automáticos por WhatsApp y email, métricas de comportamiento, alertas para reactivar clientes inactivos.

### 2.3 Modelo de Ingresos

- **Suscripción mensual por sucursal**:
  - **Plan Gratis**: $0/mes (limitado a 250 clientes, 1 promoción, 1 agenda)
  - **Plan Premium**: $49.990 CLP/mes (~$55 USD) — funcionalidades ilimitadas
  - **Plan Negocio**: Desde $69.900 CLP/mes por sucursal (precio en landing)
- **Servicios adicionales** (precio a consultar):
  - Activación On Site
  - Campañas SMS
  - Gestión de Google y Meta Ads
  - Gestión de RRSS
  - Email Marketing Personalizado
  - Creación de Landing Page corporativa
  - Soporte 24/7

---

## 3. ARQUITECTURA DEL PRODUCTO

### 3.1 Tech Stack (inferido)

| Componente | Tecnología probable |
|------------|-------------------|
| **Frontend** | React / Next.js (SPA con dashboard) |
| **Email editor** | Unlayer (drag & drop editor embebido) |
| **Email delivery** | SendGrid (verificación de sender) |
| **PWA** | Progressive Web App para landing del cliente |
| **Google Wallet** | Google Wallet API (pases de fidelidad) |
| **WhatsApp** | WhatsApp Business API (Meta) |
| **Google Auth** | Google OAuth / Sign-In |
| **Hosting/Infra** | Probablemente Cloudflare o AWS |

### 3.2 Sistemas Integrados

| Integración | Estado |
|-------------|--------|
| Google Sign-In | ✅ Activo |
| SendGrid (Email) | ✅ Activo (requiere verificación) |
| WhatsApp Business API | ✅ Solo Premium |
| Google Wallet | ✅ Configurable |
| Google Calendar | ✅ Configurable |
| Medilink (software clínico) | ✅ Configurable |
| Shopify | ✅ Configurable |
| PWA + Push Notifications | ✅ Beta |

---

## 4. MAPA COMPLETO DE FUNCIONALIDADES

### 4.1 Landing Pública (https://www.fidelidapp.cl/)

- Hero: "Vende más sin esforzarte tanto"
- Features con mockups visuales
- Testimonios de clientes reales
- Tabla de planes y precios
- Formulario de contacto
- Llamados a la acción: "Empieza Gratis", "Ver Demo", "Agenda tu asesoría gratuita"
- Footer: Política de Privacidad, Términos y Condiciones, Programa de Integridad

### 4.2 Landing del Cliente (https://fidelidapp.cl/landing/{negocio})

Cada negocio tiene su propia landing page que es la cara del programa de fidelización:

- **Nombre del negocio** como título
- **Registro de cliente nuevo**:
  - Nombre completo (requerido)
  - Email (requerido)
  - Teléfono con selector de país (CL, AR, PE, CO, MX, BR, UY, PY, BO, EC, VE, US)
  - Fecha de nacimiento (opcional) — día/mes/año
- **Botón**: "Regístrate"
- **Login**: "¿Ya estás registrado? Iniciar sesión"
- **Secciones**:
  - Recompensas
  - Productos / Menú
- **Footer**: Política de Privacidad, Términos, "Powered by FidelidApp"
- **Personalizable**:
  - 50+ paletas de colores pre-diseñadas (por industria)
  - Paleta de colores personalizada
  - Logo, banner, imagen de fondo
  - Subtítulo del landing
  - Descripción del negocio
  - Integración con Google Business

### 4.3 Dashboard de Administración

#### 4.3.1 PRINCIPAL

##### Dashboard (Vista General)
- **Períodos**: Hoy, 7 días, 30 días
- **Métricas**:
  - Clientes Activos (vs período anterior)
  - Nuevos Registros (últimos 7 días)
  - Puntos Sumados (últimos 7 días)
- **Actividad en Vivo**: Timeline en tiempo real de todas las transacciones

🔍 **Oportunidades de mejora**:
  - Métricas planas sin proyección ni tendencia — agregar forecasting básico ("proyectado a fin de mes")
  - Sin tasa de conversión (visitas → registros) — métrica clave para medir efectividad del programa
  - Sin alertas inteligentes — ej: "10 clientes no vienen hace 60 días" en el mismo dashboard
  - Sin comparativa contra promedios de la industria (benchmarking)

###### Acción: Nuevo Cliente (Registrar un cliente)
- **Tipo**: Modal / Dialog
- **Título**: "Agregar Cliente"
- **Descripción**: "Registra un nuevo cliente directamente desde el dashboard."
- **Campos del formulario**:
  | Campo | Tipo | Requerido |
  |-------|------|:---------:|
  | Nombre | Texto | ✅ Sí |
  | Email | Email | ✅ Sí |
  | Teléfono | Texto (con sugerencia "+56...") | ❌ No |
  | Fecha de Nacimiento | Date picker (día / mes / año) | ❌ No |
- **Botones**: `Cancelar` | `Agregar Cliente`

🔍 **Oportunidades de mejora**:
  - Sin detección de duplicados antes de crear — podría validar email/teléfono existente en tiempo real
  - Sin autocompletado (Google/Apple autofill) — friction innecesaria en mobile
  - Sin campo de "origen" para tracking (¿quién registró? ¿desde dónde?)
  - Sin tags/etiquetas al crear el cliente — hay que ir a editar después
  - Sin validación de formato de teléfono por país — acepta cualquier cosa

###### Acción: Sumar Puntos (Asignar puntos manualmente)
- **Tipo**: Modal / Dialog
- **Título**: "Asignar Puntos"
- **Descripción**: "Buscá al cliente por su número, nombre o email"
- **Campo**: `Cliente` — buscador textual: "N° de cliente, nombre o email..."
- **Método de asignación** (selector con tabs):
  | Tab | Comportamiento |
  |-----|---------------|
  | **Por monto gastado** | Ingresás un monto en $ y el sistema calcula los puntos automáticamente según la configuración del programa (tasa de conversión) |
  | **Puntos directos** | Asignás una cantidad fija de puntos directamente, sin calcular por monto |
- **Botones**: `Cancelar` | `Asignar Puntos`

🔍 **Oportunidades de mejora**:
  - Sin asignación masiva (ej: "sumar 50 puntos a todos los clientes del segmento VIP")
  - Sin historial de asignaciones por operador — no se puede auditar quién dio puntos y por qué
  - Sin justificación/motivo obligatorio — previene malas prácticas
  - Sin previsualización del saldo del cliente antes de asignar
  - Sin integración POS para asignación automática desde la caja registradora

###### Acción: Código QR (Ver y descargar tu QR)
- **Tipo**: Dialog rápido desde el Dashboard que muestra ambos QR
- **Título**: "Códigos QR"
- **Descripción**: "QR de escaneo para sumar puntos y QR de landing page para compartir."
- Contiene acceso a los dos QR principales del negocio

🔍 **Oportunidades de mejora**:
  - Sin QR dinámicos con expiración — imposible hacer promociones temporales con QR
  - Sin QR por sucursal — mismo QR para todos los locales
  - Sin NFC como alternativa al QR — más rápido en punto de venta
  - Sin tracking por QR individual — no se sabe qué QR generó más registros
  - Sin QR para empleados (identificación para sistema de evaluación post-servicio)

##### Centro de Operaciones (Reportes)
- **Períodos**: Hoy, Ayer, Esta Semana, Este Mes, 7d, 30d, 90d, 180d, 360d, Personalizado
- **Secciones de reportes**:
  1. **¿Cómo va tu programa?**
     - Ingresos Estimados (basado en puntos acumulados)
     - Valor por Cliente (promedio estimado)
     - Total Clientes, Nuevos Registros, Clientes Activos
     - Gráfico de evolución (nuevos registros vs recurrentes)
  2. **¿Conoces a tus clientes?**
     - Segmentación por recencia de visita:
       - Visita reciente (0-30 días)
       - Hace 1-2 meses (30-60 días)
       - Hace 2-4 meses (60-120 días)
       - Sin visita reciente (120+ días)
     - Gráfico de distribución
  3. **¿Se usan los puntos?**
     - Puntos Otorgados (vs período anterior)
     - Canjes Realizados (vs período anterior)
     - Rating Equipo (valoraciones del personal)
     - Gráficos de puntos vs canjes
  4. **Canales de Comunicación**
     - Total de envíos
     - Estado de las campañas
- **Exportación**: PDF
- **Actualización**: Manual (botón Actualizar)

🔍 **Oportunidades de mejora**:
  - Datos estáticos sin exploración interactiva — no se puede hacer drill-down en los gráficos
  - Sin exportación a Excel/CSV — solo PDF limita el análisis externo
  - Sin reportes programados automáticos por email
  - Sin dashboard comparativo entre sucursales (útil para cadenas)
  - Sin métricas de retención (churn rate, lifetime value, customer equity)
  - Sin tasa de canje (porcentaje de puntos emitidos que se redimen) — es la KPI clave de engagement
  - Sin segmentación de cohortes para entender retención por período de registro

##### Promociones
- **Listado**: Tabla con título, descripción, vigencia, estado, tipo, frecuencia
- **Crear Programa** (limitado a 1 en plan free)
- **Detalle de promoción**:
  - Tipo: Puntos
  - Condiciones: Canje mínimo (ej. 100 puntos)
  - Validez de puntos: 365 días
  - Recompensas: Productos específicos con precio en puntos
  - Estado: Activa / Inactiva
  - Frecuencia: Recurrente
  - Enlace directo a landing
  - Compartir
- **Acciones**: Editar, activar/desactivar, eliminar

🔍 **Oportunidades de mejora**:
  - Sin A/B testing de promociones — no se puede comparar efectividad entre dos ofertas
  - Sin programación por tiempo limitado (fechas exactas de inicio/fin configurables)
  - Sin promociones automáticas por comportamiento — ej: "si no viene hace 30 días, regalar 50 puntos"
  - Sin límite de uso por cliente — evita abusos en promociones recurrentes
  - Sin notificación automática al crear promoción — avisar a todos los clientes elegibles
  - Sin reglas de canje combinadas — ej: puntos + dinero (como en programas de aerolíneas)

##### Clientes
- **Listado**:
  - Búsqueda por nombre o email
  - Filtro: Todos los clientes
  - Agregar cliente manualmente
  - Importar desde CSV
  - Exportar listado
  - Paginación
- **Segmentos** (`/dashboard/clients/segments`):
  - **Título**: "Crea y administra grupos de clientes basados en sus comportamientos y atributos."

🔍 **Oportunidades de mejora (Clientes)**:
  - Sin vista de perfil expandido del cliente (historial completo de compras, puntos, comunicaciones)
  - Sin acciones masivas sobre clientes seleccionados (enviar email, asignar puntos, mover a segmento)
  - Sin historial de comunicación por cliente (qué emails abrió, qué WhatsApp recibió)
  - Sin scoring o etiquetado automático (cliente VIP, en riesgo de fuga, inactivo)
  - Sin importación desde otras plataformas (Shopify, Mercado Shops, WooCommerce)
  - Sin vista de timeline individual por cliente
  - **Formulario de creación**:
    - **Nombre del Segmento** — campo de texto (placeholder: "Ej: Clientes VIP, Inactivos 30 días...")
    - **Dos métodos de creación**: tabs `Por Filtros` | `Manual`
  
  **Método 1: "Por Filtros"** — 4 categorías de criterios expandibles:
  
  1. **Datos Personales**:
     | Filtro | Tipo | Valores |
     |--------|------|---------|
     | Nombre | Texto | Búsqueda libre |
     | Email | Texto | Búsqueda libre |
     | Teléfono | Switch | Tiene teléfono (On/Off) |
     | Cumpleaños | Rango de fechas | Desde → Hasta (date picker) |
     | Género | Combobox | Todos / Femenino / Masculino |
  
  2. **Actividad y Segmentos**:
     | Filtro | Tipo | Valores |
     |--------|------|---------|
     | Sucursal | Combobox | Seleccionar sucursales |
     | Segmento anidado | Combobox | Seleccionar segmentos (permite combinar segmentos existentes) |
     | Tipo de Actividad | Combobox | Ninguna / Registro / Sumó Puntos / Canjeó Puntos / Canjeó Promoción / Evaluó el Servicio |
     | Inactividad | Nº días | "Sin actividad hace X días" (spinbutton) |
     | Rango de Puntos | Mín - Máx | Dos spinbuttons (rango de puntos acumulados) |
  
  3. **Fechas y Horarios**:
     | Filtro | Tipo | Valores |
     |--------|------|---------|
     | Horarios Disponibles | Combobox multi | 00:00 → 23:00 (franjas horarias) |
     | Fecha de Actividad | Rango de fechas | Desde → Hasta (date picker) |
     | Fecha de Registro | Rango de fechas | Desde → Hasta (date picker) |
  
  4. **Engagement de Email**:
     | Filtro | Tipo | Valores |
     |--------|------|---------|
     | Suscripción a Emails | Switch | Todos (On/Off — filtra suscritos vs no suscritos) |
     | Apertura Reciente | Nº días | "Abrió hace X días" (spinbutton) |
     | Inactividad de Email | Nº días | "No abrió hace X días" (spinbutton) |
     | Clics Recientes | Nº días | "Clickeó hace X días" (spinbutton) |
  
  - **Botones**: `Vista Previa` | `Resetear Filtros` | `Crear Segmento`
  
  **Método 2: "Manual"**:
  - Buscador textual: "Buscar por nombre o correo..."
  - Agregar clientes uno por uno a la lista del segmento
  - Botón: `Crear Segmento (N clientes)`
  
  **Limitaciones detectadas**:
  - No tiene operadores lógicos combinables (AND/OR entre criterios)
  - No tiene filtros por valor monetario (ej: clientes que gastaron más de $X)
  - No tiene segmentación por frecuencia de compra (ej: clientes que vinieron N veces)
  - No tiene filtros por canal de registro (QR vs WhatsApp vs landing)
  - No tiene segmentación predictiva (ej: "probabilidad de abandono")
  - Los segmentos anidados solo permiten seleccionar segmentos preexistentes, no son reglas compuestas
  - No hay temporizadores o expiración automática de segmentos dinámicos

##### Actividades
- **Tabs**: Actividades | Resumen
- **Tiempo Real**: Timeline de actividad
- **Filtros de búsqueda**
- **Conteo total de actividades**
- Tipos de actividad: compra, puntos, canjes, registros

#### 4.3.2 COMUNICACIÓN

##### Email Marketing
- **Subsecciones**: Campañas, Estadísticas, Crear Email, Plantillas
- **Editor**: Unlayer drag & drop (editor profesional embebido)
- **Variables dinámicas**: `{nombreCliente}`, `{puntosCliente}`, `{emailCliente}`
- **Límites**: 1.000 emails/mes (free) / 10.000/mes (Premium)
- **Verificación**: SendGrid (sender email verification)
- **Programación**: Fecha y hora de envío
- **Plantillas**: Guardadas + Galería pública de diseños profesionales
- **Asunto personalizable** con variables dinámicas
- **Subsección "Campañas"** (`/dashboard/email-campaign`):
  - Título: "Historial y gestión de tus campañas de email marketing"
  - Botón: `Nueva Campaña`
  - Listado de campañas con tabla (nombre, estado, fecha, métricas)
  - Estado vacío: "Aún no has enviado campañas"
- **Subsección "Estadísticas"** (`/dashboard/email-stats`):
  - Título: "Métricas consolidadas de tus campañas de email marketing"
  - Períodos: 7 días, 30 días, 90 días
  - Sección "Resumen": Métricas consolidadas del período
  - Sección "Tendencia": Gráfico de evolución de envíos, aperturas y clicks

🔍 **Oportunidades de mejora (Email Marketing)**:
  - Sin automatización de emails transaccionales (bienvenida automática al registrarse, cumpleaños, puntos por vencer)
  - Sin reporte individual por destinatario (quién abrió, quién hizo clic)
  - Sin pruebas A/B de asunto y contenido
  - Sin segmentación avanzada para envío (solo se puede enviar a "todos los clientes")
  - Sin re-engagement automático (si no abre 3 emails, cambiar frecuencia o canal)
  - Sin editor de fragmentos condicionales (mostrar contenido según si el cliente canjeó o no)

##### Notificaciones Push
- **Requisito**: PWA habilitada
- **Funcionalidad**: Notificaciones push a clientes con la PWA instalada
- **Estado**: Beta (recién integrada, puede tener bugs)

🔍 **Oportunidades de mejora**:
  - Dependen de PWA — sin app nativa, la entrega no es confiable (iOS no soporta push de PWA bien)
  - Sin segmentación por audiencia — se envían a todos los que tienen PWA o a nadie
  - Sin programación de campañas push
  - Sin analytics de clics en notificaciones
  - Solución: app nativa con Firebase Cloud Messaging o OneSignal para entrega garantizada

##### SMS Marketing
- **Estado**: En desarrollo (beta)
- **Métricas**: Clientes con número, campañas creadas, SMS enviados
- **Límite**: ∞ (ilimitado en plan free)
- **Formato**: Solo números válidos +569XXXXXXXX

🔍 **Oportunidades de mejora**:
  - Beta sin editor de templates ni personalización de mensajes
  - Sin programación de envíos
  - Sin analytics de entregabilidad (entregados vs fallidos vs respondedores)
  - Sin integración con servicios transaccionales (confirmación de registro, recordatorio de cumpleaños)
  - SMS ilimitados en plan free parece insostenible — probablemente es placeholder hasta que lo saquen de beta

##### Asistente WhatsApp
- **Estado**: Solo Premium
- **Tabs**: Conversaciones, Automatización, Smart Keys, Audiencia, Leads & Analytics, Conexión
- **Búsqueda de conversaciones**
- **Tags**: Todos, Potenciales, Agendados

🔍 **Oportunidades de mejora**:
  - Exclusivo de Premium — los negocios en plan free no tienen acceso a su canal más usado
  - Sin analytics por operador (quién atiende más, tiempos de respuesta, satisfacción)
  - Sin etiquetado personalizado de conversaciones (solo tags fijos: Potenciales, Agendados)
  - Sin integración con CRM del negocio (los leads quedan atrapados en la plataforma)
  - Sin respuestas rápidas/plantillas guardadas por el equipo

##### WhatsApp Oficial
- **Canal verificado Meta** (número oficial de WhatsApp Business)
- **Tabs**: Automatizaciones, Conexión, Conversaciones, Plantillas, Operadores

**1. Automatizaciones**
  - Switch On/Off del bot automatizado
  - Mensaje de bienvenida personalizable (texto libre)
  - Menú de opciones con respuestas personalizadas:
    - 📅 Agendar una cita (inicia flujo de agenda)
    - 🎁 Promociones (respuesta personalizada)
    - ❓ Preguntas frecuentes (respuesta personalizada)
    - 👤 Hablar con alguien (derivación a humano)
  - Botón: Guardar cambios

**2. Conexión**
  - **Estado de conexión**: Indicador visual (conectado/desconectado)
  - **QR de Conexión**: Código QR único para vincular el número de WhatsApp
  - **Instrucciones**: "Escanea el código QR desde WhatsApp > Dispositivos vinculados > Dispositivo nuevo"
  - **Número conectado**: Muestra el número de teléfono vinculado
  - **Botón**: `Desconectar`
  - QR se refresca automáticamente al expirar o desconectar

**3. Conversaciones**
  - Búsqueda de conversaciones por nombre o teléfono
  - Tags de filtro: Todos, Potenciales, Agendados
  - Listado de conversaciones activas

**4. Plantillas**
  - **Título**: "Plantillas de mensajes para WhatsApp aprobadas por Meta"
  - **Propósito**: Las plantillas son mensajes pre-aprobados que Meta debe revisar antes de su uso
  - **Campos**: Nombre de la plantilla, Idioma, Categoría, Contenido
  - **Botón**: `Crear Plantilla`
  - **Estado**: Sin plantillas aún (vacío por defecto en plan free)
  - **Nota**: Las plantillas son obligatorias para WhatsApp Business API — sin plantillas aprobadas, no se pueden enviar mensajes proactivos

**5. Operadores**
  - Gestión de agentes/operadores humanos para el canal de WhatsApp
  - Asignación de permisos de atención al cliente

🔍 **Oportunidades de mejora (WhatsApp Oficial)**:
  - Sin analytics de conversaciones (volumen, tiempo de respuesta, CSAT por conversación)
  - Sin chatbot con IA generativa (responde solo con menú fijo preconfigurado)
  - Sin flujos condicionales en el bot (siempre muestra el mismo menú, no se adapta al contexto)
  - Sin integración con el sistema de puntos desde el chat (el cliente no puede consultar su saldo por WhatsApp)
  - Sin derivación inteligente (no detecta intención del cliente, solo menú manual)
  - Las plantillas Meta requieren revisión manual — ralentiza la comunicación proactiva

##### Marketing Automatizado
- **Tipos**: Reglas Simples | Secuencias (Drip)
- **Estadísticas**: Clientes alcanzados, Emails enviados, WhatsApp enviados, Tasa de completado
- **Canales**: Email + WhatsApp
- **Objetivo**: Recuperar y activar clientes
- **Subsecciones**:
  - Automatizaciones
  - Encuestas
  - Reviews Google (invitación automática a dejar reseña)

##### Encuestas
- **Ubicación**: Marketing Automatizado → Encuestas
- **Título**: "Crea encuestas para conocer la opinión de tus clientes"
- **Propósito**: Recopilar feedback directo de los clientes sobre su experiencia
- **Sin encuestas creadas**: Mensaje de estado vacío "No hay encuestas aún"
- **Botón**: `Crear Encuesta`
- **Potencial no explotado**: Las encuestas son solo creación simple, sin NPS, CSAT, o analítica avanzada de respuestas

🔍 **Oportunidades de mejora**:
  - Sin NPS (Net Promoter Score) — métrica estándar de lealtad
  - Sin CSAT (Customer Satisfaction Score) — medir satisfacción post-servicio
  - Sin CES (Customer Effort Score) — medir qué tan fácil es usar el programa
  - Sin automatización de encuestas post-canje o post-visita
  - Sin analytics de respuestas abiertas con análisis de sentimiento
  - Sin reportes de tendencia de satisfacción en el tiempo

##### Reviews Google
- **Ubicación**: Marketing Automatizado → Reviews Google
- **Título**: "Incrementa tus reseñas en Google con invitaciones automáticas"
- **Descripción**: "Después de la valoración del servicio de un cliente, podés invitarlo automáticamente a que deje una reseña en Google"
- **Requisito**: Tener link de Google Reviews configurado (se configura en Ajustes → Redes Sociales)
- **Flujo**: Cliente evalúa servicio (5 estrellas) → invitación automática a Google Review
- **Potencial**: Automatización inteligente — solo clientes con alta valoración reciben invitación

🔍 **Oportunidades de mejora**:
  - Sin plantilla de invitación personalizable (mensaje fijo de Google)
  - Sin seguimiento de cuántas reseñas se generaron vs invitaciones enviadas
  - Sin incentivos automáticos (ej: "si dejás reseña, recibís 10 puntos extra")
  - Sin integración con otras plataformas (Mercado Libre, Yelp, TripAdvisor)

##### Anuncios
- **Ubicación**: Menú lateral → Anuncios
- **Estado**: Sección presente pero sin contenido visible en la cuenta demo (probablemente integración con Google Ads / Meta Ads como servicio gestionado)

#### 4.3.3 SERVICIOS

##### Evaluaciones (Personal)
- **Propósito**: Gestión de desempeño del equipo
- **Valoración**: Post-servicio (5 estrellas → invitar a review de Google)
- **Filtros**: 7 días, 15 días, 30 días, Todo
- **Gestión**: Nuevo Personal, buscar por nombre
- **Configuración de encuesta** (tab)

🔍 **Oportunidades de mejora**:
  - Solo rating de 5 estrellas — sin preguntas personalizadas por rol o servicio
  - Sin analytics por empleado (promedio, tendencia, comparativa con equipo)
  - Sin incentivos automáticos por buen rating (ej: "si llegás a 4.8, bonus automático")
  - Sin notificaciones al dueño cuando un rating es bajo (alerta en tiempo real)
  - Sin integración con agenda (evaluación post-cita automática)

##### Agendas (Reservas)
- **Vistas**: Semana, Mes, Día, Calendario, Listado
- **Acciones**: Exportar, Nueva acción, Hoy
- **Búsqueda**: Nombre o email
- **Navegación**: Calendario semanal con días
- **Estado**: "Sin citas para este día" / sin agendas configuradas

🔍 **Oportunidades de mejora**:
  - Sin cobro/pago al reservar (no se puede tomar seña o garantizar asistencia)
  - Sin recordatorios automáticos por WhatsApp/Email (reducción de no-shows)
  - Sin lista de espera automática (si se cancela, notificar al siguiente)
  - Sin disponibilidad sincronizada con Google Calendar/Outlook (integración bidireccional)
  - Sin límite de tiempo entre reservas (buffer para limpieza/preparación)
  - Sin personalización de duración por servicio (todo dura lo mismo por defecto)

##### Google Wallet
- **Funcionalidad**: Tarjetas de fidelidad en Google Wallet
- **Flujo**:
  1. El cliente muestra su tarjeta de Google Wallet
  2. El negocio escanea el código QR desde el dashboard
  3. Se suma 1 punto automáticamente
- **Tabs**: Escanear Wallet | Estadísticas
- **Escáner**: Cámara para leer QR de la tarjeta

🔍 **Oportunidades de mejora**:
  - Sin Apple Wallet — excluye ~50% del mercado mobile (iOS en US/JP)
  - Sin actualización automática de puntos en la tarjeta (la wallet no refleja el saldo actual)
  - Sin notificaciones push desde la wallet (Google Wallet lo soporta)
  - Sin pases por evento (tarjetas temporales para promociones)
  - El escaneo manual desde el dashboard es lento — idealmente NFC o actualización automática

##### Ajustes (Configuración)
1. **Mi Negocio**:
   - Nombre del negocio
   - Industria (selector)
   - Teléfono
   - Email remitente (SendGrid)
   - Marca: Logo (5 MB máx), Banner (10 MB máx), Imagen de fondo landing (10 MB máx)
   - Sucursales: Direcciones múltiples
   - Redes Sociales: Instagram, Facebook, WhatsApp, TikTok, Sitio web

2. **Programa de Fidelidad**:
   - Tipo de asignación: Automático / Manual
   - Puntos por escaneo: 1 (configurable)
   - Mínimo para canjear: 100 puntos (configurable)
   - Mostrar texto de puntos por compra (On/Off)
   - **Bonificaciones**:
     - Puntos por registro (On/Off)
     - Puntos por servicio (On/Off)
     - Promoción de cumpleaños (automática)
     - Fecha de cumpleaños obligatoria en registro (On/Off)
   - **Membresías**: Bronze, Silver, Platinum
     - Cálculo automático basado en actividad promedio
   - **Códigos QR**: Principal + adicionales
     - URL: https://fidelidapp.cl/landing/{negocio}
     - Regenerar QR

🔍 **Oportunidades de mejora (Programa de Fidelidad)**:
   - Sin multiplicadores por membresía (ej: Bronze 1x punto, Silver 2x, Platinum 3x)
   - Sin puntos por referidos (viral growth mecánico)
   - Sin cashback parcial (canje parcial en efectivo + puntos)
   - Sin expiración configurable por tipo de puntos (bonus vs acumulados)
   - Sin niveles/membresías personalizables (solo 3 fijos: Bronze, Silver, Platinum)
   - Sin reglas de caducidad notificables (aviso automático "tus puntos vencen en 7 días")

3. **Landing Page**:
   - Título (= nombre del negocio)
   - Subtítulo
   - **50+ paletas de colores** pre-diseñadas categorizadas:
     - Oscuras / Claras
     - Por industria: Tech, Sushi, Beauty, Vinos, Orgánico, Pastelerías, Noche, Spa, Cerveza, Arte, Moda, Librerías, Startups, Café, Música, Bienestar, Discotecas, etc.
     - Por negocio: Cafeterías, Clínicas, Restaurantes, Bares, Barberías, etc.
   - Paleta personalizada (colores propios)
   - Descripción del negocio
   - Google Business (búsqueda y link directo)

🔍 **Oportunidades de mejora (Landing Page)**:
   - Sin editor visual WYSIWYG completo (solo colores, no layout)
   - Sin preview mobile/desktop desde el editor
   - Sin dominio personalizado (ej: fidelidad.tuservicio.cl)
   - Sin multi-idioma en la landing (solo español chileno)
   - Sin analytics de landing (cuántas visitas, tasa de registro, bounce rate)
   - Sin tests A/B de landing para optimizar conversión de registro
   - Sin campos personalizables en el formulario de registro (solo nombre, email, teléfono, fecha nac.)

4. **Integraciones**:
   - **Medilink**: Para clínicas (sincroniza pacientes y pagos)
   - **Shopify**: Puntos por compras en tienda online (paso a paso: tienda → app → credenciales)
   - **Google Calendar**: Crear reuniones Meet automáticas desde WhatsApp
   - **PWA y Notificaciones Push**: App web progresiva + push notifications (On/Off)
   - **Google Wallet**: Tarjeta de fidelidad en Wallet (On/Off)

🔍 **Oportunidades de mejora (Integraciones)**:
   - Sin API pública / Webhooks — imposible integrar con sistemas externos no soportados
   - Sin Zapier / Make (Integromat) — el negocio no puede conectar con sus otras herramientas
   - Sin integración con Mercado Pago / Transbank / Flow (pagos chilenos)
   - Sin integración con POS locales (Pixel, iPos, Khipu, etc.)
   - Sin Open Graph / SDK para que otros desarrolladores extiendan la plataforma
   - Sing integración con herramientas de email masivo (Mailchimp, ActiveCampaign)

5. **Menu & Productos**:
   - **Categorías** de productos
   - **Productos** dentro de cada categoría
   - **Moneda**: $ (Peso) — configurable
   - Mostrar precios (On/Off)
   - Permitir pedidos (On/Off)
   - **FideliCard**: Tipo de tarjeta (Menú), título personalizable

🔍 **Oportunidades de mejora (Menu & Productos)**:
   - Sin fotos de productos (solo texto y precios)
   - Sin variantes de productos (tamaños, sabores, personalizaciones)
   - Sin inventario / stock — no se puede marcar "agotado"
   - Sin integración con el sistema de pedidos (no hay carrito ni checkout)
   - Sin importación desde Excel/CSV para carga masiva de productos
   - Sin QR por producto para que el cliente pueda ver info nutricional o detalles

6. **Suscripción**:
   - **Plan actual**: Gratis $0
   - **Premium**: $49.990/mes
   - Historial de pagos
   - Última verificación

##### Operadores (POS)
- **Propósito**: Punto de venta para registrar actividades
- **Acciones**: Nuevo operador
- **Permisos**: Acceso al punto de venta

##### Código QR
- **URL**: `/dashboard/qr/`
- **Título**: "Códigos QR y Visitas"
- **Descripción**: "Gestiona los QRs para que tus clientes suman puntos fácilmente"

**QR Principal**:
- **Puntos por escaneo**: 1 punto / escaneo (configurable desde Ajustes)
- **Gasto mínimo requerido**: $100
- **Botón**: `Descargar QR` (descarga la imagen del QR)
- **Flujo de uso**:
  1. Le mostrás el código QR a tu cliente
  2. El cliente escanea el código QR con su smartphone
  3. El sistema registra automáticamente la visita o los puntos
- **Recomendaciones**: Imprimirlo y colocarlo cerca de la caja o área de pago, buena iluminación sin reflejos, incentivar al equipo a recordar a los clientes que escaneen.
- **URL de la landing**: `https://fidelidapp.cl/landing/{nombre-del-negocio}`

**QRs Personalizados**:
- "Crea QRs únicos para promociones, eventos, o consumos específicos que otorgan diferentes puntajes."
- **Botones**: `Crear Nuevo QR` | `Crear Primer QR` (si está vacío)
- Sirven para asignar puntos específicos y llevar control diario de distintas dinámicas (ej: un QR para evento especial con más puntos, un QR para un producto específico)

**Botón de acceso rápido desde Dashboard**:
- Botón "Código QR → Ver y descargar tu QR"
- Abre un dialog con: "QR de escaneo para sumar puntos y QR de landing page para compartir."
- Es un acceso directo a la sección completa sin salir del dashboard**

🔍 **Oportunidades de mejora (QR)**:
  - Sin QR dinámicos configurables por tiempo (promociones flash, eventos de fin de semana)
  - Sin tracking por QR individual (no se sabe qué QR generó más actividad)
  - Sin QR por empleado (para evaluar desempeño individual por atención)
  - Sin NFC como alternativa al escaneo visual
  - Sin QR con expiración automática para eventos temporales
  - Sin métricas de escaneo (cuántos escaneos/día, picos horarios, tasa de conversión escaneo→registro)

---

## 5. FLUJO DEL CLIENTE (Customer Journey)

### 5.1 Touchpoints de registro
1. **QR en el local** (principal): El cliente escanea con su smartphone
2. **WhatsApp**: Entra por el chat de WhatsApp
3. **Landing**: Accede directamente desde la URL personalizada
4. **Google Wallet**: Si ya tiene la tarjeta guardada

### 5.2 Experiencia del Cliente
1. **Registro** → Formulario simple (nombre, email, teléfono, fecha de nacimiento opcional)
2. **Acumulación** → Escanea QR en cada visita → suma puntos automáticamente
3. **Canje** → Acumula puntos → canjea por productos/recompensas definidas
4. **Retención** → Recibe notificaciones push, emails, WhatsApp con promociones y recordatorios

### 5.3 Canales de comunicación con el cliente
| Canal | Automatizable | Requisito |
|-------|:----------:|-----------|
| Email Marketing | ✅ | SendGrid verificado |
| Notificaciones Push | ✅ | PWA habilitado |
| SMS | ✅ (beta) | Número válido |
| WhatsApp | ✅ | Plan Premium |
| WhatsApp Oficial (Meta) | ✅ | Canal verificado |

---

## 6. SISTEMA DE PUNTOS Y RECOMPENSAS

| Parámetro | Configuración |
|-----------|:------------:|
| Tipo de asignación | Automático / Manual |
| Puntos por escaneo | 1 (configurable) |
| Mínimo para canjear | 100 (configurable) |
| Validez de puntos | 365 días |
| Puntos por registro | ✅ Bonificación activable |
| Puntos por servicio | ✅ Bonificación activable |
| Puntos por cumpleaños | ✅ Automático al crear promoción |
| Mostrar texto informativo | ✅ Configurable |

### Membresías (Gamificación)
| Nivel | Cálculo |
|-------|---------|
| 🥉 Bronze | Automático según actividad |
| 🥈 Silver | Automático según actividad |
| 🏆 Platinum | Automático según actividad |

---

## 7. PLANES Y PRECIOS (COMPLETO)

### Plan Gratis — $0/mes
- 1 promoción activa
- 1 agenda activa
- Hasta 250 clientes
- Carga de Clientes por CSV
- Reportes y métricas básicas
- Soporte básico
- **Email**: 1.000/mes
- **SMS**: Ilimitado (beta)
- **WhatsApp**: No

### Plan Premium — $49.990 CLP/mes (~$55 USD)
- Promociones ilimitadas
- Agenda ilimitada
- ChatBot (Asistente WhatsApp)
- Segmentación de clientes
- Email marketing hasta 10.000 correos/mes
- Reportes generales y por promoción
- Evaluación y segmentación inicial
- Asistencia en implementación

### Plan Negocio — Desde $69.900/mes por sucursal
- Todo lo del plan Premium +
- Precio por sucursal adicional

---

## 8. DIFERENCIADORES COMPETITIVOS

1. **Sin app nativa**: Todo vía web (PWA + landing), sin que el cliente descargue nada
2. **QR como puerta de entrada**: Simple, físico, sin fricción
3. **WhatsApp como canal principal**: Asistente IA + WhatsApp Oficial + Marketing
4. **Landing personalizada por negocio**: Cada comercio tiene su propia mini-app
5. **Integración Google Wallet**: Tarjetas de fidelidad en el celular sin app del comercio
6. **50+ paletas de colores**: Personalización visual sin saber diseño
7. **Múltiples industrias**: Clínicas, restaurantes, cafeterías, estéticas, bares, talleres, etc.
8. **Precio agresivo**: Desde $0 con opción a $49.990 ($55 USD)
9. **Evaluación de personal**: Sistema de rating del equipo post-servicio
10. **Agenda online 24/7**: Integrada al sistema de fidelización

---

## 9. DEBILIDADES Y PLAN DE ACCIÓN PRIORIZADO

### 9.1 Debilidades detectadas

| Área | Problema |
|------|----------|
| **SMS Marketing** | En desarrollo (beta), incompleto |
| **Notificaciones Push** | Recién integradas, en beta con bugs |
| **Asistente WhatsApp** | Solo Premium, excluye a free users |
| **Segmentación** | Básica, sin operadores lógicos ni filtros por valor monetario |
| **Sin app nativa** | Dependencia total de PWA y web, sin Apple Wallet |
| **Personalización landing** | Paletas de colores, pero sin editor visual completo |
| **Sin e-commerce nativo** | Solo integración Shopify, sin carrito propio |
| **Sin multi-idioma** | Solo español (con variante chilena) |
| **Sin API pública** | No se detectó API abierta ni webhooks |
| **Free plan muy restrictivo** | 250 clientes, 1 promoción, 1 agenda |
| **Sin A/B testing** | No se detectó funcionalidad |
| **Sin NPS / CSAT** | Evaluación es solo del personal, no del programa |
| **Sin modo offline** | Dependencia total de conexión a internet |
| **Sin programa de referidos** | No se detectó funcionalidad de referidos |
| **Sin gamificación real** | Solo 3 niveles básicos basados en actividad |
| **Sin IA/ML** | Sin predicción de abandono, sin recomendaciones |
| **Sin webhooks/Zapier** | No conectable con el ecosistema SaaS del negocio |
| **Sin dashboard mobile** | No hay app para dueños |
| **Sin reportería avanzada** | Solo PDF, sin Excel/Sheets, sin programación |

### 9.2 Matriz de Acción Priorizada

> Cada oportunidad tiene: **Prioridad** (P0=P0, P1=Importante, P2=Nice-to-have), **Esfuerzo** (bajo/medio/alto), **Impacto** (bajo/medio/alto), **Dependencias** y **Resultado esperado**.

| # | Oportunidad | Prioridad | Esfuerzo | Impacto | Dependencias | Resultado esperado |
|---|-------------|-----------|----------|---------|--------------|-------------------|
| 1 | **Programa de referidos** (viral) | P0 | Medio | 🟢 Alto | Sistema de puntos existente | CAC ~$0, crecimiento orgánico 2-3x |
| 2 | **App nativa iOS + Android** | P0 | Alto | 🟢 Alto | Backend API, push FCM | Engagement 3x, notif. confiables, Apple Wallet |
| 3 | **NPS / CSAT integrado** | P0 | Bajo | 🟢 Alto | Encuestas existentes | Medir lealtad real, mejorar retención |
| 4 | **Multiplicadores por membresía** | P0 | Bajo | 🟢 Alto | Programa de fidelidad | Incentivar ascenso de nivel, más recurrencia |
| 5 | **Notificaciones push nativas** (FCM) | P0 | Medio | 🟢 Alto | App nativa | Delivery rate 90%+ vs 40% PWA |
| 6 | **Segmentación con operadores lógicos AND/OR** | P1 | Bajo | 🟢 Alto | Segmentos existentes | Campañas hiper-segmentadas, +30% conversión |
| 7 | **Chatbot con IA generativa** (WhatsApp) | P1 | Alto | 🟢 Alto | WhatsApp API, LLM | Atención 24/7, reduce carga operativa 60% |
| 8 | **API pública + Webhooks** | P1 | Alto | 🟢 Alto | Backend | Ecosistema de integraciones, Zapier, partners |
| 9 | **Multi-idioma** (PT, EN) | P1 | Medio | 🟢 Alto | Backend i18n | Escalar a Brasil, México, US Hispanic |
| 10 | **Gamificación avanzada** (streaks, badges, challenges) | P1 | Medio | 🟢 Alto | Programa de fidelidad | +40% visitas recurrentes |
| 11 | **Reportes exportables** (Excel, Google Sheets, CSV) | P1 | Bajo | 🟡 Medio | Centro Op. existente | Adopción en negocios data-driven |
| 12 | **Alertas inteligentes en dashboard** | P1 | Bajo | 🟡 Medio | Dashboard existente | Dueños accionan antes de perder clientes |
| 13 | **Automatización de emails transaccionales** (bienvenida, cumpleaños, puntos por vencer) | P1 | Medio | 🟡 Medio | Email marketing | Engagement continuo sin esfuerzo manual |
| 14 | **Recordatorios automáticos de agenda** (WhatsApp/Email) | P1 | Bajo | 🟡 Medio | Agenda + WhatsApp | Reducción de no-shows 30-50% |
| 15 | **Dashboard mobile para dueños** | P1 | Medio | 🟡 Medio | App nativa | Monitoreo desde cualquier lugar |
| 16 | **QR dinámicos con expiración** | P1 | Bajo | 🟡 Medio | QR existente | Promociones temporales sin riesgo |
| 17 | **Cashback parcial** (puntos + dinero) | P1 | Medio | 🟡 Medio | Sistema de puntos | Mayor tasa de canje, clientes más felices |
| 18 | **Dominio personalizado para landing** | P2 | Bajo | 🟡 Medio | Landing existente | Profesionalismo, branding del negocio |
| 19 | **Preview mobile/desktop en editor landing** | P2 | Bajo | 🟡 Medio | Landing editor | Mejor experiencia de diseño |
| 20 | **Pagos al reservar (seña online)** | P2 | Alto | 🟡 Medio | Agenda + pagos | Reducción de no-shows, flujo de caja |
| 21 | **Pruebas A/B en campañas email** | P2 | Medio | 🟡 Medio | Email marketing | Optimización continua de conversión |
| 22 | **Multi-sucursal con dashboard consolidado** | P2 | Alto | 🟡 Medio | Backend multi-tenant | Cadenas y franquicias como clientes |
| 23 | **E-commerce completo** (carrito + pagos) | P2 | Alto | 🔴 Bajo | Productos existentes | Nuevo vertical de ingresos |
| 24 | **Modo offline** (escaneo sin internet) | P2 | Medio | 🔴 Bajo | App nativa | Resuelve problema de conectividad |

### 9.3 Fases recomendadas

**Fase 1 — Quick Wins ($0-$5K effort, 1-2 semanas cada uno):**
- NPS/CSAT (integración sobre encuestas existentes)
- Multiplicadores por membresía
- Segmentación AND/OR
- Alertas inteligentes en dashboard
- QR dinámicos con expiración
- Reportes exportables (Excel/CSV)
- Recordatorios automáticos de agenda

**Fase 2 — Diferenciadores Core (2-4 semanas cada uno):**
- Programa de referidos
- Chatbot con IA en WhatsApp
- Automatización de emails transaccionales
- Multi-idioma (PT primero, EN después)
- Gamificación avanzada (streaks, badges)

**Fase 3 — Salto Competitivo (6-12 semanas):**
- App nativa iOS + Android + Apple Wallet
- API pública + Webhooks + Zapier
- Dashboard mobile
- Cashback parcial

**Fase 4 — Escalamiento (post-app):**
- Multi-sucursal con dashboard consolidado
- E-commerce completo
- Modo offline
- Pruebas A/B multi-canal

---

## 10. TECH STACK RECOMENDADO PARA PRODUCTO 10X

| Componente | Recomendación | Por qué |
|------------|---------------|---------|
| **App Cliente** (iOS + Android) | Flutter o React Native | Código compartido, Apple Wallet + Google Wallet nativos |
| **App Dashboard** (dueño) | Flutter o React Native | Reutilizar lógica con app cliente |
| **Web Dashboard** | Next.js + Tailwind CSS | SSR, SEO para landing, ecosistema React |
| **Backend API** | Cloudflare Workers + Hono | Edge serverless, latencia mínima, D1 para datos |
| **Base de datos principal** | PostgreSQL (via Neon o Supabase) | Confiable, relational, soporte multi-tenant nativo |
| **Cache / Tiempo real** | Redis (Upstash) | Sesiones, rate limiting, actividad en vivo |
| **Files / Images** | Cloudflare R2 | S3-compatible, sin cargos de salida |
| **Push Notifications** | Firebase Cloud Messaging (FCM) | Android + iOS, delivery rate 90%+ |
| **Email Service** | Resend + React Email | APIs modernas, componentes de email con React |
| **WhatsApp API** | WhatsApp Business API (Meta) | Canal oficial, plantillas, webhooks |
| **Payments** | Stripe + Mercado Pago | Cobertura LatAm + global |
| **Wallet** | Google Wallet API + Apple PassKit | Ambos ecosistemas mobile |
| **IA / Chatbot** | Cloudflare Workers AI + OpenAI | Chatbot en edge, embeddings para búsqueda semántica |
| **Analytics** | PostHog (self-hosted) | Eventos, funnel, retention, feature flags |
| **Background Jobs** | Cloudflare Queues | Tareas async, campañas programadas |
| **Search** | Meilisearch o Typesense | Búsqueda rápida de clientes y productos |
| **Infraestructura** | Cloudflare (Workers + D1 + R2 + Queues + AI) | Todo en un ecosistema, sinops |

---

## 11. CONCLUSIÓN Y ESTRATEGIA

FidelidApp es un producto SaaS **funcional y validado** para el mercado chileno de pymes. Su fortaleza: simplicidad (QR → landing → puntos → retención). Pero su techo es claro:

### Análisis FODA

| Fortalezas | Debilidades |
|------------|-------------|
| 40k+ clientes finales registrados | Sin app nativa |
| QR como vector de adquisición sin fricción | Sin referidos (no aprovecha viralidad) |
| WhatsApp como canal de engagement | Segmentación básica sin operadores lógicos |
| Landing personalizable (50+ paletas) | Sin IA/ML, sin automatización avanzada |
| Múltiples integraciones (Shopify, Wallet) | Sin API pública ni webhooks |

| Oportunidades | Amenazas |
|---------------|----------|
| Mercado LatAm de fidelización fragmentado y en crecimiento | Competidores con app nativa (Stocard, Loyalzoo) |
| Pymes necesitan retener clientes sin presupuesto de desarrollo | Grandes players (Mercado Libre, Shopify) integrando loyalty |
| Brasil, México, Colombia sin players dominantes | Soluciones de big tech (Apple Wallet Passes, Google Wallet) |
| IA generativa para chatbot de fidelización 24/7 | Churn si no innovan rápido |

### Estrategia recomendada

```
Fase 1 (Semanas 1-4): Quick Wins
  → NPS/CSAT, multiplicadores de membresía, segmentación AND/OR,
    alertas inteligentes, QR dinámicos, recordatorios de agenda

Fase 2 (Semanas 5-10): Diferenciación
  → Programa de referidos, chatbot con IA, emails transaccionales,
    multi-idioma, gamificación avanzada (streaks + badges)

Fase 3 (Meses 3-5): Salto competitivo
  → App nativa iOS + Android + Apple Wallet, API pública + Webhooks,
    dashboard mobile, cashback parcial

Fase 4 (Meses 6+): Escalamiento
  → Multi-sucursal consolidado, e-commerce, modo offline,
    pruebas A/B multi-canal
```

### Lo que FidelidApp hace bien (copyar)
- QR como entry point universal — simple, físico, sin fricción
- Landing personalizada por negocio — cada comercio siente que tiene su app
- Integración Google Wallet — tarjeta en el celular sin app extra
- Evaluación post-servicio + Google Reviews —闭环 perfecto
- Precio agresivo desde $0 — baja barrera de entrada

### Lo que hay que superar (nuestra ventaja)
| Aspecto | FidelidApp | Producto 10x |
|---------|------------|--------------|
| App | Solo PWA (iOS push no funciona bien) | App nativa iOS + Android + Apple Wallet |
| Adquisición | Solo QR + WhatsApp | QR + Referidos + NFC + Landing + Widgets |
| Segmentación | Sin operadores lógicos | AND/OR/NOT + RFM + predictiva |
| Chatbot | Menú fijo preconfigurado | IA generativa contextual con el cliente |
| Notificaciones | Push PWA (beta, poco confiable) | FCM nativo con delivery garantizado |
| Wallet | Solo Google Wallet | Google Wallet + Apple Wallet + actualización automática |
| API | Cerrada (sin webhooks) | API pública + Webhooks + Zapier |
| Offline | No funciona sin internet | Escaneo offline con sincronización diferida |
| Gamificación | 3 niveles fijos (Bronze/Silver/Platinum) | Streaks + Badges + Challenges + Leaderboards |
| Multi-idioma | Solo español chileno | PT-BR, EN, ES neutro desde el día 1 |

El mercado de fidelización para pymes en Latinoamérica es **enorme, está fragmentado y maduro para disrupción**. Un producto que combine la simplicidad de FidelidApp con app nativa, IA, referidos y multi-país tiene una oportunidad real de capturar份额 significativa antes de que los grandes players se consoliden.

---

*Documento generado el 29 de junio de 2026 mediante exploración completa de la plataforma.*
