# 06-Domain-Driven-Design.md
**[ESTADO]:** Draft | **[RESPONSABLE]:** Principal Software Architect

## Dominios Clave (Bounded Contexts)
1. **Identity:** Gestión de Tenants (Empresas), Usuarios y Permisos Globales.
2. **Customer:** Perfil único del cliente (Global ID).
3. **Growth:** Lógica de reglas de lealtad y promociones.
4. **Communication:** Adaptadores para mensajería omnicanal.
5. **Automation:** Motor de estados y disparadores.
6. **Analytics:** Proyecciones de eventos en tiempo real.
7. **Compliance:** Gestión de leyes locales de datos, impuestos y moneda.

## Modelo de Identidad (Identity Platform)
- **GlobalID:** Identificador universal de cliente que trasciende su relación con una empresa específica, permitiendo el concepto de "Cross-Loyalty" futuro.
- **Tenancy:** Basado en `tenant_id` en todas las tablas con RLS (Row Level Security) aplicado.