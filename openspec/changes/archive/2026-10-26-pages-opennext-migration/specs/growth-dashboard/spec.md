# Delta for growth-dashboard

## ADDED Requirements

### Requirement: Dashboard Worker Deployment Runtime

The dashboard application (`apps/dashboard`) that hosts the growth dashboard views MUST be built with the OpenNext Cloudflare adapter (`@opennextjs/cloudflare`) and deployed as a Cloudflare Worker with static assets. The repository MUST NOT depend on `@cloudflare/next-on-pages`, and no route under `apps/dashboard/src/app` SHALL declare `export const runtime = 'edge'`.

Every dashboard route that rendered before the migration MUST render after it, including the dynamic route `/dashboard/customers/[id]`.

#### Scenario: Dynamic customer route

- GIVEN the dashboard is deployed as a Worker
- WHEN an operator opens `/dashboard/customers/<id>` for an existing customer
- THEN the page renders and loads the customer detail from the gateway

#### Scenario: No edge runtime declaration remains

- GIVEN the migrated source tree
- WHEN `apps/dashboard/src` is searched for `runtime = 'edge'`
- THEN there are no matches

### Requirement: Dashboard Hostname Continuity

After cut-over, the `vyloop-dashboard` Pages project MUST answer every path with a 301 to the same path and query string on the dashboard Worker's hostname, so bookmarked operator URLs keep working. The Pages project MUST NOT be deleted until a separate decision retires it.

#### Scenario: A bookmarked URL

- GIVEN an operator bookmarked `https://vyloop-dashboard.pages.dev/dashboard/loyalty/tiers`
- WHEN they open it after cut-over
- THEN they are redirected to `/dashboard/loyalty/tiers` on the dashboard Worker's hostname
