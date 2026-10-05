# Onboarding a business and a customer, end to end

Two chained flows. The first creates businesses without human help. The second creates a customer and hands them the card immediately.

```
Business signs up  →  gets its QR  →  customer scans  →  gets their card
   (5 minutes)          (instant)      (30 seconds)       (instant)
```

**Status: A1, A2, B1 and B2 are mounted and tested. A3 does not exist.** An earlier version of this document said none of them existed and that `insertClass` was called by nobody. Both claims are false today — see the evidence per step.

## What the code says, per step

| Step | Status | Evidence |
| --- | --- | --- |
| **A1** business signup | mounted, tested, **no production evidence** | `workers/identity/src/business-signup.ts:174-238` writes `tenants`, `users`, `loyalty_programs`, `membership_tiers` in one transaction · routed `apps/gateway/src/router.ts:17`, public `index.ts:117`, rate-limited `index.ts:221` · 31 unit tests + 31 route tests through `app.fetch` |
| **A2** Google class + wallet row | mounted, tested, **no production evidence** | `insertClass` called at `workers/wallet/src/provision.ts:393` · reached from `workers/identity/src/index.ts:544` → `wallet-provision.ts:144` (3 attempts, backoff `[250,1000]`) · service binding declared in `workers/identity/wrangler.jsonc:15-20` · 54 tests in `provision.test.ts` |
| **A3** business logo | **does not exist** | Storage and serving exist; **no write path anywhere in the repo** — no `.put()` on any R2 bucket, only `.get` in `brand.ts:74,79` |
| **B1** customer form + QR | mounted, tested, **production evidence** | Form `apps/customer-web/app/register/page.tsx:427` · API `workers/customer/src/routes.ts:21`, public-by-slug branch `:47-74` · QR CTA `apps/gateway/src/merchant-page.ts:341-348` · 15 behavior tests |
| **B2** immediate card | mounted, tested, **production evidence** | Route `workers/wallet/src/routes.ts:454` · member code derived at `issuance.ts:251` · `insertObject` `routes.ts:570`, 409 → `patchObject:578` · signed link `issuance.ts:470`, returned as `save_url` · link to the phone at `apps/customer-web/app/components/wallet-card.tsx:145` |

The category distinctions are load-bearing. "Exists in the code" and "works for a customer" are different claims, and this document used to conflate them.

## Why A1 and A2 have no production evidence

A1 is an API with no UI. Grepping `business/signup` across `apps/` returns only the gateway rate limit and its own tests — **there is no business signup form anywhere.** Production held 1 tenant as of 2026-10-02, and that tenant is the one `packages/db/scripts/seed.ts` creates. A2's production class was created by hand (`docs/11-crear-tarjeta-lealtad.md:13`).

So A1 and A2 are **mounted, tested, and never exercised by a real signup.** That is a different state from working, and it is the honest one.

## The three logo questions, answered

**Where it lives — answered, by a route this document did not anticipate.** It said *"the repo has no R2 and no object storage"*. **That is false.** There is a private R2 bucket: binding `BRAND_ASSETS` (`apps/gateway/src/router.ts:91`), bucket `vyloop-brand-assets` (`apps/gateway/wrangler.jsonc:76-79`), served by `app.get('/brand/*')` at `index.ts:240`, implemented `brand.ts:67-116`. It is keyed by **tenant id**, not slug, so a business's URL survives a rebrand (`brand.ts:19-30`), and the class consumes it at `provision.ts:303`.

It is not an `r2.dev` URL for a documented reason (`brand.ts:6-17`): a class cannot be recreated under the same id, so losing that preview subdomain becomes a manual patch per class.

**Whether it is mandatory — answered, and the opposite of what was recommended here.** The document recommended yes, for the review. The code says no, deliberately: `brand.ts:76-79` — *"A tenant that uploaded nothing is not an error. The default is the answer"*, and `brand.ts:27-29` — *"signup does not have to ask about images for a tenant to have a card"*. The signup body has no logo field (`identity/src/index.ts:460`). The default is precisely what lets A1 + A2 work without A3.

**Whether it is normalised at signup — STILL OPEN.** No `sharp` and no other image dependency anywhere in the repo. No resize, no flatten, no alpha→JPEG conversion. `workers/wallet/src/hero-image.ts:29-41` states image generation does not exist here. And `brand.ts:35-39` accepts `jpg`, `jpeg` and `png` equally, deriving content-type from the stored extension (`:92-93`).

