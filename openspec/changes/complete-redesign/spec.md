# Spec: Complete Redesign

**Change**: `complete-redesign`
**Status**: Spec phase
**Priority**: 1 — Design System → 2 — Landing Page → 3 — Dashboard → 4 — Customer-web

---

## What this spec covers

| # | Deliverable | Scope |
|---|-------------|-------|
| 1 | `@vyloop/design-system` | Token system, component primitives, icons, package structure |
| 2 | Landing page | Public marketing site for LatAm SMBs |
| 3 | Dashboard redesign | Layout, nav, pages restyled to new system |
| 4 | Customer-web alignment | Token switch from standalone amber CSS |

---

## 1. Design System (`@vyloop/design-system`)

### 1.1 Token System — CSS Custom Properties

All tokens live in CSS custom properties scoped to `:root`. No Sass, no Tailwind. Every value traces back to a semantic role.

#### 1.1.1 Brand Palette

| Token | Value | Role |
|-------|-------|------|
| `--brand-50` | `#fffbeb` | Lightest tint (bg hover, badges) |
| `--brand-100` | `#fef3c7` | Light tint (light surfaces) |
| `--brand-200` | `#fde68a` | Tint (borders light) |
| `--brand-300` | `#fcd34d` | Muted brand (inactive, secondary) |
| `--brand-400` | `#fbbf24` | Accent brand (icons, highlights) |
| `--brand-500` | `#f59e0b` | **Primary brand** (buttons, links) |
| `--brand-600` | `#d97706` | **Primary hover** (interactive states) |
| `--brand-700` | `#b45309` | Active/pressed state |
| `--brand-800` | `#92400e` | Deep brand (text on light) |
| `--brand-900` | `#78350f` | Deepest brand (rarely used) |

#### 1.1.2 Semantic Colors

| Token | Value | Role |
|-------|-------|------|
| `--success` | `#16a34a` | Positive actions, earned points |
| `--success-bg` | `#f0fdf4` | Success background |
| `--success-border` | `#bbf7d0` | Success border |
| `--error` | `#dc2626` | Destructive actions, errors |
| `--error-bg` | `#fef2f2` | Error background |
| `--error-border` | `#fecaca` | Error border |
| `--warning` | `#d97706` | Warnings, pending states |
| `--warning-bg` | `#fffbeb` | Warning background |
| `--warning-border` | `#fde68a` | Warning border |
| `--info` | `#2563eb` | Informational |
| `--info-bg` | `#dbeafe` | Info background |
| `--info-border` | `#bfdbfe` | Info border |

#### 1.1.3 Neutral / Surface Scale (Warm Stone)

Named `--stone-*` to differentiate from a cold gray. All neutrals lean slightly warm (amber undertone).

| Token | Value | Role |
|-------|-------|------|
| `--stone-50` | `#fafaf9` | Page background |
| `--stone-100` | `#f5f5f4` | Card bg, elevated surfaces |
| `--stone-150` | `#efeeeb` | Hover on cards, input bg |
| `--stone-200` | `#e7e5e4` | Border default |
| `--stone-300` | `#d6d3d1` | Border light |
| `--stone-400` | `#a8a29e` | Text muted, placeholder |
| `--stone-500` | `#78716c` | Text secondary |
| `--stone-600` | `#57534e` | Text body |
| `--stone-700` | `#44403c` | Text primary |
| `--stone-800` | `#292524` | Text headings |
| `--stone-900` | `#1c1917` | Text darkest |

#### 1.1.4 Foreground Text Tokens

| Token | Maps to | Used for |
|-------|---------|----------|
| `--text-primary` | `--stone-800` | Headings, bold body |
| `--text-body` | `--stone-600` | Paragraphs, labels |
| `--text-secondary` | `--stone-500` | Supporting text, metadata |
| `--text-muted` | `--stone-400` | Placeholders, disabled |
| `--text-inverse` | `#ffffff` | Text on brand/dark surfaces |

#### 1.1.5 Surface / Background Tokens

| Token | Value | Used for |
|-------|-------|----------|
| `--surface-page` | `--stone-50` | Page / canvas background |
| `--surface-card` | `#ffffff` | Card, modal, dropdown bg |
| `--surface-elevated` | `#ffffff` | Popovers, tooltips |
| `--surface-sidebar` | `--stone-900` | Sidebar (dark) |
| `--surface-topbar` | `#ffffff` | Topbar |
| `--surface-input` | `#ffffff` | Input fields |
| `--surface-overlay` | `rgba(28, 25, 23, 0.5)` | Modal backdrops |

#### 1.1.6 Border Tokens

