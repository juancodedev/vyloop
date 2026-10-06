'use client';

import Script from 'next/script';
import { useCallback, useRef, useState } from 'react';

import { api } from '../lib/api';
import {
  SUPPORT_FIELDS,
  SUPPORT_LIMITS,
  SUPPORT_SITE_KEY,
  buildSupportPayload,
  readChallengeToken,
  resetChallenge,
  resolveSiteKey,
} from '../lib/support';

/**
 * The way to write to a human, on the screen that has no other way.
 *
 * ## Why this is here and not on a `/contact` page
 *
 * The person who reaches this screen has just been told their card cannot be
 * issued, and in the motivating case their **registration is what failed** — so
 * they have no account, no history to look up, and nothing to identify themselves
 * with. A separate page would be a second navigation away from the only piece of
 * information that makes their report useful, and they would arrive at it with no
 * code to quote. So it lives under the refusal, beside the two `data-*` attributes
 * that already carry its context.
 *
 * ## What it asks for, and what that costs
 *
 * A message. That is all. No name, no email, no phone — not as optional fields
 * either, but *absent*, so there is nothing to redact later.
 *
 * The cost is real and chosen: the operator can read the message and **cannot
 * reply to it**, and the customer gets no confirmation that it arrived. Both are
 * worse than having an email field, and both are cheaper than turning a public,
 * unauthenticated mail relay into a customer database with retention and deletion
 * obligations. `lib/support.ts` states the rule and its test holds the exact key
 * set, so adding a contact field has to be a deliberate act.
 *
 * ## Why the free text never reaches the DOM
 *
 * `wallet-card.tsx` keeps the code and the status in `data-*` and says they carry
 * no PII. A paragraph someone typed must not join them: `data-*` is readable by
 * every script on the page, lands in screenshots and dev tooling, and outlives the
 * request. It lives in React state and in the request body, and the behaviour
 * suite asserts `container.innerHTML` does not contain it after a send.
 *
 * ## Why no icon on the control
 *
 * `a11y-hygiene.contract.test.ts` pins the exact set of elements carrying
 * `aria-hidden` across the app. A decorative glyph on one button would change that
 * set for no gain. The label carries the meaning.
 */

interface SupportFormProps {
  /** The refusal this form reports. Read as values; never re-derived. */
  failure: { code: string; status: number };
  /**
   * Overrides the build-time site key.
   *
   * A seam for one reason: with no key configured — which is this project's real
   * state — the form renders its unavailable branch and none of the sending
   * behaviour can be exercised at all. The prop does not weaken the default,
   * which is still `NEXT_PUBLIC_TURNSTILE_SITE_KEY` with no fallback; it only lets
   * a test hold a key so the rest of the component is reachable. The suite asserts
   * the default separately, so a change that made the prop the production path
   * would be visible here.
   */
  siteKey?: string | undefined;
}

type SupportState =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'sent' }
  | { kind: 'failed'; message: string };

/**
 * Whether a challenge can be solved at all.
 *
 * Resolved once at module load rather than per render: it is a build-time
 * substitution, so it cannot change while the page is open, and a component that
 * re-derived it would answer the same question the same way on every render.
 */
const SITE_KEY = resolveSiteKey(SUPPORT_SITE_KEY);

/**
 * The form, or the truth that it cannot work.
 *
 * Without a site key there is no widget, so there is no token, so the gateway
 * refuses to send. Rendering the fields anyway would take a paragraph from someone
 * on a phone and then answer 403 — which is why the unavailable state replaces the
 * form rather than accompanying it.
 *
 * It says what is true and what still works, because the sentence this replaces
 * ("contale al comercio") remains the correct advice whatever we do here.
 */
