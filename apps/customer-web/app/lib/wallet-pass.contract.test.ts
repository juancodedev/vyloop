// @vitest-environment node

/**
 * The two halves of `GET /v1/wallet/pass`'s idempotency answer, across the
 * package boundary that separates them.
 *
 * ## The failure this exists to prevent
 *
 * The worker hands back a pass that already exists without creating one, and the
 * response is otherwise identical to a new issuance: same link, same fields,
 * same `200`. The only thing separating "just created" from "you already had
 * that" is `already_existed` plus `pass_state`, so a spelling disagreement on
 * either side of the wire does not throw — it silently renders "Agregala una vez"
 * to someone whose card has been in their phone for a year. A type error would be
 * loud; this is the version that is not.
 *
 * ## Why this reads the worker's source instead of importing it
 *
 * `apps/customer-web` does not depend on `@vyloop/wallet`, and it must not: the
 * gateway and the customer web are public faces, the worker is the service behind
 * them, and an import added so a test can compare two strings inverts the
 * dependency direction of the whole system to buy a compile-time check. The
 * precedent is `apps/gateway/src/wallet-callback-path.contract.test.ts`, which
 * reads `workers/wallet/src/routes.ts` for exactly this reason and says so at
 * length.
 *
 * A future reader will find this ugly and "fix" it with
 * `import { ... } from '@vyloop/wallet'`. That import is the bug: this file would
 * still pass, the graph would point backwards, and the customer web could no
 * longer be reasoned about without a package that drags in drizzle, a Postgres
 * driver and Google's client.
 *
 * ## Why the branch is asserted in `lib/wallet.ts` and not in the component
 *
 * The first draft of this file asserted the card branches on the fields. It does
 * not, on purpose, and the reason is the same one `delivery.contract.test.ts` and
 * `profile.contract.test.ts` give for refusals: customer-facing wallet wording
 * lives in `lib/wallet.ts` and nowhere else, because the property worth holding is
 * a statement about a set of branches and a component cannot be walked for it
 * without a DOM. The card renders what `walletPassCopyFor` returns; this file holds
 * the copy module to the branch and the card to the absence of its own sentence.
 *
 * That is a stronger pair than the one it replaced. The version that only checked
 * the component would have passed a card that branched correctly in JSX and
 * spelled its own "Agregala una vez" alongside, which is precisely the failure
 * `delivery.contract.test.ts` exists to make impossible.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

/** The worker module that registers the pass route and writes its response body. */
const routesSource = readFileSync(
  new URL('../../../../workers/wallet/src/routes.ts', import.meta.url),
  'utf8',
);

/** The client-side copy of the wire shape, and the only place wallet copy may be written. */
const walletSource = readFileSync(new URL('./wallet.ts', import.meta.url), 'utf8');

/** The component that renders what the API answered. */
const cardSource = readFileSync(new URL('../components/wallet-card.tsx', import.meta.url), 'utf8');

/**
 * The `GET /v1/wallet/pass` handler on its own.
 *
 * Scoped because `pass_state` is *already* an answer on `/v1/wallet/status`, so a
 * whole-file search would satisfy this guard on the strength of a field this route
 * never sends — and would keep satisfying it after the field was deleted from
 * here, which is the exact regression this file exists to catch. Cut from the
 * registration to the next top-level route registration, which is where this
 * handler ends.
 */
const passRouteSource = (() => {
  const start = routesSource.indexOf("router.get('/v1/wallet/pass'");

  if (start === -1) throw new Error('routes.ts no longer registers GET /v1/wallet/pass');

  const rest = routesSource.slice(start + 1);
  const next = rest.search(/\nrouter\.(get|post|put)\(/);

  return next === -1 ? routesSource.slice(start) : routesSource.slice(start, start + 1 + next);
})();

/** Comments blanked out, for the same reason `delivery.contract.test.ts` does it. */
function withoutComments(source: string): string {
  return source
    .replaceAll(/\/\*[\s\S]*?\*\//g, (block) => block.replaceAll(/[^\n]/g, ' '))
    .replaceAll(/\/\/[^\n]*/g, (line) => line.replaceAll(/[^\n]/g, ' '));
}

const walletCode = withoutComments(walletSource);
const cardCode = withoutComments(cardSource);

/** The fields that make a reused pass distinguishable from a newly minted one. */
const DISCRIMINATORS = ['already_existed', 'pass_state'] as const;

describe('the pass response says whether the pass already existed', () => {
  for (const field of DISCRIMINATORS) {
    it(`emits \`${field}\` in the worker's pass response`, () => {
      // Spelled as an object key in *this route's* response literal, not merely
      // named in a comment: a worker that documents the field and does not send
      // it is the exact silent case this guard is for.
      expect(passRouteSource).toMatch(new RegExp(`\\b${field}:`));
    });

    it(`declares \`${field}\` on the client's \`WalletPass\``, () => {
      // The type the API client hands the copy module. A field the worker sends
      // and the type omits is a field no branch can read: the response is 200,
      // the UI lies, and nothing anywhere is a type error.
      expect(walletSource).toMatch(new RegExp(`\\b${field}:`));
    });

    it(`branches on \`${field}\` in the copy module, so the sentence can change`, () => {
      // Read, not merely mentioned in prose. A comment explaining the field while
      // the code ignores it satisfies a presence check and still tells every
      // returning customer their card was just created.
      expect(walletCode).toMatch(new RegExp(`pass\\.${field}\\b|${field}\\b\\s*&&`));
    });
  }

  it('renders the copy module\'s words, and keeps none of its own', () => {
    expect(cardCode).toMatch(/\bstate\.copy\.note\b/);
    expect(cardCode).toMatch(/\bstate\.copy\.label\b/);

    // The first-add sentence, verbatim. `wallet.test.ts` walks every state of
    // `walletPassCopyFor`; this half holds the component from growing a fourth
    // place the same wording could live and disagree.
    expect(cardCode).not.toMatch(/agreg[áa]la una vez/i);
    expect(cardCode).not.toMatch(/vuelve a agregar|volver a agregar/i);
  });

  it('never infers the difference from something the response already had', () => {
    // The tempting shortcut, and the one this whole guard exists to rule out:
    // `object_id` is the same on both paths by design — that is what makes the
    // second request idempotent — so nothing about the old fields can tell a
    // returning customer from a new one. Only the two new fields can, and a
    // branch on `save_url` would be comparing two signed links that differ in
    // their `iat` alone.
    expect(cardCode).not.toMatch(/pass\.object_id\s*===|===\s*state\.pass\.object_id/);
    expect(cardCode).not.toMatch(/pass\.save_url\s*===|===\s*state\.pass\.save_url/);
  });
});
