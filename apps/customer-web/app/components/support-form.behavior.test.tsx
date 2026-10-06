// @vitest-environment jsdom

/**
 * The support form on the card's refusal screen.
 *
 * ## What it replaces
 *
 * PR #180 removed the retry button from the refusals where re-asking cannot help
 * and put a sentence in its place, and the sentence says to tell whoever is
 * standing next to you. That is the best available answer *while the app has no
 * support channel* — which was its own admission, written into `lib/wallet.ts`:
 * "inventing one would be inventing the destination as well as the control, and a
 * link to nowhere is worse than an honest absence".
 *
 * The destination now exists, so the sentence is no longer the end of it.
 *
 * ## The three properties asserted here
 *
 *   1. **It appears on a refusal and only on a refusal.** A card that worked has
 *      nothing to report, and a support form under a working pass would be a bug
 *      report about success.
 *   2. **The free text is never written into the DOM.** `wallet-card.tsx` keeps the
 *      code and the status in `data-*` and says so. A message a person typed must
 *      not join them there: `data-*` is visible to every script on the page, ends
 *      up in screenshots and support tooling, and outlives the request. Asserted
 *      against the rendered DOM, not the source, because that is where it leaks.
 *   3. **A failure is reported as a failure.** When the send does not go through,
 *      the form says so and says what to do. It must never render a confirmation
 *      nobody received — that is the one claim in this app nobody else can check.
 *
 * ## Why Turnstile is not stubbed into existence
 *
 * No widget exists for this project. `NEXT_PUBLIC_TURNSTILE_SITE_KEY` is unset, so
 * `resolveSiteKey` returns `undefined` and the form renders its **unavailable**
 * state instead of a widget that could not work. That is asserted below rather
 * than worked around: a fabricated widget is worse than no widget, because it
 * looks like the channel is open.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SUPPORT_FIELDS } from '../lib/support';
import { SupportForm } from './support-form';

const mocks = vi.hoisted(() => ({ sendSupportMessage: vi.fn() }));

vi.mock('../lib/api', () => ({
  api: { sendSupportMessage: mocks.sendSupportMessage },
}));

const REFUSAL = { code: 'WALLET_CLASS_NOT_APPROVED', status: 409 };

/**
 * A site key, so the form is reachable at all.
 *
 * **Not** one of Cloudflare's published testing keys. Those exist precisely so an
 * integration can be written before a widget exists, which is why shipping one as
 * a fallback would be the single most likely way this route ends up unprotected in
 * production with every test green. This is an obviously-fake string that the
 * gateway would reject, held here only so the component's own behaviour is
 * reachable.
 *
 * The default path — no key, so the unavailable state — is asserted separately and
 * on its own, so a change that made this the production answer would be caught.
 */
const SITE_KEY = 'not-a-real-sitekey';

const MESSAGE = 'No me aparece la tarjeta y ya me registre dos veces.';

/**
 * The API succeeds by default.
 *
 * Mocked with `sendSupportMessage` and nothing else, so any other call would
 * throw rather than quietly succeed against a fake.
 */
function accept() {
  mocks.sendSupportMessage.mockResolvedValue({ status: 'accepted', request_id: 'req-1' });
}

function refuse(status = 502) {
  const error = new Error('El canal de soporte no está disponible en este momento.');

  Object.assign(error, {
    name: 'ApiError',
    code: 'SUPPORT_SEND_FAILED',
    status,
    message: 'No llegó tu mensaje: no pudimos enviarlo. Probá otra vez o contale al comercio.',
  });

  mocks.sendSupportMessage.mockRejectedValue(error);
}

