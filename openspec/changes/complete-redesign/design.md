# Design: Complete Redesign

**Change**: `complete-redesign`
**Status**: Design phase
**Priority**: Design System → Landing Page → Dashboard → Customer-web

---

## Quick path

1. Create `packages/design-system/` with tokens, components, styles (no build step, source exports)
2. Import tokens in both Next.js apps, verify zero visual regressions
3. Build landing page route group in dashboard app (server components, SSR)
4. Replace dashboard CSS globals with DS components page by page
5. Swap customer-web hardcoded values with DS tokens

---

## 1. Package Architecture: `@vyloop/design-system`

### 1.1 Build Decision: No Build Step

**Decision**: Export TypeScript source + CSS Modules directly. No Vite, no tsc compilation.

**Rationale**:
- Every existing package (`@vyloop/db`, `@vyloop/types`) uses `"exports": { ".": "./src/index.ts" }` — raw source, no build
- Both consumers are Next.js apps that natively compile TypeScript and CSS Modules during their own build
- Adding a build step (Vite/Rollup) adds complexity, a dev dependency, and a `preinstall` step in CI with zero benefit for this monorepo topology
- CSS files from workspace packages resolve correctly because pnpm creates symlinks in `node_modules`, and Next.js follows them

**The constraint**: consumers MUST use Next.js (they already do). If someone needs to consume the DS outside a Next.js build in the future, we add a build step then.

### 1.2 `package.json` Export Map

```jsonc
{
  "name": "@vyloop/design-system",
  "version": "0.1.0",
  "private": true,
  "exports": {
    ".": "./src/index.ts",                    // components barrel
    "./tokens": "./src/tokens/index.css",     // global CSS tokens
    "./styles": "./src/styles/index.css",     // reset + utilities
    "./tokens/*": "./src/tokens/*.css"        // individual token files
  },
  "peerDependencies": {
    "lucide-react": "^0.400.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  }
}
```

### 1.3 Directory Layout

```
packages/design-system/
├── package.json
├── tsconfig.json                    # extends ../../tsconfig.json
├── vitest.config.ts
├── src/
│   ├── index.ts                     # barrel: exports all components
│   ├── tokens/
│   │   ├── index.css                # @import of all token files
│   │   ├── colors.css               # brand, semantic, neutral, surface, border, text, shadow
│   │   ├── typography.css           # font families, type scale, weights, line heights
│   │   ├── spacing.css              # 4px-base space scale
│   │   ├── radius.css               # border radius scale
│   │   ├── shadows.css              # elevation system
│   │   └── transitions.css          # timing + easing
│   ├── components/
│   │   ├── index.ts                 # barrel re-export
│   │   ├── button/
│   │   │   ├── Button.tsx
│   │   │   ├── Button.module.css
│   │   │   └── index.ts
│   │   ├── input/
│   │   │   ├── Input.tsx
│   │   │   ├── Input.module.css
│   │   │   └── index.ts
│   │   ├── textarea/
│   │   │   ├── Textarea.tsx
│   │   │   ├── Textarea.module.css
│   │   │   └── index.ts
│   │   ├── select/
│   │   │   ├── Select.tsx
│   │   │   ├── Select.module.css
│   │   │   └── index.ts
│   │   ├── card/
│   │   │   ├── Card.tsx             # Card + Card.Header + Card.Body + Card.Footer
│   │   │   ├── Card.module.css
│   │   │   └── index.ts
│   │   ├── modal/
│   │   │   ├── Modal.tsx            # Radix Dialog wrapper
│   │   │   ├── Modal.module.css
│   │   │   └── index.ts
│   │   ├── badge/
│   │   │   ├── Badge.tsx
│   │   │   ├── Badge.module.css
│   │   │   └── index.ts
│   │   ├── toast/
│   │   │   ├── Toast.tsx            # Toast component + ToastContainer
│   │   │   ├── Toast.module.css
│   │   │   └── index.ts
│   │   ├── table/
│   │   │   ├── Table.tsx            # Generic typed Table<T>
│   │   │   ├── Table.module.css
│   │   │   └── index.ts
│   │   ├── tabs/
│   │   │   ├── Tabs.tsx
│   │   │   ├── Tabs.module.css
│   │   │   └── index.ts
│   │   ├── progress-bar/
│   │   │   ├── ProgressBar.tsx
│   │   │   ├── ProgressBar.module.css
│   │   │   └── index.ts
│   │   ├── avatar/
│   │   │   ├── Avatar.tsx
│   │   │   ├── Avatar.module.css
│   │   │   └── index.ts
│   │   └── skeleton/
│   │       ├── Skeleton.tsx
│   │       ├── Skeleton.module.css
│   │       └── index.ts
│   └── styles/
│       ├── reset.css                # modern CSS reset
│       ├── utilities.css            # .flex, .grid, .text-* helpers
│       └── index.css                # @import reset + utilities
```

### 1.4 Tree-shaking

No bundler-level tree-shaking is needed. Next.js uses Webpack (or Turbopack) which:
- Only imports the JS modules used by the importing app
- CSS Modules are scoped per-component and only loaded when the component is rendered
- `lucide-react` is tree-shakeable at the import statement level (`import { Users } from 'lucide-react'`)

### 1.5 Dependency Installation

In both consuming apps:

