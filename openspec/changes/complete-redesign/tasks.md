# Tasks: Complete Redesign

**Change**: `complete-redesign`
**Status**: Tasks phase
**Delivery strategy**: `ask-always`
**Review budget**: 800 lines per PR
**Migration**: Big-bang (build system first, then migrate apps)

---

## Review Workload Forecast

| Phase | Estimated ∆ lines | Review Budget | PRs Required |
|-------|------------------|---------------|-------------|
| 1 — Design System | ~2,200 added | 800/PR | **3 PRs** |
| 2 — Landing Page | ~1,100 added | 800/PR | **2 PRs** |
| 3 — Dashboard Redesign | ~2,500 added + ~1,500 removed | 800/PR | **4–5 PRs** |
| 4 — Customer-web Alignment | ~500 modified | 800/PR | **1 PR** |

**Total**: ~5,800 added, ~1,500 removed across ~10–11 PRs.

---

## Dependency Map

```
Phase 1 ──┬──→ Phase 2 (depends on DS exports being importable)
           ├──→ Phase 3 (depends on DS components existing)
           └──→ Phase 4 (depends on DS tokens being importable)

Phase 1.1 (scaffold)
  └→ 1.2 (tokens)
       └→ 1.3–1.13 (components, each mostly independent)
            └→ 1.14 (icons)

Phase 2.1 (route group) → 2.2–2.8 (sections, parallel) → 2.9 (copy) → 2.10 (SEO)

Phase 3.1 (sidebar) + 3.2 (topbar) → 3.3–3.8 (pages, can be parallel)
                                         └→ 3.9 (cleanup, after all pages)

Phase 4.1 (tokens) → 4.2–4.4 (component replacement) → 4.5 (remove old CSS)

Phase 5.1–5.5 (verification, after all phases)
```

**Critical path**: 1.1 → 1.2 → any component task → Phase 2/3/4

---

## Phase 1: Design System Package (`@vyloop/design-system`)