| Token | Value | Used for |
|-------|-------|----------|
| `--border` | `--stone-200` | Default borders |
| `--border-light` | `--stone-100` | Subtle dividers |
| `--border-input` | `--stone-300` | Input borders |
| `--border-focus` | `--brand-500` | Focus ring |
| `--border-error` | `--error` | Error borders |

#### 1.1.7 Typography

**Typefaces:**

| Role | Face | Fallback | Usage |
|------|------|----------|-------|
| Display | `'Sora'` | `system-ui, sans-serif` | Headings h1-h3, brand text |
| Body | `'Inter'` | `system-ui, sans-serif` | Body, labels, buttons, inputs |
| Mono | `'JetBrains Mono'` | `'SF Mono', monospace` | Code, numbers, data |

Import both via `next/font` in layout files. Do not use self-hosted or CDN font files.

**Type scale** (ratio ~1.25, minor third):

| Token | Size | Weight | Line Height | Letter-spacing | Usage |
|-------|------|--------|-------------|----------------|-------|
| `--text-xs` | 0.75rem (12px) | 400/500/600 | 1.4 | normal | Captions, metadata |
| `--text-sm` | 0.8125rem (13px) | 400/500/600 | 1.4 | normal | Labels, hints, table cells |
| `--text-base` | 0.875rem (14px) | 400/500 | 1.5 | normal | Body, buttons, inputs |
| `--text-lg` | 1rem (16px) | 500/600 | 1.5 | normal | Large body, card titles |
| `--text-xl` | 1.125rem (18px) | 600 | 1.4 | -0.01em | Section headings |
| `--text-2xl` | 1.25rem (20px) | 600/700 | 1.3 | -0.02em | Page titles |
| `--text-3xl` | 1.5rem (24px) | 700 | 1.3 | -0.02em | Hero subtitles |
| `--text-4xl` | 1.875rem (30px) | 700 | 1.2 | -0.03em | Hero main |
| `--text-5xl` | 2.25rem (36px) | 700/800 | 1.15 | -0.03em | Large headings |
| `--text-6xl` | 3rem (48px) | 800 | 1.1 | -0.03em | Display (landing) |

**Font weight tokens:**

| Token | Value |
|-------|-------|
| `--font-normal` | 400 |
| `--font-medium` | 500 |
| `--font-semibold` | 600 |
| `--font-bold` | 700 |
| `--font-extrabold` | 800 |

#### 1.1.8 Spacing Scale (4px base)

| Token | Value | Intended use |
|-------|-------|-------------|
| `--space-0` | 0 | Reset |
| `--space-1` | 4px | Micro gaps, icon padding |
| `--space-2` | 8px | Tight gaps, badge padding |
| `--space-3` | 12px | Button padding, card inset |
| `--space-4` | 16px | Default padding, gaps |
| `--space-5` | 20px | Card padding, form spacing |
| `--space-6` | 24px | Section gaps |
| `--space-8` | 32px | Major sections |
| `--space-10` | 40px | Page padding |
| `--space-12` | 48px | Hero padding |
| `--space-16` | 64px | Extra large gaps |

#### 1.1.9 Border Radius Scale

| Token | Value | Usage |
|-------|-------|-------|
| `--radius-sm` | 4px | Inputs, buttons, badges |
| `--radius-md` | 8px | Cards, dropdowns |
| `--radius-lg` | 12px | Modals, dialogs |
| `--radius-xl` | 16px | Cards in customer-web |
| `--radius-full` | 9999px | Pills, avatars, tabs |

#### 1.1.10 Shadow / Elevation System

| Token | Value | Usage |
|-------|-------|-------|
| `--shadow-sm` | `0 1px 2px rgba(28,25,23,0.05)` | Cards on page |
| `--shadow-md` | `0 1px 3px rgba(28,25,23,0.08), 0 1px 2px rgba(28,25,23,0.04)` | Elevated cards |
| `--shadow-lg` | `0 4px 6px rgba(28,25,23,0.06), 0 2px 4px rgba(28,25,23,0.05)` | Modals, dropdowns |
| `--shadow-xl` | `0 10px 15px rgba(28,25,23,0.08), 0 4px 6px rgba(28,25,23,0.04)` | Modals, toasts |
| `--shadow-ring` | `0 0 0 3px rgba(245,158,11,0.15)` | Focus ring (brand) |
| `--shadow-ring-error` | `0 0 0 3px rgba(220,38,38,0.15)` | Focus ring (error) |

All shadow colors use the darkest neutral (`#1c1917`) as the shadow base — not black, so shadows feel warm.

#### 1.1.11 Breakpoints (Mobile-first)

