# Proposal: Complete Redesign

## Intent

**Problem**: No brand identity, no design system, two disconnected visual languages (blue dashboard vs amber customer portal). ~2383 lines flat global CSS, zero shared components, no icon library.

**Why now**: PMV shipped. Every feature compounds debt. Brand must exist before marketing.

**Success**: Unified brand | Shared design system package | Landing page live | Dashboard rebuilt | Customer-web aligned.

## Scope

| In | Out |
|----|-----|
| Brand identity | Backend API changes |
| `@vyloop/design-system` package | New features |
| Public landing page | Auth flow changes |
| Dashboard rebuild | Mobile native apps |
| Customer-web alignment | Worker UI |

## New Capabilities

- `design-system`: shared tokens, icons, React primitives
- `landing-page`: public site

## Modified Capabilities

- `growth-dashboard`: visual redesign only
- `customer-web`: token alignment

## Phases

| # | Phase | Why |
|---|-------|-----|
| 1 | Design system (tokens, icons, primitives) | Foundation first |
| 2 | Landing page (hero, features, CTA) | Validates brand publicly |
| 3 | Dashboard redesign (layout, nav, pages) | Highest user impact |
| 4 | Customer-web alignment (token switch) | Lowest risk, well-scoped |

## Design Direction

**Brand palette**: Warm amber/gold (#d97706 primary, #f59e0b accent) over corporate blue. LatAm SMBs respond to warm brands. Amber signals energy + trust — fits loyalty.

| Role | Hex |
|------|-----|
| Primary | #d97706 |
| Accent | #f59e0b |
| Text | #1c1917 |
| Surface | #fef9f0 |
| Borders | #e7e5e4 |
| Success/Error | #16a34a / #dc2626 |

**Type**: Inter (body, 14px) + Sora (display). System-ui fallback.

**Architecture**: CSS custom properties in `packages/design-system/tokens/`. React primitives (Button, Card, Input, Modal, Badge, Toast, Table) in `packages/design-system/components/`. No Tailwind. Lucide icons in `@vyloop/icons`. Radix UI for accessible primitives.

## Key Decisions

1. Palette hex values for full scale (50-900)
2. Typeface pairing confirmed (Inter + Sora?)
3. Logo direction (wordmark, icon, both?)
4. Dashboard layout direction (sidebar+topbar redesigned, or alternative?)
5. Dark mode in scope?
6. Legacy CSS migration: gradual or big-bang?
7. Icon set: Lucide or Phosphor?

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Breaking dashboard mid-migration | Medium | Ship DS first, migrate page-by-page |
| Inconsistent output | Medium | Shared tokens + CI visual regression |
| 800-line review budget | High | Phases 2-4 split into chained PRs |
| Brand misses LatAm audience | Low | Validate early with landing page |

## Rollback

All phases additive. Phase 1: remove design-system dep. Phase 2: revert landing page route. Phases 3-4: revert globals.css + layout files.

## Dependencies

- Radix UI, Lucide (or Phosphor), Inter + Sora typefaces