export function SupportForm({ failure, siteKey }: SupportFormProps) {
  const [state, setState] = useState<SupportState>({ kind: 'idle' });
  const [message, setMessage] = useState('');
  // The honeypot is uncontrolled on purpose: a bot filling it produces no React
  // state change, and a controlled field would have nowhere to put the value.
  const trap = useRef<HTMLInputElement | null>(null);

  // The prop is resolved through the same normaliser as the environment value, so
  // a blank prop is as absent as a blank var. `SITE_KEY` is the production answer.
  const challenge = resolveSiteKey(siteKey ?? SITE_KEY);

  const tooShort = message.trim().length < SUPPORT_LIMITS.messageMin;
  const tooLong = message.length > SUPPORT_LIMITS.messageMax;

  const submit = useCallback(async () => {
    if (tooShort || tooLong) {
      // Refused here so a paragraph is not typed for nothing, and so the client
      // agrees with `apps/gateway/src/support.ts` rather than second-guessing it.
      // The server is still the control; this is only about not wasting a tap.
      setState({
        kind: 'failed',
        message: tooShort
          ? 'Escribí un poco más, para que sepamos qué pasó.'
          : 'El mensaje es demasiado largo.',
      });
      return;
    }

    setState({ kind: 'sending' });

    // Read at submit time, not held in state.
    //
    // The token used to come from a `useRef` that nothing ever wrote, so
    // `token.current` was `''` on every submission and the gateway answered 403 to
    // every customer who tried to reach us. The widget rendered, the form looked
    // correct, and the channel had never succeeded once.
    const challengeToken = readChallengeToken();

    try {
      await api.sendSupportMessage(
        buildSupportPayload({
          code: failure.code,
          status: failure.status,
          message,
          website: trap.current?.value ?? '',
          token: challengeToken,
        }),
      );

      setState({ kind: 'sent' });
    } catch (error) {
      // The server's own words, because the honest description of "it did not
      // arrive" is not something this component should invent — and a kind
      // sentence is the wrong one when it is not the true one.
      //
      // `message` is deliberately left in state, so a paragraph typed on a phone
      // survives a failure instead of having to be retyped. That is the other half
      // of an honest failure; the first half is not saying "recibimos".
      const carried = error as { message?: unknown } | null;
      const text =
        typeof carried?.message === 'string' && carried.message.trim() !== ''
          ? carried.message
          : 'No pudimos enviar el mensaje. Probá otra vez.';

      setState({ kind: 'failed', message: text });

      // Reset the widget, or the retry is impossible.
      //
      // Turnstile tokens are single-use, and Cloudflare documents `600*` — the
      // generic bot-behaviour family, which is what a network hiccup, an adblocker
      // or a VPN produces as easily as an actual bot — as **retryable**. That is
      // only true if the widget is reset: without it the next submit re-sends the
      // same spent token and the gateway refuses it again, so one unlucky moment
      // locks a customer out of the only channel they have.
      //
      // Done after the message is preserved above, never instead of it: the
      // paragraph stays, and the only thing asked of the person is one more tap on
      // the challenge.
      resetChallenge();
    }
  }, [failure.code, failure.status, message, tooLong, tooShort]);

  if (state.kind === 'sent') {
    return (
      <div className="support-form support-form--sent">
        <p className="club-status__description" role="status">
          Recibimos tu mensaje.
        </p>
        {/*
          The cost of collecting nothing, said out loud rather than discovered.
          Somebody who wrote here and hears nothing back deserves to know why
          before they wait for a reply that is not coming.
        */}
        <p className="support-form__aside">
          No guardamos tu nombre ni tu correo, así que no te podemos responder por acá.
        </p>
      </div>
    );
  }

  if (!challenge) {
    return (
      <div className="support-form support-form--unavailable">
        <p className="club-status__description">
          El canal de soporte no está disponible en este momento.
        </p>
        <p className="support-form__aside">Contale al comercio y lo resuelven.</p>
      </div>
    );
  }

  return (
    <div className="support-form">
      <label className="label" htmlFor="support-message">
        Tu mensaje
      </label>

      <p className="support-form__hint" id="support-message-hint">
        Lo leemos a diario. No hace falta que escribas tu nombre.
      </p>

      <textarea
        id="support-message"
        name={SUPPORT_FIELDS.message}
        className="input support-form__field"
        rows={4}
        value={message}
        maxLength={SUPPORT_LIMITS.messageMax}
        aria-describedby="support-message-hint"
        aria-invalid={state.kind === 'failed' || undefined}
        onChange={(event) => {
          setMessage(event.target.value);
          // Clearing on the next keystroke is what makes the retry usable: the
          // error belongs to the attempt, not to the paragraph.
          if (state.kind === 'failed') setState({ kind: 'idle' });
        }}
      />

      {/*
        The honeypot.

        Hidden with `display: none` rather than off-screen, and that is forced by
        two contracts in `a11y-hygiene.contract.test.ts`: the app allows no inline
        style anywhere, and `aria-hidden` is rejected on anything Tab can reach —
        which an input is. The third option, off-screen plus a negative tab index,
        is the strongest trap and is unavailable too, because that suite asserts a
        negative tab index appears in exactly one file in the app.

        `display: none` also removes the field from the tab order and the
        accessibility tree, which is why no tab index and no `aria-hidden` are
        needed here — a `display: none` input is already unreachable by both.

        So the cost of staying inside the existing contracts is real and worth
        naming: **`display: none` does not stop a bot that reads computed styles.**
        This layer is not what stops a determined bot — Turnstile is, verified on
        the server where it cannot be skipped. The honeypot removes the naive ones
        for the cost of one input, and `aria-hidden` on an off-screen field would
        have been the a11y defect this app already has a contract against.
      */}
      <div className="support-form__trap">
        <input
          ref={trap}
          type="text"
          name={SUPPORT_FIELDS.honeypot}
          autoComplete="off"
          defaultValue=""
        />
      </div>

      {/*
        The widget and its script, together, and only when a key exists.

        Both are conditional for the same reason the form is: an unconfigured
        deployment must not ship a request to Cloudflare on a page that has no
        widget, and must not render a mount point that nothing will ever fill.

        Loading the script from here rather than from `layout.tsx` is what makes
        this component self-contained — setting `NEXT_PUBLIC_TURNSTILE_SITE_KEY` and
        `TURNSTILE_SECRET_KEY` is then the whole of the provisioning, with no second
        place to remember to edit and nothing to remove when it is withdrawn.

        `data-action="support"` is what the widget reports back through siteverify,
        and it is the value a verification could be scoped to later if this ever
        shares a secret with another form. Nothing checks it today, because
        Turnstile has no score to threshold and `success` is a boolean.
      */}
      <Script src="https://challenges.cloudflare.com/turnstile/v0/api.js" strategy="afterInteractive" />
      <div className="cf-turnstile" data-sitekey={challenge} data-action="support" />

      <button
        type="button"
        className="btn btn--primary"
        disabled={state.kind === 'sending'}
        onClick={submit}
      >
        {state.kind === 'sending' ? 'Enviando…' : 'Enviar mensaje'}
      </button>

      {state.kind === 'failed' ? (
        <p className="error-text support-form__error" role="alert">
          {state.message}
        </p>
      ) : null}
    </div>
  );
}