**The bucket normalises nothing and does not reject a PNG with an alpha channel.** The exact thing that forced a manual flatten for Café Central still gets a 200 instead of an error.

## Demo mode, verified in code

**Still true, exactly:**

- `workers/wallet/wrangler.jsonc:23` → `"WALLET_DEMO_MODE": "true"`, default true on purpose.
- Pinned by test: `wrangler-config.contract.test.ts:150` requires the literal. Changing it breaks CI.
- `parseDemoMode` fails closed — absent, empty or unrecognised means `true` (`helpers.ts:487-494`).
- Google's delivery limit is not ours (`issuance.ts:113-125`, `helpers.ts:471-486`).

**No longer true — our own route stopped refusing.** `workers/wallet/src/routes.ts:503-517` says verbatim *"Demo mode is no longer a refusal here."* Refusing customers blocked the only people who could test it — Google's testers hold the `customer` role, not an operator. The draft-class refusal now applies only when `!demoMode` (`issuance.ts:156-158`), and `routes.test.ts:1401` pins that.

**The sentence in this document that still holds:** *"if someone tries it with their personal Gmail, the pass does not appear."* That is Google's limit, not a decision of ours. What changed is that we no longer hide the button or hand the customer a 409.

**A live contradiction to resolve.** `apps/customer-web/app/delivery.contract.test.ts:106-108` asserts *"The issuer is approved and a pass works on a real phone"*, which contradicts `workers/wallet/wrangler.jsonc:23` and its own neighbouring guard. One of the two is lying. Not determinable from the repo — it needs Cloudflare.

## Three things this document did not know

1. **B2 runs one step further than described.** The member code is **not** issued at signup. It is derived lazily, during the pass request (`issuance.ts:231-240`), specifically to keep `MEMBER_CODE_PEPPER` away from the `customer` worker. Confirmed in production by `docs/14-Backlog.md:150-156`: 4 of 12 customers have one, and they are the ones who asked for a pass.
2. **The pass carries no tier row.** `issuance.ts:391` sets `TIER_HEADER_UNAVAILABLE = null`, deliberately (`issuance.ts:370-390`), and `GET /v1/wallet/status` reports it so it is visible.
3. **The principal risk here has changed shape.** *"B2 without A2 issues passes against classes that do not exist"* is no longer the live failure. The class is created `draft` (`provision.ts:298`) and `classReadinessFor` accepts `draft` while demo mode is on (`issuance.ts:158`).

## What is actually still risky

**A2's retry is not durable, and today nothing else runs.** The signup retry lives inside `waitUntil` — 3 attempts with backoff — and `wallet-provision.ts:15-27` says so. The containing net is the daily sweep (`sweep.ts:640` → `workers/automation/src/index.ts:122` → cron in `workers/automation/wrangler.jsonc:23-24`).

But **`runScheduledSweep` refuses to do anything while `WALLET_DEMO_MODE` is `true`** (`sweep.ts:885-889`).

**So with the current configuration the only retry that ever runs is the three in-request attempts.** If that `waitUntil` is lost, the tenant is left with no class and nothing will ask for one again — a business that looks alive and cannot issue a card, with nothing in the product flagging it. That is the same shape of failure the document used to fear, reached by a different road.

## Two coverage gaps found on the way

- **The branch the whole QR depends on has no test.** `businessSlug` appears 7 times in `workers/customer`, all 7 in `routes.ts`, zero in any test. The `slug → businessId` resolution at `routes.ts:47-74` — exactly what executing `/register?biz=cafe-central` runs — is unexercised.
- **The dashboard QR is not per tenant.** `apps/dashboard/src/app/dashboard/qr/page.tsx:6-7` hardcodes `https://vyloop-customer-web.pages.dev/register?biz=cafe-central` with `BUSINESS_NAME = 'Café Central'`. It is in the sidebar, so it is mounted — but it is not a business's QR, it is Café Central's QR for everyone. `delivery.contract.test.ts:196` forbids the string `cafe-central` in customer-web production sources but does not cover the dashboard. The per-tenant route is `/p/{slug}`.

## Not covered

- **Integration tests against the Google API.** Every serious defect in this story came from running it by hand: path casing, lowercase `state`, image fields that do not exist. That is the repeating pattern, and no test caught any of them.
- **Publication.** It is Google's and depends on nothing we do.
- **Tenant isolation on reads.** RLS is still off and isolation lives in store filters. An onboarding path that writes five rows has to write them as carefully as it reads them.