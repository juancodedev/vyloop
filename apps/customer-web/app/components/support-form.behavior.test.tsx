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

  it('never writes the free text into the DOM', async () => {
    // Asserted after a real send, so the form has actually held the text at the
    // moment the assertion runs. A `data-support-message` or a hidden mirror
    // input would be found here.
    const { container } = render(<SupportForm failure={REFUSAL} siteKey={SITE_KEY} />);

    fireEvent.change(screen.getByLabelText(/mensaje/i), { target: { value: MESSAGE } });
    fireEvent.click(screen.getByRole('button', { name: /enviar/i }));

    await waitFor(() => expect(mocks.sendSupportMessage).toHaveBeenCalled());

    expect(container.innerHTML).not.toContain(MESSAGE);
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