| Token | Value | Usage |
|-------|-------|-------|
| `--bp-sm` | 640px | Large phones |
| `--bp-md` | 768px | Tablets |
| `--bp-lg` | 1024px | Desktop |
| `--bp-xl` | 1280px | Wide desktop |
| `--bp-2xl` | 1536px | Max content |

Use CSS media queries directly (not in custom properties). Example strategy:

```css
/* Base: mobile styles */
.sidebar { width: 64px; }
/* Tablet+ */
@media (min-width: 768px) { .sidebar { width: 260px; } }
```

#### 1.1.12 Transition Tokens

| Token | Value |
|-------|-------|
| `--transition-fast` | 120ms ease |
| `--transition-base` | 200ms ease |
| `--transition-slow` | 300ms ease |
| `--ease-out` | cubic-bezier(0.23, 1, 0.32, 1) |

### 1.2 Component Primitives

All primitives are React components with TypeScript interfaces. They use CSS modules importing from the token system via `@vyloop/design-system/tokens`.

Each component MUST:
- Accept a `className` prop for overrides
- Forward `ref` where applicable
- Be fully typed with strict TypeScript
- Support loading/disabled states where applicable

#### 1.2.1 Button

```tsx
interface ButtonProps {
  variant: 'primary' | 'secondary' | 'ghost' | 'outline' | 'danger';
  size: 'sm' | 'md' | 'lg';
  loading?: boolean;
  disabled?: boolean;
  icon?: ReactNode;       // icon slot (left)
  iconRight?: ReactNode;  // icon slot (right)
  fullWidth?: boolean;
  type?: 'button' | 'submit';
}
```

| Variant | bg | text | border | hover bg |
|---------|-----|------|--------|----------|
| `primary` | `--brand-500` | `white` | `--brand-500` | `--brand-600` |
| `secondary` | `white` | `--stone-700` | `--stone-200` | `--stone-100` |
| `ghost` | transparent | `--stone-500` | transparent | `--stone-100` |
| `outline` | transparent | `--brand-500` | `--brand-500` | `--brand-50` |
| `danger` | `--error` | `white` | `--error` | `#b91c1c` |

| Size | Height | Padding-x | Font size | Radius |
|------|--------|-----------|-----------|--------|
| `sm` | 32px | 12px | 13px | `--radius-sm` |
| `md` | 40px | 16px | 14px | `--radius-md` |
| `lg` | 48px | 20px | 16px | `--radius-md` |

#### 1.2.2 Input / Textarea / Select

```tsx
interface InputProps {
  label?: string;
  hint?: string;
  error?: string;
  leftIcon?: ReactNode;
  fullWidth?: boolean;
  // plus all native input props
}

interface TextareaProps extends Omit<InputProps, 'leftIcon'> {
  rows?: number;
  resize?: 'none' | 'vertical' | 'both';
}

interface SelectProps extends InputProps {
  options: { value: string; label: string }[];
  placeholder?: string;
}
```

States: `default`, `focus` (brand ring), `error` (error border + ring), `disabled` (opacity 0.5).

All inputs: 40px height default, 14px font, `--stone-100` bg, `--stone-300` border, `--radius-md`.

#### 1.2.3 Card

```tsx
interface CardProps {
  variant?: 'default' | 'elevated' | 'outlined';
  padding?: 'sm' | 'md' | 'lg';
  // Card.Header, Card.Body, Card.Footer sub-components
}
```

Header: flex row, title + optional action slot.
Body: padded content
Footer: flex row, right-aligned actions

#### 1.2.4 Modal / Dialog

```tsx
interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  size?: 'sm' | 'md' | 'lg';
  // uses Radix Dialog under the hood
}
```

- Overlay: `--surface-overlay`
- Content: `--surface-card`, `--radius-lg`, `--shadow-xl`
- Sizes: sm (400px), md (520px), lg (640px)
- Close button top-right
- Escape key closes. Click outside closes.

#### 1.2.5 Badge

```tsx
interface BadgeProps {
  variant: 'default' | 'success' | 'warning' | 'error' | 'info';
  size?: 'sm' | 'md';
  dot?: boolean;       // small colored dot before text
  children: ReactNode;
}
```

Variant maps colors:

| Variant | bg | text | border |
|---------|-----|------|--------|
| `default` | `--brand-50` | `--brand-700` | `--brand-200` |
| `success` | `--success-bg` | `--success` | `--success-border` |
| `warning` | `--warning-bg` | `--warning` | `--warning-border` |
| `error` | `--error-bg` | `--error` | `--error-border` |
| `info` | `--info-bg` | `--info` | `--info-border` |