> **Estimated total**: ~2,200 lines added
> **PRs**: 3 (PR #A: scaffold + tokens, PR #B: core components, PR #C: complex components + icons)

### PR-A: Foundation + Tokens (~640 lines)

#### Task 1.1: Scaffold `packages/design-system/`

| Field | Value |
|-------|-------|
| **Files** | `package.json`, `tsconfig.json`, `vitest.config.ts`, `src/index.ts`, `src/components/index.ts` |
| **Dependencies** | None |
| **Est. ∆ lines** | ~40 |
| **Key decisions** | No build step (raw source exports, matching `@vyloop/types` pattern). `tsconfig.json` extends `../../tsconfig.base.json`. |

**`package.json` exports:**
- `"."` → `./src/index.ts` (components barrel)
- `"./tokens"` → `./src/tokens/index.css`
- `"./styles"` → `./src/styles/index.css`
- `"./tokens/*"` → `./src/tokens/*.css`

**Directory structure to create:**
```
packages/design-system/
├── package.json
├── tsconfig.json
├── vitest.config.ts
└── src/
    ├── index.ts
    ├── tokens/
    ├── components/
    │   └── index.ts
    └── styles/
```

**Workspace registration**: Add `packages/design-system` to pnpm workspace filter (check `pnpm-workspace.yaml`).

#### Task 1.2: Create all CSS token files

| Sub-task | File | Est. lines |
|----------|------|-----------|
| 1.2a | `src/tokens/colors.css` — brand amber (OKLCH), stone neutrals (hue 67.5°), semantic colors | ~120 |
| 1.2b | `src/tokens/typography.css` — font families, type scale (10 sizes), weights, line heights | ~80 |
| 1.2c | `src/tokens/spacing.css` — 4px base scale (0–64px) | ~30 |
| 1.2d | `src/tokens/radius.css` — sm/md/lg/xl/full | ~20 |
| 1.2e | `src/tokens/shadows.css` — warm stone-based elevation, focus rings | ~40 |
| 1.2f | `src/tokens/transitions.css` — fast/base/slow + ease-out | ~20 |
| 1.2g | `src/tokens/index.css` — @import all token files | ~10 |
| 1.2h | `src/styles/reset.css` — modern CSS reset | ~60 |
| 1.2i | `src/styles/utilities.css` — flex, grid, text helpers | ~100 |
| 1.2j | `src/styles/index.css` — @import reset + utilities | ~5 |

**Total**: ~485 lines
**Key details**: OKLCH values used primary. No hex fallback needed (browser support is sufficient in 2026). All shadows use `#1c1917` (stone-900) as base for warm tones.

**Verification**: Import `@vyloop/design-system/tokens` in a test app and verify `var(--brand-500)` resolves.

---

### PR-B: Core Components (~800 lines)

All components follow the same pattern:
- `ComponentName.tsx` — React component with `forwardRef`, typed props
- `ComponentName.module.css` — CSS Module with token references
- `index.ts` — barrel re-export

#### Task 1.3: Build Button component

| Variant | Height | Padding-x | Font | Radius |
|---------|--------|-----------|------|--------|
| sm | 32px | 12px | 13px | `--radius-sm` |
| md | 40px | 16px | 14px | `--radius-md` |
| lg | 48px | 20px | 16px | `--radius-md` |

| Variant | bg | text | border | hover bg |
|---------|-----|------|--------|----------|
| primary | `--brand-500` | `--text-inverse` | `--brand-500` | `--brand-600` |
| secondary | `--surface-card` | `--text-primary` | `--border` | `--stone-100` |
| ghost | transparent | `--text-secondary` | transparent | `--stone-100` |
| outline | transparent | `--brand-500` | `--brand-500` | `--brand-50` |
| danger | `--error` | `--text-inverse` | `--error` | `oklch(0.45 0.2 28)` |

**Props**: `variant`, `size`, `loading`, `disabled`, `icon`, `iconRight`, `fullWidth`, `type`, `className`, plus all native button props.

**Accessibility**: Native `<button>`. `aria-busy={loading}`, `aria-disabled={disabled || loading}`. Loading state: spinner replaces icon, text stays visible for SR.

**Est. lines**: ~180 (80 TSX + 100 CSS)

#### Task 1.4: Build Input/Textarea/Select components

**Compound pattern**: All share `label`, `hint`, `error`, `fullWidth` props.

| Component | Est. lines | Notes |
|-----------|-----------|-------|
| Input | ~100 (40 TSX + 60 CSS) | Native `<input>`, `leftIcon` slot, error state with `--shadow-ring-error` |
| Textarea | ~70 (30 TSX + 40 CSS) | Native `<textarea>`, `rows` prop, `resize` prop |
| Select | ~90 (40 TSX + 50 CSS) | Native `<select>`, `options` array, `placeholder` |

**Shared styling**: 40px height default, `--surface-input` bg, `--border-input`, `--radius-md`, 14px font, focus ring via `--shadow-ring`.

**Accessibility**: Native elements. `aria-describedby` linking hint/error. `aria-invalid` when `error` is present.

**Est. total**: ~260 lines

#### Task 1.5: Build Card component

**Compound pattern**: `Card` + `Card.Header` + `Card.Body` + `Card.Footer`

| Variant | Background | Border | Shadow |
|---------|-----------|--------|--------|
| default | `--surface-card` | `--border` | `--shadow-sm` |
| elevated | `--surface-card` | none | `--shadow-md` |
| outlined | transparent | `--border` | none |

**Header**: `title` + optional `action` slot, bottom separator, `--text-lg` `--font-semibold` title.
**Body**: padded content (`--space-5`).
**Footer**: right-aligned actions, top separator.

**Accessibility**: `role="region"` when header exists. `aria-labelledby` pointing to header title.

**Est. lines**: ~170 (90 TSX + 80 CSS)

#### Task 1.6: Build Badge component

**Variants**: `default`, `success`, `warning`, `error`, `info`. Each maps to semantic bg/text/border.
**Sizes**: sm (20px h, 10px font), md (24px h, 12px font).
**Optional**: `dot` prop for colored indicator before text.

**Est. lines**: ~80 (30 TSX + 50 CSS)

#### Task 1.7: Build ProgressBar component

**Props**: `value` (0–100), `size` (sm=4px/md=8px/lg=12px), `color` (brand/success/warning), `showLabel`, `animated`.

**Accessibility**: `role="progressbar"`, `aria-valuenow`, `aria-valuemin`, `aria-valuemax`.

**Est. lines**: ~90 (40 TSX + 50 CSS)

#### Task 1.8: Build Avatar component

**Props**: `src`, `alt` (required), `size` (sm/md/lg/xl), `fallback` (initials).
**Behavior**: Image when `src` exists, initials fallback on error or no src. Fallback bg: `--brand-100`, text: `--brand-700`.

**Sizes**: sm=32px, md=40px, lg=48px, xl=64px.

**Est. lines**: ~80 (40 TSX + 40 CSS)

#### Task 1.9: Build Skeleton component

**Variants**: `text` (14px h, 100% w), `circular` (40px), `rectangular` (100px h).
**Props**: `width`, `height`, `count` (repeat for text lines).
**Animation**: Shimmer via `@keyframes` 1.5s infinite.

**Est. lines**: ~100 (50 TSX + 50 CSS)

---

### PR-C: Complex Components + Setup (~760 lines)

#### Task 1.10: Build Modal component

**Dependency**: `@radix-ui/react-dialog` (add to DS package.json as dependency).

**Sizes**: sm=400px, md=520px, lg=640px max-width.
**Props**: `open`, `onClose`, `title`, `description`, `size`, `footer`, `children`.

**Features**: Focus trap, Escape to close, click-outside dismiss, scroll lock, enter/exit animation (opacity + scale, 200ms `--ease-out`).

**Est. lines**: ~160 (90 TSX + 70 CSS)

#### Task 1.11: Build Toast component

**Two parts**: `ToastContainer` (fixed bottom-right, stacks) + `Toast` (individual notification).

**Types**: success, error, warning, info — each maps to semantic colors.
**Behavior**: auto-dismiss (4000ms default), pause on hover, max 5 visible, close button, slide-up entrance animation.
**Simple API**: `toast.success()`, `toast.error()`, etc. via context or exported functions.

**Est. lines**: ~200 (120 TSX + 80 CSS)

#### Task 1.12: Build Table component

**Generic**: `Table<T extends Record<string, unknown>>`
**Props**: `columns` (key, header, render, sortable, align, width), `data`, `rowKey`, `loading`, `emptyMessage`, `onRowClick`, `sortable`, `defaultSortKey`, `defaultSortDirection`.

**Styling**: Full-width, striped rows (even = `--surface-page`), hover shift, horizontal scroll on mobile, loading skeleton (5 rows), empty state.

**Accessibility**: Native `<table>` with `<thead>`, `<tbody>`, `<th scope="col">`. Sortable columns get `aria-sort`.

**Est. lines**: ~200 (120 TSX + 80 CSS)

#### Task 1.13: Build Tabs component

**Variants**: `underline` (brand bottom border) and `pills` (filled bg).

**Accessibility**: `role="tablist"` on container, `role="tab"` on each tab, `role="tabpanel"` on content, Arrow key navigation, `aria-selected`.

**Est. lines**: ~120 (60 TSX + 60 CSS)

#### Task 1.14: Setup icon infrastructure + barrel exports

**Actions**:
- Add `lucide-react` to `peerDependencies` in `package.json`
- Create optional `src/lib/icon-map.ts` for semantic nav icon mapping (`NAV_ICONS` const)
- Verify tree-shaking: direct imports from `lucide-react`, no wrapper component
- Complete barrel exports in `src/components/index.ts` and `src/index.ts`

**Est. lines**: ~30 config + ~50 barrel exports

---

## Phase 2: Landing Page

> **Estimated total**: ~1,100 lines added
> **PRs**: 2 (PR #D: route group + core sections, PR #E: remaining sections + copy + SEO)

### PR-D: Route Group + Core Sections (~650 lines)

#### Task 2.1: Create landing page route group

**Structure**:
```
apps/dashboard/src/app/(landing)/
├── layout.tsx          # Landing-specific layout (Inter + Sora via next/font)
├── page.tsx            # Server component composing all sections
└── components/
```

**Font loading** in layout: `Inter` for body, `Sora` for display — both via `next/font/google`.
**Root layout update**: Add font CSS variables (`--font-body`, `--font-display`) to the existing `app/layout.tsx`.

**Est. lines**: ~50

#### Task 2.2: Build Header (nav) component

**Links**: Logo, Características, Precios, Iniciar sesión, Comenzar gratis (CTA).
**Mobile**: Hamburger menu (no Radix — simple toggle state).

**Est. lines**: ~110 (50 TSX + 60 CSS)

#### Task 2.3: Build Hero section

**Copy**:
- Headline: "Fideliza a tus clientes sin complicarte"
- Subheadline: "Crea un programa de lealtad en minutos..."
- Primary CTA: "Comenzar gratis — sin tarjeta" (→ `/login?signup=true`)
- Secondary CTA: "Ver demo en vivo"
- Social proof: "+500 negocios en Latinoamérica confían en vyloop"

**Est. lines**: ~140 (60 TSX + 80 CSS)

#### Task 2.4: Build "How it works" section

**3 steps**: (1) Registra clientes, (2) Acumulan puntos, (3) Canjean recompensas.
**Visual**: Step numbers or icons with description below. Responsive: single column on mobile.

**Est. lines**: ~110 (50 TSX + 60 CSS)

#### Task 2.5: Build Features section

**6 features grid** (3-col desktop, 2-col tablet, 1-col mobile):
- Puntos automáticos, Programa tu lealtad, QR para tu local, Dashboard en vivo, Segmenta y comunica, Sin contratos
- Each: icon + title + short description

**Est. lines**: ~120 (60 TSX + 60 CSS)

---

### PR-E: Remaining Sections + Copy + SEO (~450 lines)

#### Task 2.6: Build Testimonials section

**2–3 quote cards**: Avatar (placeholder) + name + business + quote.
**Copy** (Spanish LatAm-neutral):
> "En dos semanas teníamos todo funcionando. Nuestros clientes aman poder ver sus puntos desde el celular." — María García, Café Central, Santiago

**Est. lines**: ~90 (50 TSX + 40 CSS)

#### Task 2.7: Build Pricing section

**3 tiers**: Gratis ($0), Pro ($29/mes), Enterprise (Contactar).
**Feature comparison**: Client limit, rewards, tiers levels, dashboard, support.

**Est. lines**: ~160 (80 TSX + 80 CSS)

#### Task 2.8: Build FAQ section

**7 questions** in accordion style (simple `details/summary` elements — no JS needed):
- ¿Qué es vyloop?, ¿Tiempo de configuración?, ¿Integración?, ¿App para clientes?, ¿Contrato mínimo?, ¿Cómo acumulan puntos?, ¿Soporte?

**Est. lines**: ~130 (80 TSX + 50 CSS)

#### Task 2.9: Build Footer

**Content**: Logo + brief description, links (Características, Precios, FAQ, Blog), social icons (placeholder), copyright, Términos/Privacidad (placeholders).

**Est. lines**: ~80 (40 TSX + 40 CSS)

#### Task 2.10: SEO setup

**Metadata** (Next.js Metadata API): title, description, OG tags (title, description, url, siteName, locale `es_LA`, type, image), Twitter card, robots (index, follow).
**JSON-LD**: `SoftwareApplication` schema type with pricing info.
**OG image**: Static `/og.png` or `@vercel/og` generation.

**Est. lines**: ~80 (`seo.ts` + layout metadata + JSON-LD script)

---

## Phase 3: Dashboard Redesign

> **Estimated total**: ~2,500 added + ~1,500 removed
> **PRs**: 4–5 (PR #F: layout, PR #G: home + customers, PR #H: detail + analytics, PR #I: loyalty + QR, PR #J: cleanup)

### PR-F: Layout Architecture (~550 lines)

#### Task 3.1: Build collapsible sidebar

**Dependencies**: `lucide-react` icons (already a peer dep of DS).

**State management**: React Context (`SidebarContext`) with:
- `collapsed` — initialized from `localStorage.getItem('vy-sidebar-collapsed')`
- `isMobile` — from `useSyncExternalStore` + `window.matchMedia('(max-width: 767px)')`
- `toggle()`, `openMobile()`, `closeMobile()`

**Responsive behavior**:
| Viewport | Behavior |
|----------|----------|
| ≥ 768px | Fixed 260px or 64px based on toggle. Content margin adjusts. Transition 200ms. |
| < 768px | Hidden by default. Hamburger opens drawer overlay. Backdrop click or Escape closes. |

**Navigation data structure**: Typed `NavItem[]` array with sections, icons, bottom section for settings/logout. Active matching via `pathname.startsWith(href)`.

**Animation**: Desktop: `width` transition (200ms). Mobile: `transform` on drawer + `opacity` on backdrop (250ms `--ease-out`).

**Est. lines**: ~350 (200 TSX + 150 CSS, including context + nav data + sidebar + drawer)

#### Task 3.2: Build topbar component

**Content**: Dynamic page title (based on active route), user email/avatar, logout button, hamburger toggle (mobile).
**Sticky**: `position: sticky; top: 0`.

**Est. lines**: ~200 (120 TSX + 80 CSS)

---

### PR-G: Dashboard Home + Customers List (~650 lines)

#### Task 3.3: Redesign dashboard home page

**Replace** (against current `page.tsx` at 337 lines):
- `loading-screen` / `spinner` → `Skeleton` component
- KPI grid with inline SVGs → `Card` + `lucide-react` icons + trend indicators
- Timeline HTML → `Card` + custom timeline (no Table — timeline is not tabular)
- Tier distribution bars → `ProgressBar` components
- Quick links → `Card` + link list
- All `.card`, `.card-header`, `.card-body` → `Card.Header`, `Card.Body`
- All inline SVG icons → `lucide-react` imports

**Est. lines**: ~350

#### Task 3.4: Redesign customers list page

**Replace** (against current `page.tsx` at 113 lines):
- Search input with custom wrapper → `Input` with `leftIcon` (Search icon)
- Native `<table>` → `Table` component with typed columns
- Tier badges (`.badge-bronce`, `.badge-plata`, `.badge-oro`) → `Badge` component
- Pagination retains structure but uses DS tokens

**Est. lines**: ~150

---

### PR-H: Customer Detail + Analytics (~600 lines)

#### Task 3.5: Redesign customer detail page

**Replace** (against current `[id]/page.tsx` at 347 lines):
- Customer hero section → `Card` + `Avatar` + customer info + stats
- `.hero-stat-*` classes → `Card` sub-components with DS tokens
- `.badge` tier → `Badge` component
- Timeline events → `Card` with DS tokens
- Action buttons → `Button` components
- All hardcoded colors (`#1e293b`, `#4b5c6b`, etc.) → DS tokens

**Est. lines**: ~350

#### Task 3.6: Redesign analytics page

**Replace** (against current `page.tsx` at 183 lines):
- KPI grid → `Card` with `lucide-react` icons
- `.kpi-*` classes → DS components
- Inline SVGs → Lucide icons
- `Button` components where applicable

**Est. lines**: ~200

---

### PR-I: Loyalty + QR Pages (~650 lines)

#### Task 3.7: Redesign loyalty pages (4 subpages)

| Page | Current lines | Approach |
|------|-------------|----------|
| Config | 167 | Replace form elements → `Input`, `Select`, `Button`. Replace cards → `Card`. |
| Tiers | 270 | `.tier-card` → `Card` + `Badge` + `ProgressBar`. Action buttons → `Button`. |
| Rewards | 333 | Table → `Table`. Badges → `Badge`. Cards → `Card`. |
| Points (Customers) | 167 | Table → `Table`. Search → `Input`. Badges → `Badge`. |

**Est. total**: ~500 (100–150 each after migration)

#### Task 3.8: Redesign QR page

**Replace** (against current `page.tsx` at 123 lines):
- `.qr-card`, `.qr-info` → `Card` components
- `.qr-tip` → semantic styling with DS tokens
- All hardcoded colors → DS tokens
- `Button` components for download/share

**Est. lines**: ~130

---

### PR-J: Cleanup (~already-removed lines)

#### Task 3.9: Remove old global CSS classes

**Remove from `globals.css`** (~1,680 lines):

| Section | Lines | Notes |
|---------|-------|-------|
| `:root` variables | ~50 | Replaced by DS tokens |
| Reset | ~20 | Replaced by DS `reset.css` |
| Login page | ~100 | Keep — login is outside dashboard layout |
| Dashboard layout | ~170 | Replaced by sidebar + topbar components |
| Cards | ~20 | Replaced by `Card` component |
| Tables | ~70 | Replaced by `Table` component |
| Badges | ~30 | Replaced by `Badge` component |
| Buttons | ~80 | Replaced by `Button` component |
| Forms | ~70 | Replaced by `Input` component |
| Pagination | ~50 | Keep for now (no DS pagination yet) |
| Modal | ~60 | Replaced by `Modal` component |
| Toast | ~50 | Replaced by `Toast` component |
| Inline edit | ~20 | Keep (not in DS scope) |
| Tier cards | ~40 | Replaced by `Card` + `Badge` + `ProgressBar` |
| Empty state | ~20 | Keep (not in DS scope) |
| Utility | ~70 | Replaced by DS utilities |
| Responsive | ~60 | Replaced by component-level media queries |
| Customer detail | ~100 | Replaced by DS components |
| Event timeline | ~50 | Keep timeline-specific styles |
| QR page | ~140 | Replaced by `Card` + DS tokens |
| KPI grid | ~60 | Replaced by DS components |
| Dash home | ~260 | Replaced by DS components |
| Clickable rows | ~10 | Replaced by `Table.onRowClick` |

**Remaining** (~200 lines kept): Login page, pagination, inline edit, empty state, event timeline.

**Est. lines removed**: ~1,480

---

## Phase 4: Customer-web Alignment

> **Estimated total**: ~500 lines modified
> **PRs**: 1 (PR #K)

### PR-K: Customer-web Token Swap (~500 lines)

#### Task 4.1: Add DS dependency and import tokens

- Add `@vyloop/design-system` + `lucide-react` to `apps/customer-web/package.json`
- Import DS tokens in root layout
- Add font variables via `next/font`

**Est. lines**: ~20

#### Task 4.2: Replace components in login/register pages

- `.form-control` → `Input` DS component
- `.btn-primary` → `Button` component
- DS token colors replace gradient backgrounds where applicable

**Est. lines**: ~80

#### Task 4.3: Replace components in profile page

- Avatar → `Avatar` component
- Points card → `Card` with DS tokens (`--brand-500`/`--brand-600` gradient)
- `.badge` → `Badge` component
- Progress toward next tier → `ProgressBar` component
- All `--amber-*` custom values → DS `--brand-*` tokens

**Est. lines**: ~120

#### Task 4.4: Replace components in history page

- Custom table → `Table` component
- `.badge` → `Badge` component
- Filter tabs → `Tabs` component (pills variant)

**Est. lines**: ~100

#### Task 4.5: Replace components in rewards page

- Cards → `Card` component
- Badges → `Badge` component
- Buttons → `Button` component

**Est. lines**: ~100

#### Task 4.6: Remove old customer-web CSS

- Remove hardcoded amber values
- Remove custom `.card`, `.btn--*`, `.input`, `.tier-badge`, `.progress-bar` classes

**Est. lines removed**: ~80

---

## Phase 5: Verification

> **PRs**: Verification is a per-PR gate, not a standalone PR

#### Task 5.1: TypeScript check all packages

```bash
pnpm -r typecheck
```

**Gates**: Zero type errors across all packages + apps.

#### Task 5.2: Component rendering tests (Vitest)

**Per component**:
- Renders without crashing (all variants)
- Handles loading/disabled/error states
- Forwards ref
- Accepts className override

**Test file**: `packages/design-system/src/components/*/__tests__/*.test.tsx`

#### Task 5.3: Visual regression — dashboard pages

Manual check per page:
- Desktop (1440px) and tablet (768px) widths
- Loading state, populated state, empty state
- Sidebar expanded and collapsed
- Mobile drawer overlay

#### Task 5.4: Visual regression — customer-web pages

Manual check per page:
- Mobile-first (375px) and desktop (1024px)
- Token-swapped colors vs previous hex values

#### Task 5.5: Lighthouse audit — landing page

**Targets**:
- Performance ≥ 90
- Accessibility ≥ 95
- SEO ≥ 90
- Best Practices ≥ 90

---

## PR Recommendations

| PR | Phase | Content | Est. ∆ lines | Review focus |
|----|-------|---------|-------------|--------------|
| **#A** | 1 | Scaffold + all token files + reset/utilities | ~640 | Token correctness, naming conventions |
| **#B** | 1 | Core components: Button, Input, Card, Badge, ProgressBar, Avatar, Skeleton | ~800 | Component APIs, accessibility, CSS Module patterns |
| **#C** | 1 | Complex components: Modal, Toast, Table, Tabs + icons + barrel | ~760 | Radix integration, generic typing, compound patterns |
| **#D** | 2 | Route group + Header + Hero + How it Works + Features | ~650 | Mobile responsiveness, server component correctness |
| **#E** | 2 | Testimonials + Pricing + FAQ + Footer + copy + SEO | ~450 | SEO metadata, JSON-LD, copy quality |
| **#F** | 3 | Sidebar + Topbar + SidebarContext + nav data | ~550 | Collapse animation, localStorage, mobile drawer |
| **#G** | 3 | Dashboard home + Customers list pages | ~650 | Component integration with real data |
| **#H** | 3 | Customer detail + Analytics pages | ~600 | Complex page compositions, token consistency |
| **#I** | 3 | Loyalty (4 subpages) + QR page | ~650 | Table/Form integration, page-by-page consistency |
| **#J** | 3 | Remove old globals.css classes | ~1,480 removed | Nothing broken — CI/lint only |
| **#K** | 4 | Customer-web token swap (all pages) | ~500 | No visual regressions, token mapping completeness |
| — | 5 | Verification (per-PR gate) | 0 | Tests, Lighthouse, visual checks |

---

## Chain Strategy Suggestion

**Recommended chains** (grouped by dependency + reviewer cognitive load):

| Chain | PRs | Rationale |
|-------|-----|-----------|
| **Chain 1: DS Foundation** | #A → #B → #C | Sequential. Each PR depends on the previous. Reviewer sees tokens first, then simple components, then complex ones. |
| **Chain 2: Landing Page** | #D → #E | PR #D is the majority of the visual work. PR #E is smaller (copy + SEO). Can be reviewed together or stacked. |
| **Chain 3: Dashboard Layout** | #F (standalone) | Sidebar + Topbar are the structural backbone. Must be reviewed alone because it changes the layout every dashboard page inherits. |
| **Chain 4: Dashboard Pages** | #G → #H → #I | Pages can be reviewed in any order but depend on #F. #I is largest (4 subpages) — consider splitting loyalty into its own PR if it exceeds 800 lines. |
| **Chain 5: Cleanup** | #J (standalone) | No code risk. CI gate only — remove CSS, verify nothing breaks. Can be merged anytime after #I. |
| **Chain 6: Customer-web** | #K (standalone) | Independent of other chains (only depends on DS package existing). Can be done in parallel with Chains 3–5. |

**Stacking recommendation**: Use stacked PRs (GitHub stack) for Chains 1, 2, and 4. Each PR in the chain targets the previous one as its base, so reviewers see only the diff for their scope. Merge sequentially.

**Parallelization opportunity**: Once PR #C merges, Chains 2, 3, and 6 can all start in parallel.

---

## Task Summary Matrix

| # | Task | Phase | Depends on | Est. lines | PR |
|---|------|-------|-----------|-----------|-----|
| 1.1 | Scaffold package | 1 | — | 40 | #A |
| 1.2 | Token CSS files | 1 | 1.1 | 485 | #A |
| 1.3 | Button component | 1 | 1.2 | 180 | #B |
| 1.4 | Input/Textarea/Select | 1 | 1.2 | 260 | #B |
| 1.5 | Card component | 1 | 1.2 | 170 | #B |
| 1.6 | Badge component | 1 | 1.2 | 80 | #B |
| 1.7 | ProgressBar component | 1 | 1.2 | 90 | #B |
| 1.8 | Avatar component | 1 | 1.2 | 80 | #B |
| 1.9 | Skeleton component | 1 | 1.2 | 100 | #B |
| 1.10 | Modal component | 1 | 1.2, radix | 160 | #C |
| 1.11 | Toast component | 1 | 1.2 | 200 | #C |
| 1.12 | Table component | 1 | 1.2 | 200 | #C |
| 1.13 | Tabs component | 1 | 1.2 | 120 | #C |
| 1.14 | Icons + barrel exports | 1 | 1.1 | 80 | #C |
| 2.1 | Landing route group | 2 | 1.2 | 50 | #D |
| 2.2 | Header nav | 2 | 2.1 | 110 | #D |
| 2.3 | Hero section | 2 | 2.1 | 140 | #D |
| 2.4 | How it works section | 2 | 2.1 | 110 | #D |
| 2.5 | Features section | 2 | 2.1 | 120 | #D |
| 2.6 | Testimonials section | 2 | 2.1 | 90 | #E |
| 2.7 | Pricing section | 2 | 2.1 | 160 | #E |
| 2.8 | FAQ section | 2 | 2.1 | 130 | #E |
| 2.9 | Footer | 2 | 2.1 | 80 | #E |
| 2.10 | SEO setup | 2 | 2.1 | 80 | #E |
| 3.1 | Collapsible sidebar | 3 | 1.2, lucide | 350 | #F |
| 3.2 | Topbar component | 3 | 1.2 | 200 | #F |
| 3.3 | Dashboard home page | 3 | 3.1, 3.2 | 350 | #G |
| 3.4 | Customers list page | 3 | 3.1, 3.2 | 150 | #G |
| 3.5 | Customer detail page | 3 | 3.1, 3.2 | 350 | #H |
| 3.6 | Analytics page | 3 | 3.1, 3.2 | 200 | #H |
| 3.7 | Loyalty pages (4) | 3 | 3.1, 3.2 | 500 | #I |
| 3.8 | QR page | 3 | 3.1, 3.2 | 130 | #I |
| 3.9 | Remove old globals.css | 3 | 3.3–3.8 | -1,480 | #J |
| 4.1 | DS dependency + tokens | 4 | 1.2 | 20 | #K |
| 4.2 | Login/register pages | 4 | 4.1 | 80 | #K |
| 4.3 | Profile page | 4 | 4.1 | 120 | #K |
| 4.4 | History page | 4 | 4.1 | 100 | #K |
| 4.5 | Rewards page | 4 | 4.1 | 100 | #K |
| 4.6 | Remove old customer-web CSS | 4 | 4.2–4.5 | -80 | #K |
| 5.1–5.5 | Verification | 5 | All | 0 | Per-PR |