```bash
pnpm add @vyloop/design-system@workspace:* lucide-react@^0.400.0
```

The `@radix-ui/react-dialog` dependency lives in `@vyloop/design-system`.

### 1.6 CSS Import in App Layouts

```tsx
// apps/dashboard/src/app/layout.tsx (and customer-web equivalent)
import '@vyloop/design-system/tokens';
import '@vyloop/design-system/styles';
```

---

## 2. Token Design (CSS Custom Properties)

All tokens live on `:root`. The `--vy-` prefix is omitted (brand is the only context, so `--brand-500` is unambiguous). Token files are plain CSS — no preprocessor, no variables-in-JS.

### 2.1 Brand Palette — Amber/Gold

Values are defined in both OKLCH (perceptual uniformity) and hex fallback for browser compatibility. The OKLCH version is primary; hex is for browsers that don't support OKLCH (very few in 2026).

```css
/* colors.css */

:root {
  /* ── Brand Palette (Amber/Gold) ── */
  --brand-50:  oklch(0.987 0.026 95.5);
  --brand-100: oklch(0.945 0.056 95.5);
  --brand-200: oklch(0.887 0.12 93.5);
  --brand-300: oklch(0.822 0.162 91.5);
  --brand-400: oklch(0.762 0.172 87.5);
  --brand-500: oklch(0.683 0.18 82.5);   /* Primary */
  --brand-600: oklch(0.586 0.174 72.5);  /* Hover */
  --brand-700: oklch(0.502 0.158 62.5);  /* Active/pressed */
  --brand-800: oklch(0.424 0.132 54.5);  /* Text on light */
  --brand-900: oklch(0.352 0.108 48.5);  /* Deepest */
}
```

### 2.2 Neutral / Stone Scale

Warm stone with a consistent amber undertone (hue ~67.5°). Every value is slightly warm — never a cold gray.

```css
:root {
  --stone-50:  oklch(0.975 0.004 67.5);  /* Page bg */
  --stone-100: oklch(0.955 0.005 67.5);  /* Card bg, elevated */
  --stone-150: oklch(0.935 0.006 67.5);  /* Hover on cards, input bg */
  --stone-200: oklch(0.915 0.006 67.5);  /* Border default */
  --stone-300: oklch(0.86 0.007 67.5);   /* Border light */
  --stone-400: oklch(0.686 0.01 67.5);   /* Text muted, placeholder */
  --stone-500: oklch(0.511 0.012 67.5);  /* Text secondary */
  --stone-600: oklch(0.389 0.013 67.5);  /* Text body */
  --stone-700: oklch(0.307 0.013 67.5);  /* Text primary */
  --stone-800: oklch(0.215 0.012 67.5);  /* Text headings */
  --stone-900: oklch(0.146 0.008 67.5);  /* Text darkest */
}
```

### 2.3 Semantic Colors

```css
:root {
  /* Success — green, warm-leaning */
  --success:       oklch(0.58 0.16 145);
  --success-bg:    oklch(0.97 0.02 145);
  --success-border: oklch(0.88 0.08 145);

  /* Error — red */
  --error:         oklch(0.55 0.22 28);
  --error-bg:      oklch(0.97 0.02 28);
  --error-border:  oklch(0.88 0.08 28);

  /* Warning — gold (same hue as brand) */
  --warning:       oklch(0.68 0.18 82.5);  /* = brand-500 */
  --warning-bg:    oklch(0.97 0.03 82.5);
  --warning-border: oklch(0.89 0.1 82.5);

  /* Info — blue */
  --info:          oklch(0.55 0.18 260);
  --info-bg:       oklch(0.96 0.02 260);
  --info-border:   oklch(0.86 0.06 260);
}
```

### 2.4 Foreground / Text Tokens

```css
:root {
  --text-primary:    var(--stone-800);  /* Headings, bold body */
  --text-body:       var(--stone-600);  /* Paragraphs, labels */
  --text-secondary:  var(--stone-500);  /* Supporting text, metadata */
  --text-muted:      var(--stone-400);  /* Placeholders, disabled */
  --text-inverse:    oklch(1 0 0);      /* White — text on brand/dark surfaces */
}
```

### 2.5 Surface / Background Tokens

```css
:root {
  --surface-page:    var(--stone-50);   /* Canvas bg */
  --surface-card:    oklch(1 0 0);      /* White — cards, modals, dropdowns */
  --surface-elevated: oklch(1 0 0);     /* Popovers, tooltips */
  --surface-sidebar: var(--stone-900);  /* Dark sidebar bg */
  --surface-topbar:  oklch(1 0 0);      /* Top bar bg */
  --surface-input:   oklch(1 0 0);      /* Input fields */
  --surface-overlay: oklch(0.146 0.008 67.5 / 0.5);  /* Modal backdrops */
}
```

### 2.6 Border Tokens

```css
:root {
  --border:        var(--stone-200);    /* Default borders */
  --border-light:  var(--stone-100);    /* Subtle dividers */
  --border-input:  var(--stone-300);    /* Input borders */
  --border-focus:  var(--brand-500);    /* Focus ring */
  --border-error:  var(--error);        /* Error borders */
}
```

### 2.7 Typography