#### 1.2.6 Toast / Notification

```tsx
interface ToastProps {
  type: 'success' | 'error' | 'warning' | 'info';
  title: string;
  description?: string;
  action?: { label: string; onClick: () => void };
  duration?: number;  // ms, default 4000
  onDismiss: () => void;
}
```

- Fixed bottom-right container
- Stacked with gap
- Entrance: slide up + fade (200ms)
- Auto-dismiss with timer
- Close button

#### 1.2.7 Table

```tsx
interface TableProps<T> {
  columns: TableColumn<T>[];
  data: T[];
  loading?: boolean;
  emptyMessage?: string;
  onRowClick?: (row: T) => void;
  sortable?: boolean;
}

interface TableColumn<T> {
  key: string;
  header: string;
  render?: (value: any, row: T) => ReactNode;
  sortable?: boolean;
  width?: string;
}
```

- Responsive: horizontal scroll on small screens
- Striped rows (even/odd via `--stone-50` on even)
- Hover row
- Loading skeleton state

#### 1.2.8 Tabs

```tsx
interface TabsProps {
  tabs: { id: string; label: string; icon?: ReactNode }[];
  activeTab: string;
  onChange: (tabId: string) => void;
  variant?: 'underline' | 'pills';
}
```

- `underline`: classic tab bar, brand underline on active
- `pills`: pill-style tabs for filters

#### 1.2.9 Progress Bar

```tsx
interface ProgressBarProps {
  value: number;        // 0-100
  size?: 'sm' | 'md' | 'lg';
  color?: 'brand' | 'success' | 'warning';
  showLabel?: boolean;
  animated?: boolean;
}
```

#### 1.2.10 Avatar

```tsx
interface AvatarProps {
  src?: string;
  alt: string;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  fallback?: string;    // initials
}
```

- Image or initials fallback with brand background
- `--radius-full`
- Sizes: sm (32px), md (40px), lg (48px), xl (64px)

#### 1.2.11 Skeleton / Loading

```tsx
interface SkeletonProps {
  variant: 'text' | 'circular' | 'rectangular';
  width?: string;
  height?: string;
  count?: number;        // repeat lines for text
}
```

- Shimmer animation via CSS gradient
- Light `--stone-100` bg, shimmer via `--stone-200`

### 1.3 Icon System

**Decision**: Use `lucide-react` (v0.400+).

**Rationale**:
- Tree-shakeable ESM
- Consistent 24x24 grid, 2px stroke
- Large set (1000+) covering dashboard and landing needs
- Active maintenance

**Usage pattern**:
```tsx
import { Users, Star, Settings, BarChart3 } from 'lucide-react';
```

**DO NOT** wrap icons in custom components. Import directly from `lucide-react`. The only exception: an `Icon` helper that maps semantic names to Lucide glyphs for nav items (optional, can be an inline map).

### 1.4 Package Structure

```
packages/design-system/
├── package.json                  # name: @vyloop/design-system
├── tsconfig.json
├── tokens/
│   ├── index.css                 # imports all token files
│   ├── colors.css                # brand, semantic, neutral
│   ├── typography.css            # type scale, weights, font faces
│   ├── spacing.css               # space scale
│   ├── radius.css                # border radius
│   ├── shadows.css               # elevation
│   └── transitions.css           # timing, easing
├── components/
│   ├── index.ts                  # barrel export
│   ├── button/
│   │   ├── Button.tsx
│   │   ├── Button.module.css
│   │   └── index.ts
│   ├── input/
│   │   ├── Input.tsx
│   │   ├── Input.module.css
│   │   └── index.ts
│   ├── card/
│   ├── modal/
│   ├── badge/
│   ├── toast/
│   ├── table/
│   ├── tabs/
│   ├── progress-bar/
│   ├── avatar/
│   └── skeleton/
├── icons/
│   └── index.ts                  # re-exports from lucide-react (optional)
└── styles/
    ├── reset.css                 # modern CSS reset
    ├── utilities.css             # layout helpers (flex, grid, spacing)
    └── index.css                 # imports tokens + reset + utilities
```

**Export strategy** — barrel exports:

```ts
// packages/design-system/components/index.ts
export { Button } from './button';
export type { ButtonProps } from './button';
export { Input } from './input';
export type { InputProps } from './input';
// ... etc
```

**CSS import in apps**:
```tsx
// app/layout.tsx (dashboard or customer-web)
import '@vyloop/design-system/tokens/index.css';
import '@vyloop/design-system/styles/index.css';
```