beforeEach(() => {
  accept();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('the form on the refusal screen', () => {
  it('offers a way to write, which is the thing the screen had no way to do', () => {
    render(<SupportForm failure={REFUSAL} siteKey={SITE_KEY} />);

    expect(screen.getByRole('button', { name: /enviar/i })).toBeTruthy();
  });

  it('sends the code and the status the screen is already showing', async () => {
    // The point of the two `data-*` attributes that already existed: the person
    // can describe the refusal to a human, and the human gets the code.
    render(<SupportForm failure={REFUSAL} siteKey={SITE_KEY} />);

    fireEvent.change(screen.getByLabelText(/mensaje/i), { target: { value: MESSAGE } });
    fireEvent.click(screen.getByRole('button', { name: /enviar/i }));

    await waitFor(() => expect(mocks.sendSupportMessage).toHaveBeenCalledTimes(1));

    const sent = mocks.sendSupportMessage.mock.calls[0]?.[0];
    expect(sent.wallet_code).toBe('WALLET_CLASS_NOT_APPROVED');
    expect(sent.wallet_status).toBe(409);
    expect(sent.message).toBe(MESSAGE);
  });

  /**
   * The channel has never once succeeded, and no test could see it.
   *
   * The token came from a `useRef` that nothing ever wrote, so every submission
   * sent an empty token, the gateway answered `403` to every customer, and the
   * widget still rendered — a channel that looks complete and refuses everyone.
   * Every other test in this file mocks `sendSupportMessage` and so was blind to
   * it: the gap was not the gateway or the widget but the value on the wire.
   *
   * This one reads the token the way the browser produces it — a hidden input named
   * by Cloudflare, holding whatever the widget last issued — and asserts it is what
   * actually goes out.
   */
  it('sends the token the widget issued, not an empty string', async () => {
    const issued = 'token-issued-by-the-widget';

    // What Turnstile's implicit render leaves in the page: a hidden input under its
    // own name. Nothing in this component creates it, so the test supplies it the
    // way the widget would.
    const field = document.createElement('input');
    field.type = 'hidden';
    field.name = SUPPORT_FIELDS.turnstile;
    field.value = issued;
    document.body.appendChild(field);

    try {
      render(<SupportForm failure={REFUSAL} siteKey={SITE_KEY} />);

      fireEvent.change(screen.getByLabelText(/mensaje/i), { target: { value: MESSAGE } });
      fireEvent.click(screen.getByRole('button', { name: /enviar/i }));

      await waitFor(() => expect(mocks.sendSupportMessage).toHaveBeenCalledTimes(1));

      const sent = mocks.sendSupportMessage.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(sent[SUPPORT_FIELDS.turnstile]).toBe(issued);
      expect(sent[SUPPORT_FIELDS.turnstile]).not.toBe('');
    } finally {
      field.remove();
    }
  });

  /**
   * Without this, one bad moment is permanent.
   *
   * Cloudflare documents `600*` — the generic bot-behaviour family, which a network
   * hiccup or an adblocker produces as readily as an actual bot — as **retryable**.
   * That is only true if the widget is reset: tokens are single-use, so an unreset
   * widget re-sends a spent token and the gateway refuses it again, every time.
   *
   * The customer who trips this is someone whose registration already failed. They
   * are not going to try a fourth time.
   */
  it('resets the widget after a failure, so the retry can succeed', async () => {
    const reset = vi.fn();
    (globalThis as { turnstile?: unknown }).turnstile = { reset };

    try {
refuse();
      render(<SupportForm failure={REFUSAL} siteKey={SITE_KEY} />);

      fireEvent.change(screen.getByLabelText(/mensaje/i), { target: { value: MESSAGE } });
      fireEvent.click(screen.getByRole('button', { name: /enviar/i }));

      await waitFor(() =>
        expect(screen.getByRole('alert').textContent || '').toMatch(/no llegó tu mensaje|no pudimos enviar/i),
      );

      expect(reset).toHaveBeenCalledTimes(1);
    } finally {
      delete (globalThis as { turnstile?: unknown }).turnstile;
    }
  });

  it('keeps the free text in the textarea and nowhere else', async () => {
    // ## What the invariant actually is
    //
    // The obvious claim — "the message never reaches the DOM" — is **false**, and
    // the suite caught it. A `<textarea>`'s content *is* its DOM: React renders
    // the value as the element's text child, every browser puts it there, and no
    // implementation can hold typed text in a textarea without it being in the
    // document. Asserting the impossible produced a test that passed against an
    // implementation leaking the whole message into a `data-support-message`, for
    // the reason that a successful send unmounts the form before the assertion
    // reads it.
    //
    // So the real property, which is the one worth having:
    //
    //   the message appears in the document **only as the textarea's own value**,
    //   and in no attribute, no URL, and no other element.
    //
    // That is exactly where someone who typed it expects to find it, it is
    // reachable by nobody but the person who wrote it, and it leaves when the form
    // does.
    const { container } = render(<SupportForm failure={REFUSAL} siteKey={SITE_KEY} />);

    /** True if any element in the tree carries the message in an attribute. */
    const leakedIntoAnAttribute = (): boolean => {
      for (const element of container.querySelectorAll('*')) {
        for (const name of element.getAttributeNames()) {
          if ((element.getAttribute(name) ?? '').includes(MESSAGE)) return true;
        }
      }
      return false;
    };

    fireEvent.change(screen.getByLabelText(/mensaje/i), { target: { value: MESSAGE } });

    // 1. It is in the textarea, which is the point of a textarea.
    expect(container.querySelector('textarea')?.textContent).toContain(MESSAGE);

    // 2. It is in no attribute of any element — not `data-*`, not `value`, not
    //    `placeholder`, not a title. This is the check that catches the leak the
    //    first version of this test missed.
    expect(leakedIntoAnAttribute()).toBe(false);

    // 3. Not in the URL, where it would outlive the request in history and in
    //    every proxy log on the way.
    expect(window.location.href).not.toContain(MESSAGE);

    // 4. Not mirrored into a second input — the honeypot exists, and a naive
    //    implementation that keeps the text somewhere readable would use it.
    expect(container.querySelector('input[name="company_website"]')?.getAttribute('value')).not.toContain(
      MESSAGE,
    );

    // 5. After a **failure** the form stays mounted, on purpose, so a paragraph
    //    typed on a phone is not retyped. The text is therefore still in the
    //    textarea — and still in nothing else.
    refuse();
    fireEvent.click(screen.getByRole('button', { name: /enviar/i }));
    await screen.findByText(/no llegó tu mensaje/i);

    expect(container.querySelector('textarea')?.textContent).toContain(MESSAGE);
    expect(leakedIntoAnAttribute()).toBe(false);

    // 6. A success replaces the form, and the message leaves with it — so the
    //    confirmation on screen carries no trace of what was written.
    mocks.sendSupportMessage.mockResolvedValue({ status: 'accepted', request_id: 'req-1' });
    fireEvent.click(screen.getByRole('button', { name: /enviar/i }));
    await screen.findByText(/recibimos/i);

    expect(document.body.innerHTML).not.toContain(MESSAGE);
  });

  it('keeps the code and the status on the element the screen already had', () => {
    // Not re-asserted here — `wallet-card.behavior.test.tsx` owns those two
    // attributes. What matters is that the form reads them as values rather than
    // spelling its own copy of a code anywhere near the payload.
    render(<SupportForm failure={REFUSAL} siteKey={SITE_KEY} />);

    fireEvent.change(screen.getByLabelText(/mensaje/i), { target: { value: MESSAGE } });
    fireEvent.click(screen.getByRole('button', { name: /enviar/i }));

    const body = JSON.stringify(mocks.sendSupportMessage.mock.calls[0]?.[0]);
    expect(body).toContain('WALLET_CLASS_NOT_APPROVED');
  });

  it('confirms when the send went through', async () => {
    render(<SupportForm failure={REFUSAL} siteKey={SITE_KEY} />);

    fireEvent.change(screen.getByLabelText(/mensaje/i), { target: { value: MESSAGE } });
    fireEvent.click(screen.getByRole('button', { name: /enviar/i }));

    await screen.findByText(/recibimos/i);
  });

  it('says the message did not arrive when the send failed', async () => {
    // The claim this whole form exists to make honestly. A confirmation for a
    // send that did not happen is the one thing nobody downstream can check.
    refuse();

    render(<SupportForm failure={REFUSAL} siteKey={SITE_KEY} />);

    fireEvent.change(screen.getByLabelText(/mensaje/i), { target: { value: MESSAGE } });
    fireEvent.click(screen.getByRole('button', { name: /enviar/i }));

    const error = await screen.findByText(/no llegó tu mensaje/i);

    expect(error.textContent).not.toMatch(/recibimos/i);
    expect(screen.queryByText(/gracias/i)).toBeNull();
  });

  it('keeps what the person wrote after a failure, so they do not retype it', async () => {
    // The other half of an honest failure. Losing a paragraph someone just typed
    // on a phone is its own small betrayal, and it is the reason a support form
    // usually gets abandoned.
    refuse();

    render(<SupportForm failure={REFUSAL} siteKey={SITE_KEY} />);

    const field = screen.getByLabelText(/mensaje/i);
    fireEvent.change(field, { target: { value: MESSAGE } });
    fireEvent.click(screen.getByRole('button', { name: /enviar/i }));

    await screen.findByText(/no llegó tu mensaje/i);

    expect((field as HTMLTextAreaElement).value).toBe(MESSAGE);
  });

  it('offers a retry after a failure, rather than only an apology', async () => {
    refuse();

    render(<SupportForm failure={REFUSAL} siteKey={SITE_KEY} />);

    fireEvent.change(screen.getByLabelText(/mensaje/i), { target: { value: MESSAGE } });
    fireEvent.click(screen.getByRole('button', { name: /enviar/i }));

    await screen.findByText(/no llegó tu mensaje/i);

    expect(screen.getByRole('button', { name: /enviar/i })).toBeTruthy();
  });
});

describe('the honeypot', () => {
  it('is present in the DOM and carries no label a person could read', () => {
    // Present, because a field that is not in the document is not a honeypot — a
    // bot only fills what it finds. Unlabelled and visually gone, so a person is
    // never asked to fill a field they cannot see.
    const { container } = render(<SupportForm failure={REFUSAL} siteKey={SITE_KEY} />);
    const trap = container.querySelector('input[name="company_website"]');

    expect(trap).not.toBeNull();
    expect(trap?.getAttribute('aria-label')).toBeNull();
    expect(screen.queryByText(/empresa/i)).toBeNull();
  });

  it('is hidden with a class rather than an inline style or aria-hidden', () => {
    // Both alternatives are forbidden here: `a11y-hygiene.contract.test.ts`
    // rejects every `style={{`, and rejects `aria-hidden` on anything Tab can
    // reach — which an input is. A `display: none` wrapper satisfies the
    // constraint instead of weakening it.
    const { container } = render(<SupportForm failure={REFUSAL} siteKey={SITE_KEY} />);

    expect(container.querySelector('.support-form__trap')).not.toBeNull();
  });
});

describe('without a Turnstile widget', () => {
  // `NEXT_PUBLIC_TURNSTILE_SITE_KEY` is unset in this environment and no widget
  // has been created, so this is not a hypothetical branch: it is what the
  // component renders today. Every assertion below is about the shipped state.

  it('does not render the form, because it could not work', () => {
    // Without a widget there is no token, so the gateway answers 403 — after
    // taking a paragraph from someone on a phone. Rendering the fields anyway
    // would be the dishonest choice, not the cautious one.
    render(<SupportForm failure={REFUSAL} />);

    expect(screen.queryByLabelText(/mensaje/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /enviar/i })).toBeNull();
  });

  it('never calls the API, because there is no control to call it from', () => {
    render(<SupportForm failure={REFUSAL} />);

    expect(mocks.sendSupportMessage).not.toHaveBeenCalled();
  });

  it('says the channel is unavailable, rather than disappearing', () => {
    // A control that silently vanishes leaves the sentence from `lib/wallet.ts`
    // as the only thing on the screen — the honest absence this form replaced.
    render(<SupportForm failure={REFUSAL} />);

    expect(screen.getByText(/no está disponible/i)).toBeTruthy();
  });

  it('keeps the advice that is true either way', () => {
    // "Contale al comercio" is what the card already says, and it remains correct
    // whatever this component does. An unavailable channel must not remove the one
    // route to a human that demonstrably works.
    render(<SupportForm failure={REFUSAL} />);

    expect(screen.getByText(/contale al comercio/i)).toBeTruthy();
  });

  it('never shows a confirmation, having sent nothing', () => {
    render(<SupportForm failure={REFUSAL} />);

    expect(screen.queryByText(/recibimos/i)).toBeNull();
  });
});

describe('the widget it renders when a key exists', () => {
  it('hands Cloudflare the configured key, and never one of its testing keys', () => {
    const { container } = render(<SupportForm failure={REFUSAL} siteKey="0x4AAAAAAA_real" />);
    const widget = container.querySelector('.cf-turnstile');

    expect(widget?.getAttribute('data-sitekey')).toBe('0x4AAAAAAA_real');
    expect(widget?.getAttribute('data-sitekey')).not.toMatch(/^[12]x0{10,}/);
  });

  it('treats a blank key as no key', () => {
    // `NEXT_PUBLIC_*` is substituted at build time, so an unset variable arrives as
    // `''` as readily as `undefined`. Rendering a widget with an empty
    // `data-sitekey` looks like a broken page rather than an absent feature.
    const { container } = render(<SupportForm failure={REFUSAL} siteKey="   " />);

    expect(container.querySelector('.cf-turnstile')).toBeNull();
    expect(screen.queryByRole('button', { name: /enviar/i })).toBeNull();
  });
});

describe('validation before the network', () => {
  it('does not call the API for a message under the minimum', () => {
    render(<SupportForm failure={REFUSAL} siteKey={SITE_KEY} />);

    fireEvent.change(screen.getByLabelText(/mensaje/i), { target: { value: 'hola' } });
    fireEvent.click(screen.getByRole('button', { name: /enviar/i }));

    expect(mocks.sendSupportMessage).not.toHaveBeenCalled();
  });

  it('does not call the API for a message over the maximum', () => {
    render(<SupportForm failure={REFUSAL} siteKey={SITE_KEY} />);

    fireEvent.change(screen.getByLabelText(/mensaje/i), { target: { value: 'a'.repeat(2001) } });
    fireEvent.click(screen.getByRole('button', { name: /enviar/i }));

    expect(mocks.sendSupportMessage).not.toHaveBeenCalled();
  });

  it('sends a message exactly at the maximum', async () => {
    render(<SupportForm failure={REFUSAL} siteKey={SITE_KEY} />);

    fireEvent.change(screen.getByLabelText(/mensaje/i), { target: { value: 'a'.repeat(2000) } });
    fireEvent.click(screen.getByRole('button', { name: /enviar/i }));

    await waitFor(() => expect(mocks.sendSupportMessage).toHaveBeenCalled());
  });

  it('caps the field at the maximum, so the limit is visible while typing', () => {
    const { container } = render(<SupportForm failure={REFUSAL} siteKey={SITE_KEY} />);
    const field = container.querySelector('textarea');

    expect(field?.getAttribute('maxlength')).toBe('2000');
  });
});