```css
/* typography.css */

:root {
  /* ── Font Families ── */
  --font-display: 'Sora', system-ui, sans-serif;
  --font-body:    'Inter', system-ui, sans-serif;
  --font-mono:    'JetBrains Mono', 'SF Mono', ui-monospace, monospace;

  /* ── Type Scale (ratio ~1.25) ── */
  --text-xs:   0.75rem;    /* 12px — Captions, metadata */
  --text-sm:   0.8125rem;  /* 13px — Labels, hints, table cells */
  --text-base: 0.875rem;   /* 14px — Body, buttons, inputs */
  --text-lg:   1rem;       /* 16px — Large body, card titles */
  --text-xl:   1.125rem;   /* 18px — Section headings */
  --text-2xl:  1.25rem;    /* 20px — Page titles */
  --text-3xl:  1.5rem;     /* 24px — Hero subtitles */
  --text-4xl:  1.875rem;   /* 30px — Hero main */
  --text-5xl:  2.25rem;    /* 36px — Large headings */
  --text-6xl:  3rem;       /* 48px — Display (landing page) */

  /* ── Line Heights ── */
  --leading-none:   1;
  --leading-tight:  1.15;
  --leading-snug:   1.3;
  --leading-normal: 1.5;
  --leading-relaxed: 1.625;

  /* ── Font Weights ── */
  --font-normal:     400;
  --font-medium:     500;
  --font-semibold:   600;
  --font-bold:       700;
  --font-extrabold:  800;

  /* ── Letter-spacing defaults per size ── */
  /* xs-sm-base: normal | lg-xl: -0.01em | 2xl-3xl: -0.02em | 4xl+: -0.03em */
}
```

### 2.8 Spacing (4px Base)

```css
:root {
  --space-0:  0;
  --space-1:  4px;
  --space-2:  8px;
  --space-3:  12px;
  --space-4:  16px;
  --space-5:  20px;
  --space-6:  24px;
  --space-8:  32px;
  --space-10: 40px;
  --space-12: 48px;
  --space-16: 64px;
}
```

### 2.9 Border Radius

```css
:root {
  --radius-sm:   4px;    /* Inputs, buttons, badges */
  --radius-md:   8px;    /* Cards, dropdowns */
  --radius-lg:   12px;   /* Modals, dialogs */
  --radius-xl:   16px;   /* Cards in customer-web */
  --radius-full: 9999px; /* Pills, avatars, tabs */
}
```

### 2.10 Shadows / Elevation

```css
:root {
  /* Shadow base uses #1c1917 (stone-900) — warm shadows, not black */
  --shadow-sm: 0 1px 2px rgba(28, 25, 23, 0.05);
  --shadow-md: 0 1px 3px rgba(28, 25, 23, 0.08), 0 1px 2px rgba(28, 25, 23, 0.04);
  --shadow-lg: 0 4px 6px rgba(28, 25, 23, 0.06), 0 2px 4px rgba(28, 25, 23, 0.05);
  --shadow-xl: 0 10px 15px rgba(28, 25, 23, 0.08), 0 4px 6px rgba(28, 25, 23, 0.04);

  /* Focus rings — brand glow */
  --shadow-ring:      0 0 0 3px oklch(0.683 0.18 82.5 / 0.15);
  --shadow-ring-error: 0 0 0 3px oklch(0.55 0.22 28 / 0.15);
}
```

### 2.11 Transitions

```css
:root {
  --transition-fast: 120ms ease;
  --transition-base: 200ms ease;
  --transition-slow: 300ms ease;
  --ease-out:        cubic-bezier(0.23, 1, 0.32, 1);
}
```

### 2.12 Breakpoints