**Workspace dependency**:
```json
// apps/dashboard/package.json
{
  "dependencies": {
    "@vyloop/design-system": "workspace:*",
    "lucide-react": "^0.400.0"
  }
}
```

---

## 2. Landing Page

### 2.1 Purpose

A public-facing marketing site that:
- Explains what vyloop is in 5 seconds
- Converts SMB owners in LatAm to start a free trial
- Validates brand identity publicly (first public-facing touchpoint)
- Is SEO-optimized (SSR, meta tags, structured data)

### 2.2 Technical Approach

**Recommendation**: Standalone page (`/`) inside the existing `apps/dashboard` Next.js app, with an `app/(landing)` route group that uses a different root layout (no auth, no sidebar).

**Rationale**:
- Reuses existing Next.js infrastructure
- No additional deployment
- Shares the same design system import
- Easy route: `/` = landing, `/login` = auth, `/dashboard/*` = app

**Alternative considered**: Separate `apps/landing` Next.js app. Rejected because it adds deployment complexity (another Cloudflare Pages site), another package, and duplicated infra for no benefit. Only reconsider if the landing page needs markedly different Next.js config (e.g., ISR vs pure SSR).

**SSR requirements**:
- Pages MUST be server-rendered (no `'use client'` for SEO-sensitive content)
- All marketing content MUST be in server components
- Use `next/font` for Inter + Sora
- Open Graph tags for social sharing
- Structured data (JSON-LD) for rich search results

### 2.3 Sections

#### 2.3.1 Hero (Above the Fold)

```
┌─────────────────────────────────────────────────┐
│  [Logo]          [Características] [Precios]    │
│                  [Iniciar sesión] [Comenzar]    │
│                                                 │
│   Fideliza a tus clientes sin complicarte       │
│   ─────────────────────────────────────────     │
│   Crea un programa de lealtad en minutos.       │
│   Tus clientes acumulan puntos, tú retienes     │
│   más. Sin contratos ni tecnicismos.            │
│                                                 │
│   [Comenzar gratis →]    [Ver demo]             │
│                                                 │
│   +500 negocios en Latinoamérica ya confían     │
│   [logo] [logo] [logo] [logo] [logo]            │
└─────────────────────────────────────────────────┘
```

**Copy**:
- Headline: "Fideliza a tus clientes sin complicarte"
- Subheadline: "Crea un programa de lealtad en minutos. Tus clientes acumulan puntos, tú retienes más. Sin contratos ni tecnicismos."
- Primary CTA: "Comenzar gratis — sin tarjeta"
- Secondary CTA: "Ver demo en vivo"
- Social proof: "+500 negocios en Latinoamérica confían en vyloop"

#### 2.3.2 How It Works (3 pasos)

```
┌─────────────────────────────────────────────────┐
│         Cómo funciona vyloop                    │
│         ──────────────────────                  │
│                                                 │
│   [1]          [2]              [3]             │
│   Registra a   Tus clientes    Ellos canjean    │
│   tus clientes  acumulan        recompensas     │
│   en segundos   puntos solos    al instante     │
│                                                 │
│   Sube clientes  Ellos ganan    Canjean desde   │
│   o intégrate    puntos por     su perfil o     │
│   con QR         cada compra    en tu local     │
└─────────────────────────────────────────────────┘
```

#### 2.3.3 Benefits / Features Grid

3-column grid with 6 features:

| Feature | Copy |
|---------|------|
| Puntos automáticos | "Olvídate de las tarjetas de papel. Tus clientes ganan puntos automáticamente con cada compra." |
| Programa tu lealtad | "Define niveles, multiplicadores y recompensas. Sin tocar una línea de código." |
| QR para tu local | "Tus clientes se registran escaneando un código. Ellos solos entran al programa." |
| Dashboard en vivo | "Ve en tiempo real quién acumula más, qué recompensas funcionan y cómo crece tu negocio." |
| Segmenta y comunica | "Envía mensajes a tus mejores clientes. Ofertas, cumpleaños, puntos por vencer." |
| Sin contratos | "Paga solo si funciona. Cancela cuando quieras, sin multas ni papeleo." |

#### 2.3.4 Testimonials / Social Proof

2–3 quote cards from real (or launch partner) SMB owners. Format:

```tsx
interface Testimonial {
  quote: string;
  name: string;
  business: string;
  avatar?: string;
}

// Example:
{
  quote: "En dos semanas teníamos todo funcionando. Nuestros clientes aman poder ver sus puntos desde el celular.",
  name: "María García",
  business: "Café Central, Santiago",
}
```

#### 2.3.5 Pricing (Tier Preview)

3 tiers: **Gratis**, **Pro**, **Enterprise**.

