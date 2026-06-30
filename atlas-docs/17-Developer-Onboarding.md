# 17-Developer-Onboarding.md
**[DOCUMENTO]:** Developer Onboarding | **[ESTADO]:** Approved | **[RESPONSABLE]:** Founder

## Bienvenido a Project Atlas
No estás aquí para construir un sistema de fidelización; estás aquí para construir el **Growth OS** global.

## Nuestras Reglas de Oro
1. **Event-Driven:** Antes de escribir una lógica, pregunta: "¿Qué evento dispara esto y qué eventos genera?".
2. **Schema-First:** Todo contrato de datos debe estar documentado en el Schema Registry.
3. **No dupliques lógica por país:** Si estás creando una rama de código específica para un país, detente. Busca el *adaptador* correspondiente.

## Checklist de tu primer día
1. **Acceso al Repositorio:** Clona el monorepo `atlas-core`.
2. **Setup del Entorno:** Ejecuta `docker-compose up` (o usa la configuración de Cloudflare Wrangler).
3. **Tu primera tarea:** Crea un nuevo evento en el Bus y suscríbete a él desde un servicio de dominio de prueba.
4. **Cultura:** Lee la `00-Product-Constitution.md`. Es nuestra única fuente de verdad sobre cómo tomamos decisiones.