CSS media queries directly — not custom properties (they can't be used in media queries).

```css
/* Mobile-first. Base = mobile. */
/* @media (min-width: 640px)  — large phones */
/* @media (min-width: 768px)  — tablets / sidebar collapse breakpoint */
/* @media (min-width: 1024px) — desktop */
/* @media (min-width: 1280px) — wide desktop */
/* @media (min-width: 1536px) — max content width */
```

---

## 3. Component API Design

### 3.1 Button

```tsx
interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** Visual style variant */
  variant?: 'primary' | 'secondary' | 'ghost' | 'outline' | 'danger';
  /** Size preset */
  size?: 'sm' | 'md' | 'lg';
  /** Shows a spinner and disables interaction */
  loading?: boolean;
  /** Icon slot (left / leading) */
  icon?: React.ReactNode;
  /** Icon slot (right / trailing) */
  iconRight?: React.ReactNode;
  /** Stretches to fill parent width */
  fullWidth?: boolean;
}

// Forwarded ref: React.Ref<HTMLButtonElement>
```

| Variant | Background | Text | Border | Hover bg |
|---------|-----------|------|--------|----------|
| primary | `--brand-500` | `--text-inverse` | `--brand-500` | `--brand-600` |
| secondary | `--surface-card` | `--text-primary` | `--border` | `--stone-100` |
| ghost | transparent | `--text-secondary` | transparent | `--stone-100` |
| outline | transparent | `--brand-500` | `--brand-500` | `--brand-50` |
| danger | `--error` | `--text-inverse` | `--error` | `oklch(0.45 0.2 28)` |

| Size | Height | Padding-x | Font | Radius |
|------|--------|-----------|------|--------|
| sm | 32px | `--space-3` | `--text-sm` | `--radius-sm` |
| md | 40px | `--space-4` | `--text-base` | `--radius-md` |
| lg | 48px | `--space-5` | `--text-lg` | `--radius-md` |

**States**: default, hover (on non-disabled, +1 step bg), active (`scale(0.97)` transform), focus (ring via `--shadow-ring`), disabled (opacity 0.5, cursor not-allowed, no hover), loading (spinner replaces icon, disabled behavior).

**Accessibility**: `<button>` native element. `aria-busy={loading}`, `aria-disabled={disabled || loading}`. Loading state preserves button text for screen readers (visually hidden spinner + text).

**CSS Module approach**: Variants as CSS classes, not inline styles. Composition via `composes`.

### 3.2 Input / Textarea / Select

```tsx
interface InputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size'> {
  /** Label displayed above the input */
  label?: string;
  /** Helper text below the input */
  hint?: string;
  /** Error message (shows error state) */
  error?: string;
  /** Icon slot on the left side */
  leftIcon?: React.ReactNode;
  /** Stretches to fill parent width */
  fullWidth?: boolean;
}

interface TextareaProps extends Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'size'> {
  label?: string;
  hint?: string;
  error?: string;
  fullWidth?: boolean;
  /** Fixed rows (default: 3) */
  rows?: number;
}

interface SelectProps extends Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'size'> {
  label?: string;
  hint?: string;
  error?: string;
  options: { value: string; label: string }[];
  placeholder?: string;
  fullWidth?: boolean;
}
```

**Styling** (shared across all three):
- Height: 40px (Input/Select), variable (Textarea)
- Background: `--surface-input`
- Border: `--border-input`
- Radius: `--radius-md`
- Text: 14px, `--text-body`
- Focus: `--border-focus` + `--shadow-ring`
- Error: `--border-error` + `--shadow-ring-error`
- Disabled: opacity 0.5, cursor not-allowed
- Placeholder: `--text-muted`

**States**: default, focus, error, disabled, hover (border lightens slightly).

**Accessibility**: Native `<input>` / `<textarea>` / `<select>` elements. `aria-describedby` linking to hint/error. `aria-invalid` when error present. `aria-required` when required.

### 3.3 Card

```tsx
interface CardProps {
  /** Visual variant */
  variant?: 'default' | 'elevated' | 'outlined';
  /** Padding density */
  padding?: 'sm' | 'md' | 'lg';
  className?: string;
  children?: React.ReactNode;
}

// Sub-components: compound pattern
Card.Header: { title: React.ReactNode; action?: React.ReactNode; className?: string }
Card.Body:   { children?: React.ReactNode; className?: string }
Card.Footer: { children?: React.ReactNode; className?: string }
```

| Variant | Background | Border | Shadow |
|---------|-----------|--------|--------|
| default | `--surface-card` | `--border` | `--shadow-sm` |
| elevated | `--surface-card` | none | `--shadow-md` |
| outlined | transparent | `--border` | none |

**Header**: flex row, `--space-5` padding, bottom separator. Title uses `--text-lg` `--font-semibold`. Action slot right-aligned.

**Body**: `--space-5` padding.

**Footer**: `--space-4` padding, top separator, right-aligned flex (actions).

**Accessibility**: `role="region"` when it has a header. `aria-labelledby` pointing to header title.

### 3.4 Modal / Dialog

```tsx
interface ModalProps {
  /** Controls visibility */
  open: boolean;
  /** Called when the modal should close */
  onClose: () => void;
  /** Modal title */
  title: string;
  /** Optional description (rendered below title) */
  description?: string;
  /** Width preset */
  size?: 'sm' | 'md' | 'lg';
  children?: React.ReactNode;
  /** Custom footer actions (default: close button only) */
  footer?: React.ReactNode;
}
```

**Implementation**: Uses `@radix-ui/react-dialog` under the hood for:
- Focus trap
- Escape key handling
- Click outside dismiss
- ARIA dialog role + labelling
- Scroll lock on body

**Sizing**: sm = 400px, md = 520px, lg = 640px max-width.

**Content**: Card-like: overlay + centered panel. Overlay: `--surface-overlay`. Panel: `--surface-card`, `--radius-lg`, `--shadow-xl`.

**Header**: Title + close button (X icon) top-right.

**Transition**: Enter/exit via opacity + scale(0.95 → 1), 200ms `--ease-out`.

### 3.5 Badge

```tsx
interface BadgeProps {
  variant?: 'default' | 'success' | 'warning' | 'error' | 'info';
  size?: 'sm' | 'md';
  /** Shows a colored dot indicator before text */
  dot?: boolean;
  children: React.ReactNode;
  className?: string;
}
```

| Variant | Background | Text | Border |
|---------|-----------|------|--------|
| default | `--brand-50` | `--brand-700` | `--brand-200` |
| success | `--success-bg` | `--success` | `--success-border` |
| warning | `--warning-bg` | `--warning` | `--warning-border` |
| error | `--error-bg` | `--error` | `--error-border` |
| info | `--info-bg` | `--info` | `--info-border` |

**Sizes**: sm (20px height, 10px font), md (24px height, 12px font).

**Accessibility**: When used as a status indicator, include `role="status"` and an `aria-label` if icon-only.

### 3.6 Toast / Notification

```tsx
interface ToastProps {
  type: 'success' | 'error' | 'warning' | 'info';
  title: string;
  description?: string;
  /** Optional action button */
  action?: { label: string; onClick: () => void };
  /** Auto-dismiss duration in ms (default: 4000, 0 = no dismiss) */
  duration?: number;
  /** Called when toast is dismissed */
  onDismiss: () => void;
}

// Container
interface ToastContainerProps {
  children?: React.ReactNode;
}
```

**States**: entering (slide up + fade, 200ms `--ease-out`), idle, exiting (fade out, 150ms).

**Behavior**:
- Fixed bottom-right, stack upwards with `--space-2` gap
- Auto-dismiss after `duration` with a linear progress bar indicating remaining time
- Pause timer on hover
- Close button (X icon) for manual dismiss
- Max 5 visible toasts, oldest pushed out

**Accessibility**: `role="alert"` or `role="status"` depending on type. `aria-live="polite"` on container.

### 3.7 Table

```tsx
interface TableProps<T extends Record<string, unknown>> {
  columns: TableColumn<T>[];
  data: T[];
  /** Unique key extractor (default: index) */
  rowKey?: (row: T) => string | number;
  /** Loading skeleton state */
  loading?: boolean;
  /** Message when data is empty */
  emptyMessage?: string;
  /** Row click handler */
  onRowClick?: (row: T) => void;
  /** Enable column sorting by clicking headers */
  sortable?: boolean;
  /** Initial sort column key */
  defaultSortKey?: string;
  /** Initial sort direction */
  defaultSortDirection?: 'asc' | 'desc';
}

interface TableColumn<T> {
  key: string;
  header: string;
  /** Custom cell renderer */
  render?: (value: unknown, row: T, index: number) => React.ReactNode;
  /** Cell alignment */
  align?: 'left' | 'center' | 'right';
  sortable?: boolean;
  /** Column width (CSS value) */
  width?: string;
  /** Column min-width (CSS value) */
  minWidth?: string;
}
```

**Styling**:
- Full-width, border-collapse
- Header: uppercase 11px, `--text-secondary`, subtle bottom border
- Rows: alternating `--surface-page` on even
- Hover: subtle background shift
- Clickable rows: `cursor: pointer`
- Responsive: horizontal scroll container on narrow viewports

**Loading**: 5 skeleton rows matching column count.

**Empty**: Centered message with optional illustration slot (deferred).

**Accessibility**: `<table>` with `<thead>`, `<tbody>`, `<th scope="col">`. Sortable columns get `aria-sort="ascending|descending"`. Clickable rows get `tabindex="0"` and keyboard Enter handler.

### 3.8 Tabs

```tsx
interface TabsProps {
  tabs: { id: string; label: string; icon?: React.ReactNode }[];
  activeTab: string;
  onChange: (tabId: string) => void;
  variant?: 'underline' | 'pills';
}
```

| Variant | Active indicator |
|---------|-----------------|
| underline | Bottom border on active tab (2px, `--brand-500`) |
| pills | Filled bg on active tab (`--brand-50` bg, `--brand-600` text) |

**Accessibility**: `role="tablist"` on container, `role="tab"` on each tab, `role="tabpanel"` on content. Arrow key navigation between tabs. `aria-selected` on active tab.

### 3.9 Progress Bar

```tsx
interface ProgressBarProps {
  /** Value 0-100 */
  value: number;
  size?: 'sm' | 'md' | 'lg';
  color?: 'brand' | 'success' | 'warning';
  /** Show percentage label on the right */
  showLabel?: boolean;
  /** Animated fill transition */
  animated?: boolean;
}
```

| Size | Height |
|------|--------|
| sm | 4px |
| md | 8px |
| lg | 12px |

**Track**: `--stone-100` background, `--radius-full`.

**Fill**: `--brand-500` (default), `--success` or `--warning`. Transition: width 0.4s `--ease-out`.

**Accessibility**: `role="progressbar"`, `aria-valuenow={value}`, `aria-valuemin={0}`, `aria-valuemax={100}`.

### 3.10 Avatar

```tsx
interface AvatarProps {
  /** Image URL */
  src?: string;
  /** Alt text (required) */
  alt: string;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  /** Fallback initials (shown when no src or image fails) */
  fallback?: string;
}
```

| Size | Dimension | Font |
|------|-----------|------|
| sm | 32px | 12px |
| md | 40px | 14px |
| lg | 48px | 18px |
| xl | 64px | 24px |

**Behavior**: Shows `<img>` when `src` is provided, shows `fallback` initials when no `src` or on image error. Fallback bg: `--brand-100`, text: `--brand-700`.

**Accessibility**: `<img>` with `alt` text. If initials are shown with no semantic meaning, `aria-hidden="true"`.

### 3.11 Skeleton / Loading

```tsx
interface SkeletonProps {
  variant: 'text' | 'circular' | 'rectangular';
  width?: string | number;
  height?: string | number;
  /** Repeat count for text lines */
  count?: number;
  className?: string;
}
```

| Variant | Shape | Default size |
|---------|-------|-------------|
| text | block with radius | 100% × 14px |
| circular | circle | 40px × 40px |
| rectangular | rectangle | 100% × 100px |

**Animation**: Shimmer via `@keyframes` — gradient sweep across `--stone-100` background using `--stone-200` highlight. `background-size: 200% 100%`, animation 1.5s infinite.

**Accessibility**: `aria-busy="true"` on parent container. `role="status"` with a `sr-only` "Loading..." label.

---

## 4. Icon System

**Decision**: Import `lucide-react` icons directly. No wrapper, no re-export layer.

```tsx
// Direct import — tree-shaken by default
import { Users, Star, Settings, BarChart3 } from 'lucide-react';
```

**Semantic icon mapping** (used by sidebar nav, dashboard KPI cards):

```tsx
// packages/design-system/src/lib/icon-map.ts (optional, not re-exported from barrel)
const NAV_ICONS = {
  dashboard: LayoutDashboard,
  customers: Users,
  analytics: BarChart3,
  loyalty: Settings,
  tiers: Layers,
  rewards: Star,
  qr: QrCode,
  settings: Settings,
  logout: LogOut,
} as const;
```

---

## 5. Sidebar Architecture

### 5.1 State Management

```tsx
// packages/design-system/src/lib/sidebar-context.tsx

interface SidebarState {
  /** Desktop: icon-only vs expanded. Mobile: drawer open/closed */
  collapsed: boolean;
  /** Only relevant on mobile */
  isMobile: boolean;
  toggle: () => void;
  /** Open/close on mobile overlay */
  openMobile: () => void;
  closeMobile: () => void;
}
```

**Implementation**:
- React Context provider wrapping the dashboard layout
- `collapsed` initializes from `localStorage.getItem('vy-sidebar-collapsed') === 'true'`
- `isMobile` is a `useSyncExternalStore` subscription to `window.matchMedia('(max-width: 767px)')`
- On mobile, `collapsed` is forced to `true` (icon-only mode doesn't exist — instead, the drawer is hidden until toggled open)
- Desktop toggle saves to `localStorage`

### 5.2 Responsive Behavior

| Viewport | Behavior |
|----------|----------|
| ≥ 768px (desktop) | Sidebar fixed, `260px` or `64px` based on toggle. Content margin adjusts. |
| < 768px (mobile) | Sidebar hidden by default. Hamburger button in topbar opens a drawer overlay. Backdrop click or Escape closes. |

### 5.3 Overlay Drawer (Mobile)

On mobile (< 768px), the sidebar becomes a slide-in drawer:
- Translates from left: `transform: translateX(-100%)` → `translateX(0)`
- Backdrop: `--surface-overlay`, click to close
- Content area: full width (no margin shift)
- Escape key closes

Uses native CSS transitions. No external library needed — this is a fixed-position panel, not a focus-managed dialog.

Alternatively, if focus trapping is required, wrap in a `<Dialog>` from Radix configured as a drawer.

### 5.4 Navigation Data Structure

```tsx
interface NavItem {
  id: string;
  label: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  /** Active if pathname starts with this (prefix match) */
  activeMatch?: string;
  /** Section grouping (renders a label above) */
  section?: string;
  /** Bottom section (settings, logout) */
  isBottom?: boolean;
  /** Logout action (not a link) */
  isAction?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  // Navegación
  { id: 'dashboard', label: 'Panel Principal', href: '/dashboard', icon: LayoutDashboard },
  { id: 'customers', label: 'Clientes', href: '/dashboard/customers', icon: Users },
  // Lealtad
  { id: 'loyalty-config', label: 'Configuración', href: '/dashboard/loyalty/config', icon: Settings, section: 'Lealtad' },
  { id: 'loyalty-tiers', label: 'Niveles', href: '/dashboard/loyalty/tiers', icon: Layers },
  { id: 'loyalty-rewards', label: 'Recompensas', href: '/dashboard/loyalty/rewards', icon: Star },
  { id: 'loyalty-points', label: 'Puntos', href: '/dashboard/loyalty/customers', icon: Coins },
  // Comercio
  { id: 'qr', label: 'QR del Negocio', href: '/dashboard/qr', icon: QrCode, section: 'Comercio' },
  // Bottom
  { id: 'settings', label: 'Configuración', href: '/dashboard/settings', icon: Settings, isBottom: true },
  { id: 'logout', label: 'Cerrar Sesión', href: '#', icon: LogOut, isBottom: true, isAction: true },
];
```

### 5.5 Active Matching Logic

```tsx
function isActive(pathname: string, item: NavItem): boolean {
  if (item.isAction) return false;
  if (item.href === '/dashboard') return pathname === '/dashboard';
  return pathname.startsWith(item.href);
}
```

### 5.6 Animation

- Desktop collapse: `width` transition on sidebar, `margin-left` on content — 200ms `--transition-base`
- Mobile drawer: `transform` transition on drawer panel, `opacity` on backdrop — 250ms `--ease-out`
- Only animate `transform` and `opacity` on mobile drawer (GPU-composited)

---

## 6. Landing Page Technical Design

### 6.1 Route Group Structure

```
apps/dashboard/src/app/
├── (landing)/                   # Route group — no layout inheritance from root
│   ├── layout.tsx               # Landing-specific layout (no auth, no sidebar, Inter + Sora via next/font)
│   ├── page.tsx                  # Home page (server component)
│   ├── page.module.css           # Landing page styles
│   ├── seo.ts                    # Metadata + JSON-LD structured data
│   └── components/
│       ├── Hero.tsx              # Server component
│       ├── Hero.module.css
│       ├── HowItWorks.tsx
│       ├── Features.tsx
│       ├── Testimonials.tsx
│       ├── Pricing.tsx
│       ├── FAQ.tsx
│       ├── Footer.tsx
│       └── Header.tsx            # Nav bar with CTAs
├── layout.tsx                    # Root layout (with AuthProvider, globals.css import)
├── login/
│   └── page.tsx
└── dashboard/
    └── layout.tsx                # Dashboard layout (sidebar + topbar)
```

### 6.2 Styling Approach: CSS Modules

**Decision**: CSS Modules, NOT Tailwind for the landing page.

**Rationale**:
- The entire codebase uses flat CSS and CSS Modules (no Tailwind precedent)
- The landing page shares no component reuse with the DS (which also uses CSS Modules)
- Tailwind would add a new styling paradigm, a `tailwind.config`, PostCSS plugin, and mental overhead for a single page group
- CSS Modules are colocated, scoped by default, and use the same token system (`var(--brand-500)`)

Landing-specific styles live in `(landing)/components/*.module.css`. These import tokens from `@vyloop/design-system/tokens` via `@import` or use `var()` references.

### 6.3 Font Loading

```tsx
// (landing)/layout.tsx
import { Inter, Sora } from 'next/font/google';

const inter = Inter({ subsets: ['latin'], variable: '--font-body' });
const sora = Sora({ subsets: ['latin'], variable: '--font-display' });

export default function LandingLayout({ children }) {
  return (
    <html lang="es" className={`${inter.variable} ${sora.variable}`}>
      <body>{children}</body>
    </html>
  );
}
```

The root layout (dashboard's `app/layout.tsx`) also needs these variables. To avoid duplicate font loading:
- Load fonts in each layout that needs them (Next.js deduplicates via `next/font`)
- Both root and landing layouts declare the same `--font-body` and `--font-display` variables

### 6.4 Image Optimization Strategy

| Image type | Approach |
|-----------|---------|
| Hero visual | `<Image>` from `next/image` with `priority`, `fill` or fixed dimensions |
| Icons | `lucide-react` components (inline SVG, no loading) |
| Testimonial avatars | `<Image>` with `loading="lazy"` |
| OG Image | Static file or `@vercel/og` (Satori) — static export is simpler |

Images stored in `apps/dashboard/public/landing/`.

### 6.5 SEO

**Metadata API** (Next.js App Router):

```tsx
// (landing)/seo.ts
import type { Metadata } from 'next';

export const landingMetadata: Metadata = {
  title: 'Vyloop — Fideliza a tus clientes sin complicarte',
  description: 'Crea un programa de lealtad en minutos. Tus clientes acumulan puntos, tú retienes más. Sin contratos ni tecnicismos.',
  openGraph: {
    title: 'Vyloop — Lealtad para tu negocio',
    description: 'Programa de lealtad simple para negocios en Latinoamérica.',
    url: 'https://vyloop.com',
    siteName: 'Vyloop',
    locale: 'es_LA',
    type: 'website',
    images: [{ url: '/og.png', width: 1200, height: 630 }],
  },
  twitter: { card: 'summary_large_image' },
  robots: { index: true, follow: true },
};
```

**JSON-LD Structured Data**:

```tsx
// Rendered as a <script> tag in the layout
const jsonLd = {
  '@context': 'https://schema.org',
  '@type': 'SoftwareApplication',
  name: 'Vyloop',
  applicationCategory: 'BusinessApplication',
  operatingSystem: 'Web',
  description: 'Programa de lealtad para pequeñas y medianas empresas en Latinoamérica.',
  offers: {
    '@type': 'Offer',
    price: '0',
    priceCurrency: 'USD',
  },
};
```

---

## 7. Token Migration Strategy

### 7.1 Phase 0: Foundation (Design System Package)

Files to create:
- `packages/design-system/src/tokens/*.css` (all token files)
- `packages/design-system/src/styles/reset.css` + `utilities.css`
- `packages/design-system/src/components/*` (all 11 primitives)
- `packages/design-system/package.json`
- `packages/design-system/tsconfig.json`
- `packages/design-system/vitest.config.ts`

No app changes in this phase.

### 7.2 Phase 1: Token Import

1. Add `@vyloop/design-system` and `lucide-react` deps to both apps
2. Import tokens CSS in both root layouts
3. Verify zero visual regressions (tokens are additive — old CSS still takes precedence)
4. Add `inter` and `sora` font variables to both layouts

**Rollback**: Remove the import lines and dependencies.

### 7.3 Phase 2: Component Replacement (Page by Page)

Order:
1. **Landing page** (new code, no migration needed — built with DS from start)
2. **Dashboard layout** — replace sidebar inline SVG icons with `lucide-react`, replace brand text with DS tokens
3. **Dashboard home** — KPI cards → `Card`, inline SVGs → Lucide
4. **Customers list** — `<table>` → `Table`, badges → `Badge`, search → `Input`
5. **Customer detail** — hero section → `Card` + `Avatar`, badges → `Badge`
6. **Analytics** — restyle cards, buttons with DS
7. **Loyalty pages** — restyle cards, tables, badges, progress bars
8. **QR page** — restyle with DS components

Each page replacement is a self-contained commit.

### 7.4 Phase 3: Cleanup

1. Remove old `.card`, `.btn-*`, `.badge-*`, `.form-control`, `.modal-*` classes from `globals.css`
2. Remove `@vyloop/design-system/styles/index.css` if reset/utilities are now covered by the DS
3. Verify no remaining references to old class names

### 7.5 Customer-web Alignment

Same pattern: remove `packages/customer-web/src/styles/*.css` hardcoded values, import DS tokens, replace component classes.

---

## 8. CSS Module Patterns

### 8.1 File Naming Convention

- `ComponentName.module.css` for each component
- CSS classes use `camelCase` (auto-exported as object properties by CSS Modules)
- `composes` for shared animation keyframes and utility patterns

### 8.2 Token Reference Pattern

```css
/* Button.module.css */
.button {
  font-family: var(--font-body);
  font-size: var(--text-base);
  border-radius: var(--radius-md);
  transition: background var(--transition-fast),
              transform var(--transition-fast),
              box-shadow var(--transition-fast);
}

.primary {
  background: var(--brand-500);
  color: var(--text-inverse);
  border: 1px solid var(--brand-500);
}

.primary:hover:not(:disabled) {
  background: var(--brand-600);
}
```

### 8.3 Concentric Radius Rule

When nesting a rounded element inside another, outer radius = inner radius + padding. Example: Modal (`--radius-lg` = 12px) containing a Card (padding 16px, so card radius = 12 - 16... wait, that's negative). The rule applies the other way: the outer container has a larger radius than inner elements.

For modal: outer container `--radius-lg` (12px), inner header/body sections have no radius (square corners relative to the container).

---

## 9. Testing Strategy

### 9.1 Token Tests (Vitest)

```tsx
// packages/design-system/src/tokens/__tests__/colors.test.ts
import { describe, it, expect } from 'vitest';

describe('brand tokens', () => {
  it('brand-500 is darker than brand-400', () => {
    // Parse OKLCH lightness values and verify ordering
  });

  it('all semantic colors have corresponding bg and border tokens', () => {
    // Verify --success, --success-bg, --success-border all exist
  });
});
```

### 9.2 Component Tests (Vitest + @testing-library/react)

Each component gets:
- Renders without crashing
- Renders all variants
- Handles all states (loading, disabled, error)
- Forwards ref
- Accepts className override
- Accessibility checks (jest-axe or similar)

### 9.3 Visual Regression Tests

Consider adding Storybook in a future iteration. For now, manual visual verification during Phase 2 + Phase 3.

---

## 10. Key Technical Decisions Summary

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Build tool for DS | None (source exports) | Matches monorepo pattern, Next.js compiles TS + CSS Modules |
| CSS approach | CSS Custom Properties + CSS Modules | No new dependencies, native scoping, token-driven |
| Icon library | lucide-react | Tree-shakeable ESM, consistent 24px grid |
| Modal primitive | Radix Dialog | Focus trap, keyboard nav, ARIA — free |
| Sidebar state | React Context + localStorage | Simple, no external deps |
| Landing page location | Route group in dashboard app | Reuses infra, no separate deployment |
| Landing styles | CSS Modules (not Tailwind) | Matches codebase paradigm |
| Font loading | next/font/google | Automatic optimization, no layout shift |
| Color format | OKLCH + hex fallback | Perceptual uniformity, modern browser support |
| Testing | Vitest + @testing-library/react | Already in monorepo toolchain |
| Type scale ratio | ~1.25 (minor third) | Standard for product UI, visible differentiation |
| Spacing base | 4px | Most flexible, matches 8px grid via multiples |
| Component ref forwarding | React.forwardRef on all interactive components | Required by form libraries, compound patterns |
| Global CSS approach | Single `globals.css` import → DS tokens overwrite via cascade | Additive — no regressions during migration |

---

## 11. File Creation Order (Implementation Tasks)

```
1.  packages/design-system/package.json
2.  packages/design-system/tsconfig.json
3.  packages/design-system/vitest.config.ts
4.  packages/design-system/src/tokens/colors.css
5.  packages/design-system/src/tokens/typography.css
6.  packages/design-system/src/tokens/spacing.css
7.  packages/design-system/src/tokens/radius.css
8.  packages/design-system/src/tokens/shadows.css
9.  packages/design-system/src/tokens/transitions.css
10. packages/design-system/src/tokens/index.css
11. packages/design-system/src/styles/reset.css
12. packages/design-system/src/styles/utilities.css
13. packages/design-system/src/components/button/ (tsx + module.css + index.ts)
14. packages/design-system/src/components/input/ (tsx + module.css + index.ts)
15. packages/design-system/src/components/textarea/
16. packages/design-system/src/components/select/
17. packages/design-system/src/components/card/ (compound)
18. packages/design-system/src/components/modal/ (Radix wrapper)
19. packages/design-system/src/components/badge/
20. packages/design-system/src/components/toast/ (component + container)
21. packages/design-system/src/components/table/ (generic typed)
22. packages/design-system/src/components/tabs/
23. packages/design-system/src/components/progress-bar/
24. packages/design-system/src/components/avatar/
25. packages/design-system/src/components/skeleton/
26. packages/design-system/src/components/index.ts (barrel)
27. packages/design-system/src/index.ts (top-level barrel)

Then per consuming app:
28. Add @vyloop/design-system + lucide-react to package.json
29. Import tokens in layout.tsx
30. Add font variables via next/font
```
