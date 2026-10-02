'use client';

import { useCallback, useEffect, useState } from 'react';

import { api } from '../lib/api';
import { walletFailureFor, type WalletFailure, type WalletPass } from '../lib/wallet';

import { ClubError, ClubStatus } from './club-status';

/**
 * The customer's Google Wallet pass, or the truth about why there isn't one.
 *
 * ## Why this exists
 *
 * `GET /v1/wallet/pass` was fully working and nothing in the customer web ever
 * called it. The profile showed a balance, a QR and an activity list, and no
 * way to get the card — which is the last link in the path from "a person opens
 * the shop's page" to "the card is in their phone".
 *
 * ## Why it asks on mount rather than on click
 *
 * Because the endpoint mints the object. There is no URL to link to until it has
 * been called, so a click-to-load design is two taps where the customer expects
 * one, and Google's own integrations prefetch for the same reason.
 *
 * The cost is one Google API request per profile visit, which is why the effect
 * below depends on nothing and runs once. If that ever becomes a rate problem,
 * `GET /v1/wallet/status` already answers "may I show this control" for free —
 * that is the cheaper design and it is a deliberate future change, not an
 * oversight here.
 *
 * ## Why there is no "you don't have a pass" state
 *
 * The component has three: asking, answered, refused. There is no fourth branch
 * meaning "this customer has no card", because **that is not something a refusal
 * means**. Every refusal `GET /v1/wallet/pass` can produce is about the
 * merchant's class, about Google, or about this deployment — never about the
 * customer's record. Rendering them as one flat "no tenés tarjeta" tells someone
 * with a perfectly good account that their account is the problem, and hides the
 * one piece of information they can act on.
 *
 * So each code gets its own message, its own audience and its own remedy, and
 * every one of them says the account is fine. `walletFailureFor` owns that copy
 * and `wallet.test.ts` asserts the property across all of them at once, which is
 * the only way it can be asserted at all.
 *
 * ## No icon on the button
 *
 * `a11y-hygiene.contract.test.ts` pins the exact set of elements carrying
 * `aria-hidden` across the app, and a new lucide icon would change that set for
 * a decorative glyph on one button. The label carries the meaning on its own.
 */

type WalletState =
  | { kind: 'asking' }
  | { kind: 'answered'; pass: WalletPass }
  | { kind: 'refused'; failure: WalletFailure };

/**
 * Turn anything `getWalletPass` can reject with into copy.
 *
 * `ApiError` carries the server's stable code and status; anything else is a
 * request that never got an answer, reported as status `0` so it lands on the
 * branch that names us rather than on one that guesses a cause.
 */
function describeFailure(error: unknown): WalletFailure {
  const carried = error as { code?: unknown; status?: unknown } | null;

  const code = typeof carried?.code === 'string' ? carried.code : '';
  const status = typeof carried?.status === 'number' ? carried.status : 0;

  return walletFailureFor(code, status);
}

export function WalletCard() {
  const [state, setState] = useState<WalletState>({ kind: 'asking' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    // A first profile view that unmounts before the answer arrives must not set
    // state on a dead component, and a retry bumps `attempt` to ask again.
    let live = true;

    setState({ kind: 'asking' });

    api
      .getWalletPass()
      .then((pass) => {
        if (live) setState({ kind: 'answered', pass });
      })
      .catch((error: unknown) => {
        if (live) setState({ kind: 'refused', failure: describeFailure(error) });
      });

    return () => {
      live = false;
    };
  }, [attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  return (
    <section className="club-wallet" aria-label="Tu tarjeta en Google Wallet">
      {state.kind === 'asking' ? (
        <ClubStatus variant="loading">
          <span className="club-status__indicator" aria-hidden="true" />
          <p className="club-status__description">Preparando tu tarjeta…</p>
        </ClubStatus>
      ) : null}

      {state.kind === 'refused' ? (
        <div
          // The code and the status, as data rather than as copy. A customer
          // showing this to somebody at the counter gives the support reader
          // which refusal this was without anyone having to guess from the
          // sentence — a 409 is the merchant's onboarding and a 500 is ours.
          //
          // Not logged, not sent, and no PII in either: a code and a status are
          // the whole payload and both are drawn from a closed set.
          data-wallet-code={state.failure.code}
          data-wallet-status={state.failure.status}
        >
          <ClubError
            title={state.failure.title}
            description={state.failure.message}
            action={
              <button type="button" className="btn btn--outline" onClick={retry}>
                Reintentar
              </button>
            }
          />
        </div>
      ) : null}

      {state.kind === 'answered' ? (
        <div className="club-wallet__ready">
          <p className="club-wallet__note">
            Tu tarjeta vive en Google Wallet. Agregala una vez y después usala en el local junto con tu
            código de socio.
          </p>

          {/* Google's own save link, verbatim. It is a signed claim naming an
              object we created at Google; rebuilding or decorating it here would
              produce a link that looks right and is dead at the counter. */}
          <a className="btn btn--primary" href={state.pass.save_url}>
            Agregar a Google Wallet
          </a>

          {/*
            The member code is what a person reads out at a noisy counter, and it
            is also `LoyaltyObject.accountId`.

            It appears **here and only here**, because this is the first request
            in the customer's life that mints it: `workers/wallet/src/issuance.ts`
            derives it lazily, on the pass request, and deliberately not at
            registration — minting it in `workers/customer` would mean handing
            `MEMBER_CODE_PEPPER` to a worker with no other reason to hold that
            secret. So a profile seen before this card has answered has no code,
            and that is the normal state, not a broken account.
          */}
          <div className="club-wallet__code">
            <p className="club-wallet__code-label">Tu código de socio</p>
            <p className="club-wallet__code-value">{state.pass.member_code}</p>
          </div>
        </div>
      ) : null}
    </section>
  );
}