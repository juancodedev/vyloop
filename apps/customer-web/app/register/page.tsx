'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';

import { ClubShell } from '../components/club-shell';
import { ClubLoading } from '../components/club-status';
import { ConsentList } from '../components/consent-list';
import { FormField } from '../components/form-field';
import { api } from '../lib/api';
import { gatewayUrl } from '../lib/gateway-url';

interface RegisterFormValues {
  fullName: string;
  phone: string;
  email: string;
  birthDate: string;
}

/**
 * Why the email is offered but not required.
 *
 * ## What the customer is told
 *
 * `email` is a **visible field** in the main group, next to the name and the
 * phone, and it is optional. That used to be true in name only: it existed, but
 * inside a collapsed `<details>` under "¿Querés completar algo más ahora?" with
 * the helper "Solo si te resulta cómodo". A merchant who needs to be able to
 * reach their customer was asking for a channel and the form hid it.
 *
 * ## Why it is optional, stated plainly
 *
 * **Nothing verifies it.** There is no OTP for the phone either —
 * `POST /v1/auth/customer/token` is documented in `workers/identity/src/index.ts`
 * as "phone-only auth (demo mode, no OTP)" and selects `customers.phone`. So
 * the register form collects two unverified identifiers and no verified one.
 *
 * That is the whole reason this cannot be a required field. An unverified email
 * is worth exactly as much as no email as a recovery channel — and the moment
 * phone login starts requiring an OTP, an email nobody has confirmed is not a
 * fallback either. Requiring it now would add a PII obligation and a false
 * promise of reachability, and would block a customer with no email address
 * from joining a programme that only asks for a phone to identify them.
 *
 * ## What it is actually for
 *
 * Letting the business reach the customer who joined it: a promotion, a change
 * of hours, a closure. Not authentication, and not recovery — and the helper
 * text says so, so a customer does not read it as a promise that a lost phone
 * can be reset by mail.
 */

interface FormErrors {
  fullName?: string;
  phone?: string;
}

class CustomerCreationError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'CustomerCreationError';
    this.status = status;
  }
}

function buildBusinessHref(pathname: string, businessSlug: string | null) {
  if (!businessSlug) return pathname;

  const searchParams = new URLSearchParams();
  searchParams.set('biz', businessSlug);
  return `${pathname}?${searchParams.toString()}`;
}

function getClientErrorMessage(status: number, serverMessage: string | null) {
  if (status === 404) {
    return 'No encontramos este programa. Volvé al inicio y elegí el comercio correcto.';
  }

  if (serverMessage) {
    const safeMessage = serverMessage.replace(/[\r\n]+/g, ' ').trim();
    if (safeMessage && safeMessage.length <= 180) return safeMessage;
  }

  return 'No pudimos completar el registro con estos datos. Revisá los campos e intentá de nuevo.';
}

function isNetworkError(error: unknown) {
  // An HTTP response that already reached us is a server outcome, not a local
  // outage, even when the gateway text happens to read like a fetch failure.
  if (error instanceof CustomerCreationError) return false;

  return (
    error instanceof TypeError ||
    (error instanceof Error && /failed to fetch|networkerror|load failed/i.test(error.message))
  );
}

function RegisterLoading() {
  return (
    <ClubShell backLink={{ href: '/', label: 'Volver al inicio' }} className="club-register-shell">
      <div className="club-register-loading">
        <ClubLoading label="Preparando tu registro…" />
      </div>
    </ClubShell>
  );
}

function RegisterContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const businessSlug = searchParams.get('biz') || null;
  const hasBusinessContext = businessSlug !== null;
  const homeHref = buildBusinessHref('/', businessSlug);
  const loginHref = buildBusinessHref('/login', businessSlug);

  const [form, setForm] = useState<RegisterFormValues>({
    fullName: '',
    phone: '',
    email: '',
    birthDate: '',
  });
  const [errors, setErrors] = useState<FormErrors>({});
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [accountCreated, setAccountCreated] = useState(false);
  const fullNameRef = useRef<HTMLInputElement>(null);
  const phoneRef = useRef<HTMLInputElement>(null);
  const shouldFocusErrors = useRef(false);

  useEffect(() => {
    if (!shouldFocusErrors.current) return;

    shouldFocusErrors.current = false;
    if (errors.fullName) {
      fullNameRef.current?.focus();
    } else if (errors.phone) {
      phoneRef.current?.focus();
    }
  }, [errors]);

  function updateField(field: keyof RegisterFormValues, event: ChangeEvent<HTMLInputElement>) {
    const value = event.target.value;
    setForm((current) => ({ ...current, [field]: value }));

    if (field === 'fullName' || field === 'phone') {
      setErrors((current) => {
        if (!current[field]) return current;
        const next = { ...current };
        delete next[field];
        return next;
      });
    }
  }

  function validate(): FormErrors {
    const nextErrors: FormErrors = {};
    if (!form.fullName.trim()) nextErrors.fullName = 'Ingresá tu nombre completo.';
    if (!form.phone.trim()) nextErrors.phone = 'Ingresá tu teléfono.';
    return nextErrors;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setServerError(null);

    if (!businessSlug) {
      setServerError(
        'Falta el contexto del comercio. Volvé al inicio para abrir el enlace correcto.',
      );
      return;
    }

    const validationErrors = validate();
    if (Object.keys(validationErrors).length > 0) {
      shouldFocusErrors.current = true;
      setErrors(validationErrors);
      return;
    }

    setSubmitting(true);
    let customerCreated = false;

    const fullName = form.fullName.trim();
    const phone = form.phone.trim();
    const email = form.email.trim();

    try {
      const payload: Record<string, string> = {
        fullName,
        phone,
        businessSlug,
      };
      if (email) payload.email = email;
      if (form.birthDate) payload.birthDate = form.birthDate;

      const response = await fetch(
        `${gatewayUrl()}/v1/customers`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        },
      );

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: { message?: unknown };
        } | null;
        const serverMessage = typeof body?.error?.message === 'string' ? body.error.message : null;
        throw new CustomerCreationError(
          response.status,
          getClientErrorMessage(response.status, serverMessage),
        );
      }

      customerCreated = true;
      const authResult = await api.loginCustomer(phone, businessSlug);
      localStorage.setItem('vyloop_jwt', authResult.token);
      localStorage.setItem(
        'vyloop_customer',
        JSON.stringify({
          fullName: authResult.customer.name,
          globalId: authResult.customer.globalId,
        }),
      );
      router.push('/profile');
    } catch (error) {
      if (customerCreated) {
        setAccountCreated(true);
      } else if (
        error instanceof CustomerCreationError &&
        error.status >= 400 &&
        error.status < 500
      ) {
        setServerError(error.message);
      } else if (isNetworkError(error)) {
        setServerError(
          'No pudimos conectar con el gateway local. Revisá que esté disponible e intentá de nuevo.',
        );
      } else {
        setServerError('No pudimos completar el registro. Revisá los datos e intentá de nuevo.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <ClubShell
      backLink={{ href: homeHref, label: 'Volver al inicio' }}
      className="club-register-shell"
    >
      <section className="club-register" aria-labelledby="club-register-title">
        <div className="club-register__intro">
          <p className="club-register__eyebrow">Club del barrio</p>
          <h1 id="club-register-title" className="club-register__title">
            Entrá a tu club
          </h1>
          <p className="club-register__summary">
            Con tu nombre y teléfono ya podés seguir con este programa.
          </p>
        </div>

        <div className="club-register__context" aria-label="Contexto del programa">
          <p className="club-register__context-label">Estás registrando tu cuenta en</p>
          <h2 className="club-register__context-title">Este programa</h2>
          <p className="club-register__context-copy">
            El contexto viene del enlace del comercio que abriste.
          </p>
        </div>

        {/* A refused registration, above the form. Read in document order. */}
        {!hasBusinessContext ? (
          <div
            className="club-register__status club-register__status--missing"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            <strong>Falta el contexto del comercio.</strong>
            <p>Volvé al inicio y abrí el enlace del club que querés visitar.</p>
            <Link className="btn btn--outline club-register__status-action" href={homeHref}>
              Volver al inicio
            </Link>
          </div>
        ) : null}

        {/*
          `role="alert"` on both post-submission boxes, and not on the
          "falta el contexto" notice above.

          A live region inserted into the DOM already containing its text is not
          reliably announced when it is `polite`, and both of these arrive the
          moment the server answers, with focus still on the submit button: a
          refused registration, and the partial success where the account exists
          but the session could not be started. A refusal and a half-finished
          registration are exactly the two events where silence is the worse
          mistake, and `alert` is announced on insertion where `status` is not.

          The missing-context notice stays `status` because it is present on the
          first render rather than arriving after an action, so it is read in
          document order and does not need to interrupt anything.
        */}
        {serverError ? (
          <div
            className="club-register__status club-register__status--error"
            role="alert"
            aria-atomic="true"
          >
            <strong>No pudimos completar el registro.</strong>
            <p>{serverError}</p>
          </div>
        ) : null}

        {accountCreated ? (
          <div
            className="club-register__status club-register__status--partial"
            role="alert"
            aria-atomic="true"
          >
            <strong>Tu cuenta fue creada.</strong>
            <p>
              No pudimos iniciar sesión automáticamente. Ingresá con tu teléfono para continuar.
            </p>
            <Link className="btn btn--outline club-register__status-action" href={loginHref}>
              Ir a ingresar
            </Link>
          </div>
        ) : null}

        <form
          className="club-register__form"
          onSubmit={handleSubmit}
          noValidate
          aria-busy={submitting}
        >
          <fieldset className="club-register__fieldset" disabled={!hasBusinessContext}>
            <legend className="club-register__legend">Datos para tu cuenta</legend>
            <div className="club-register__fields">
              <FormField
                id="fullName"
                name="fullName"
                label="Nombre completo"
                type="text"
                value={form.fullName}
                onChange={(event) => updateField('fullName', event)}
                autoComplete="name"
                helperText="Así te reconocemos cuando vuelvas a tu local."
                error={errors.fullName}
                required
                inputRef={fullNameRef}
              />
              <FormField
                id="phone"
                name="phone"
                label="Teléfono"
                type="tel"
                inputMode="tel"
                value={form.phone}
                onChange={(event) => updateField('phone', event)}
                autoComplete="tel"
                helperText="Incluí el código de país. Por ejemplo, +56 9..."
                error={errors.phone}
                required
                inputRef={phoneRef}
              />
              {/*
                A visible field, not a collapsed one. See the note on
                `RegisterFormValues` for why it is optional — the short version is
                that nothing verifies it, so it is a channel for the business to
                reach the customer and nothing more. The helper text says exactly
                that, so a customer does not read it as a recovery address.
              */}
              <FormField
                id="email"
                name="email"
                label="Email"
                type="email"
                value={form.email}
                onChange={(event) => updateField('email', event)}
                autoComplete="email"
                helperText="Opcional. Es para que el negocio te pueda avisar de novedades."
                spellCheck={false}
              />
            </div>

            <details className="club-register__optional">
              <summary className="club-register__optional-summary">
                ¿Querés completar algo más ahora?
              </summary>
              <p className="club-register__optional-copy">
                Estos datos son opcionales y podés dejarlos para más adelante.
              </p>
              <div className="club-register__optional-fields">
                <FormField
                  id="birthDate"
                  name="birthDate"
                  label="Fecha de nacimiento"
                  type="date"
                  value={form.birthDate}
                  onChange={(event) => updateField('birthDate', event)}
                  autoComplete="off"
                  helperText="Opcional."
                />
              </div>
            </details>

            <button
              className="btn btn--primary club-register__submit"
              type="submit"
              disabled={submitting || accountCreated}
            >
              {submitting ? 'Registrando…' : accountCreated ? 'Cuenta creada' : 'Registrarme'}
            </button>
          </fieldset>
        </form>

        <ConsentList />
      </section>
    </ClubShell>
  );
}

export default function RegisterPage() {
  return (
    <Suspense fallback={<RegisterLoading />}>
      <RegisterContent />
    </Suspense>
  );
}
