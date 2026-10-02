/**
 * The arithmetic behind a points preview.
 *
 * It lives here, out of the page, because `apps/dashboard/vitest.config.ts` sets
 * no `environment` and the dashboard therefore runs in `node`: a component
 * cannot be rendered, so any arithmetic left inside one is untestable arithmetic.
 *
 * ## This is an estimate, and it is not the charge
 *
 * `POST /v1/loyalty/points/assign` takes the BASE amount and applies the rates
 * itself — `effectivePoints = Math.floor(body.points * earnRate *
 * tierMultiplier)`. This function reproduces that product to show the cashier
 * roughly what the customer is earning, and that is the whole of its job.
 *
 * Its output must never be sent back as the base. Doing so applies the tier
 * twice, which is what the POS used to do: a Gold customer (`×2`) was credited
 * `base × rate × 2 × 2`, and because that number is what lands in
 * `points_transactions.points` with `balance_after` accumulated from it, the
 * inflated balance is permanent.
 *
 * It can disagree with the charge, and that is correct. The tier is resolved by
 * the server at the moment of the charge and can change between the preview and
 * the charge — the estimate is built from the rate and tier this client happens
 * to be holding. So callers show this number labelled as an estimate, and the
 * receipt shows what the server decided instead.
 */
export function previewPoints(base: number, earnRate: number, multiplier: number): number {
  return Math.floor(base * earnRate * multiplier);
}