| Feature | Gratis | Pro | Enterprise |
|---------|--------|-----|------------|
| Clientes | Hasta 50 | Ilimitados | Ilimitados |
| Recompensas | 5 activas | Ilimitadas | Ilimitadas |
| Niveles | 3 niveles | Ilimitados | Personalizados |
| Dashboard | Básico | Avanzado | Avanzado + API |
| Soporte | Email | Chat prioritario | Dedicado |
| Precio | $0 | $29/mes | Contactar |

#### 2.3.6 FAQ

5–7 questions. Topics:
- ¿Qué es un programa de lealtad?
- ¿Cuánto tiempo toma configurarlo?
- ¿Puedo integrarlo con mi sistema actual?
- ¿Mis clientes necesitan una app?
- ¿Hay contrato mínimo?
- ¿Cómo reciben puntos mis clientes?

#### 2.3.7 Footer

- Logotipo + descripción breve
- Links: Características, Precios, FAQ, Blog (future)
- Redes sociales (placeholder icons)
- Copyright
- Términos y condiciones / Privacidad (placeholder)

### 2.4 Tone & Language

**Tone**: Warm, trustworthy, professional but not corporate. Speaks to a busy SMB owner who is not technical.

**Language**: Spanish, LatAm-neutral. Avoid regional slang. Use "tú" for familiarity.

**Voice principles**:
- Active voice. "Crea un programa" not "El programa es creado"
- Short sentences. Max 20 words
- Benefits over features. "Retienes más clientes" not "Sistema de fidelización"
- Numbers when possible. "En 5 minutos" not "Rápidamente"

---

## 3. Dashboard Redesign

### 3.1 Layout Architecture

```
┌──────────────────────────────────────────┐
│  ┌──────────┐  ┌───────────────────────┐ │
│  │          │  │  Topbar              │ │
│  │ Sidebar  │  │  [User] [Salir]      │ │
│  │ (260px)  │  ├───────────────────────┤ │
│  │          │  │                       │ │
│  │  Nav     │  │  Content area         │ │
│  │  items   │  │  (flex: 1)            │ │
│  │          │  │                       │ │
│  │  Footer  │  │                       │ │
│  └──────────┘  └───────────────────────┘ │
└──────────────────────────────────────────┘
```

**Sidebar**: Fixed, 260px width on desktop. Collapsed to 64px icon-only on mobile (< 768px) and toggleable via hamburger on both desktop and mobile.

**Collapse behavior**:
- Desktop: user can toggle via hamburger icon. When collapsed: 64px icon-only, labels hidden, tooltip on hover
- Mobile: overlay drawer (slides over content), backdrop click closes
- State persisted in `localStorage`

**Topbar**:
- Sticky, full-width (minus sidebar)
- Left: page title (dynamic, based on route)
- Right: user email/avatar, logout button

**Content area**:
- Padding: `--space-8` (32px) desktop, `--space-4` (16px) mobile
- Max width: none (full available width)

### 3.2 Navigation Structure

| Section | Items | Icon |
|---------|-------|------|
| Dashboard | Panel Principal | `LayoutDashboard` |
| Clientes | Lista de Clientes | `Users` |
| Lealtad | Configuración, Niveles, Recompensas, Puntos | `Settings`, `Layers`, `Star`, `Coins` |
| Comercio | QR del Negocio | `QrCode` |
| (bottom) | Configuración | `Settings` |
| (bottom) | Cerrar Sesión | `LogOut` |

**Proposed change**: Move "Settings" to bottom as a standalone row (it exists in loyalty sub-nav now but a global settings makes sense for the future). Keep QR under "Comercio".

**Confirmed nav items**:

```
Panel Principal          (Dashboard home)
Clientes                 (Customer list)
  └─ Detalle             (Customer detail — sub-route)
Lealtad
  ├─ Configuración       (Loyalty config)
  ├─ Niveles              (Tiers)
  ├─ Recompensas          (Rewards catalog)
  └─ Puntos               (Customer points)
Comercio
  └─ QR del Negocio      (QR)
--- divider ---
Configuración            (Account settings — for future)
Cerrar Sesión
```

### 3.3 Pages to Redesign

All pages use the same layout defined in `apps/dashboard/src/app/dashboard/layout.tsx`. The redesign replaces flat CSS classes with design system components.

#### 3.3.1 Dashboard Home (`/dashboard`)

**Current**: KPI grid + timeline + tier distribution + quick links

**Changes**:
- KPI cards → `Card` component with `Icon` + value + label + trend
- Timeline → `Card` + custom timeline (no table)
- Tier distribution → `Card` + `ProgressBar` components
- Quick links → `Card` + link list
- All inline SVGs → `lucide-react` icons
- All `card`, `card-header`, `card-body` classes → `<Card.Header>`, `<Card.Body>` components

#### 3.3.2 Customers List (`/dashboard/customers`)

**Current**: Table with search, customer list, clickable rows

**Changes**:
- Table → `Table` component
- Search input → `Input` with `leftIcon`
- Badges → `Badge` component (tier badges)
- Pagination: keep as-is, can become `Table` built-in later

#### 3.3.3 Customer Detail (`/dashboard/customers/[id]`)

**Current**: Hero card with stats, event timeline, action buttons

**Changes**:
- Hero section → `Card` with `Avatar` + customer info + stats
- Timeline → restyled with design system tokens
- Action buttons → `Button` components

#### 3.3.4 Analytics (`/dashboard/analytics`)

**Current**: Analytics subpage exists

**Changes**:
- Restyle `Card`, `Button`, badges to DS tokens
- Replace inline SVGs with Lucide

#### 3.3.5 Loyalty Pages (`/dashboard/loyalty/*`)

**Changes**:
- Restyle cards, tables, buttons, badges to DS tokens
- Tier cards → `Card` + `Badge` + `ProgressBar`

#### 3.3.6 QR Page (`/dashboard/qr`)

**Changes**:
- Restyle to DS tokens
- Replace custom amber styles with `Badge` + `Card` components

### 3.4 Stay-in-Scope vs Future

| Element | Decision |
|---------|----------|
| Sidebar collapse animation | In scope |
| Topbar responsive | In scope |
| Page content restyling | In scope |
| Functional changes to existing components | NOT in scope |
| Adding new dashboard pages | NOT in scope |
| Dark mode | Deferred (proposal decision) |
| New navigation items for unbuilt features | NOT in scope |

---

## 4. Customer-web Alignment

### 4.1 Scope

The customer-web app (mobile-first PWA, `/apps/customer-web`) was redesigned in PR #47 with an amber/warm palette that closely matches the new brand direction. The scope here is **token alignment**: replace all hardcoded hex values and standalone CSS with the design system tokens.

### 4.2 What Changes

| Current | New |
|---------|-----|
| `#fef9f0` (body bg) | `--surface-page` |
| `#ffffff` (card) | `--surface-card` |
| `#1c1917` (text) | `--text-primary` |
| `#78716c` (muted) | `--text-secondary` |
| `#f59e0b` (brand) | `--brand-500` |
| `#d97706` (brand dark) | `--brand-600` |
| Custom `.card` classes | `Card` component from DS |
| Custom `.btn--*` classes | `Button` component from DS |
| Custom `.input` classes | `Input` component from DS |
| Custom `.tier-badge` | `Badge` component from DS |
| Inline SVGs | `lucide-react` icons |
| Custom `.progress-bar` | `ProgressBar` component from DS |

### 4.3 Pages Affected

| Page | Route | Changes |
|------|-------|---------|
| Login/Register | `/`, `/login` | Token swap, DS Button/Input |
| Profile | `/profile` | Token swap, DS Card/Badge/ProgressBar |
| History | `/profile/history` | Token swap, DS Tabs/Badge |
| Rewards | `/profile/rewards` | Token swap, DS Card/Badge |
| Confirm | `/confirm` | Token swap, DS Card/Button |

### 4.4 Template Pages Completed in PR #47

PR #47 already implemented the redesign for `/profile`, `/profile/history`, `/profile/rewards`, `/confirm`, and `/`. These pages were written with new CSS classes (`.card`, `.btn--primary`, `.input`, etc.) that need token alignment. No structural HTML changes needed — CSS only.

### 4.5 What Stays

- The mobile-first layout decisions (cards, full-width buttons)
- The amber brand direction (already matches)
- The responsive breakpoints
- The safe-area-inset-bottom handling
- All functional behavior

---

## 5. Phase Dependencies

```
Phase 1: Design System
  ├── Token files created (can work in parallel)
  ├── Component primitives (depends on tokens)
  └── Package published locally (workspace)
      │
Phase 2: Landing Page
  ├── Route group created in dashboard app
  ├── Sections built with DS components
  └── SEO tags + OG image
      │
Phase 3: Dashboard Redesign (depends on Phase 1)
  ├── Layout: sidebar collapse + topbar
  ├── Page: dashboard home
  ├── Page: customers list
  ├── Page: customer detail
  └── Page: analytics + loyalty + QR
      │
Phase 4: Customer-web (depends on Phase 1)
  └── Token swap across all pages
```

## 6. Scenarios

### 6.1 Design System

- **Scenario: App imports DS tokens correctly**
  Given an app (dashboard or customer-web) imports `@vyloop/design-system/tokens/index.css`
  When the app renders any element using a token (e.g., `var(--brand-500)`)
  Then the token MUST resolve to the declared CSS custom property value.

- **Scenario: Button renders all variants**
  Given a `Button` component with `variant="primary"`
  When rendered
  Then it MUST show brand background with white text
  And it MUST have `--radius-md` border radius
  And it MUST be `40px` height for `md` size.

- **Scenario: Icon import works**
  Given a component imports `{ Users } from 'lucide-react'`
  When rendered
  Then it MUST display the Users icon at default 24x24 size.

- **Scenario: Design system is tree-shakable**
  Given a build of any importing app
  When the bundle is analyzed
  Then unused components MUST NOT appear in the production bundle.

### 6.2 Landing Page

- **Scenario: SEO metadata present**
  Given the landing page is loaded
  When a search engine crawler reads the page
  Then the page MUST include `<title>`, `<meta name="description">`, Open Graph tags, and JSON-LD structured data.

- **Scenario: Hero CTA navigates to signup**
  Given a visitor clicks "Comenzar gratis"
  When the CTA is clicked
  Then they MUST be redirected to `/login?signup=true`.

- **Scenario: Mobile navigation works**
  Given a visitor on a 375px viewport
  When they view the landing page
  Then the navigation MUST be collapsed into a hamburger menu
  And all content MUST render without horizontal overflow
  And font sizes MUST be minimum 16px.

### 6.3 Dashboard

- **Scenario: Sidebar collapses on toggle**
  Given a user clicks the sidebar toggle
  When the toggle is clicked
  Then the sidebar MUST transition from 260px to 64px width
  And icon labels MUST be hidden
  And the preference MUST persist across page navigation.

- **Scenario: Mobile sidebar is an overlay**
  Given a user on a viewport < 768px
  When they open the sidebar
  Then it MUST appear as a drawer overlaying the content
  And a backdrop MUST be visible
  And clicking the backdrop MUST close the sidebar.

- **Scenario: Dashboard home renders KPI cards**
  Given a logged-in merchant viewing dashboard home
  When the page loads with data
  Then KPI cards MUST show using `Card` component
  And each card MUST show value, label, and trend.

- **Scenario: Customer list table renders**
  Given a user on the customers page
  When customer data loads
  Then the `Table` component MUST render with columns: Nombre, Teléfono, Puntos, Nivel, Miembro desde
  And each row MUST be clickable.

### 6.4 Customer-web

- **Scenario: Profile page uses DS tokens**
  Given a customer loads their profile
  When the page renders
  Then all colors MUST come from `--brand-*` and `--stone-*` tokens
  And `Button`/`Card`/`Badge` components MUST be from `@vyloop/design-system`.

- **Scenario: Customer points display**
  Given a customer with points balance
  When the points card renders
  Then it MUST use `--brand-500` / `--brand-600` gradient background
  And the value MUST use `font-variant-numeric: tabular-nums`.

---

## 7. Checklist

- [ ] Phase 1: All token CSS files created and verified
- [ ] Phase 1: All component primitives built and exported via barrel
- [ ] Phase 1: `lucide-react` added as dependency in dashboard and customer-web
- [ ] Phase 2: Landing page route group created
- [ ] Phase 2: All sections built in server components
- [ ] Phase 2: SEO metadata + OG tags present
- [ ] Phase 2: Mobile-responsive verified
- [ ] Phase 3: Sidebar collapsible with localStorage persistence
- [ ] Phase 3: Dashboard home restyled with DS components
- [ ] Phase 3: Customers list + detail restyled with DS components
- [ ] Phase 3: All loyalty pages restyled
- [ ] Phase 3: QR page restyled
- [ ] Phase 4: Customer-web all pages token-swapped
- [ ] Phase 4: No hardcoded hex values remain in customer-web CSS
- [ ] Phase 4: All custom classes replaced by DS components
- [ ] Overall: ~2383 lines of flat CSS eliminated or replaced
- [ ] Overall: Both apps compile with `pnpm -r typecheck` and `pnpm -r lint`

---

## 8. Rollback

| Phase | Rollback action |
|-------|-----------------|
| 1 | Remove `@vyloop/design-system` workspace dependency from apps |
| 2 | Remove landing page route group and files |
| 3 | Revert globals.css and dashboard layout files to previous commit |
| 4 | Revert customer-web CSS and component imports to previous commit |

All phases are additive and can be reverted independently. Phase 1 must be kept if Phases 2–4 are applied.
