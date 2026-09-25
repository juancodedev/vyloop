'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';

import { ClubShell } from '../components/club-shell';
import { ClubLoading } from '../components/club-status';
import { FormField } from '../components/form-field';
import { useAuth, type LoginFailureReason } from '../lib/auth';

const LOGIN_FAILURE_MESSAGES: Record<LoginFailureReason, string> = {
  not_registered: 'Número no registrado. ¿Ya te registraste?',
  unavailable: 'No pudimos conectar con el servidor. Revisá tu conexión e intentá de nuevo.',
  unknown: 'No pudimos completar el ingreso. Revisá los datos e intentá de nuevo.',
};

const LOGIN_FAILURE_TITLES: Record<LoginFailureReason, string> = {
  not_registered: 'No encontramos ese número.',
  unavailable: 'No pudimos ingresarte ahora.',
  unknown: 'Algo salió mal al ingresar.',
};

function buildBusinessHref(pathname: string, businessSlug: string | null) {
  if (!businessSlug) return pathname;

  const searchParams = new URLSearchParams();
  searchParams.set('biz', businessSlug);
  return `${pathname}?${searchParams.toString()}`;
}

/**
 * Strips separators the user may type and forces the Chilean country code.
 * The gateway strips whitespace server-side too, but sending one canonical
 * value keeps client logs, analytics and the API payload comparable.
 *
 * Returns `null` when nothing usable was typed, so emptiness is a local
 * decision that never reaches the network.
 */
function parsePhone(rawPhone: string): string | null {
  const cleaned = rawPhone.replace(/[\s-]/g, '');
  if (!cleaned) return null;

  if (cleaned.startsWith('+56')) return cleaned;
  if (cleaned.startsWith('56')) return `+${cleaned}`;
  return `+56${cleaned}`;
}

function LoginPreparing() {
  return (
    <ClubShell backLink={{ href: '/', label: 'Volver al inicio' }} className="club-login-shell">
      <div className="club-login-loading">
        <ClubLoading label="Preparando tu ingreso…" />
      </div>
    </ClubShell>
  );
}

function LoginContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { login } = useAuth();
  const businessSlug = searchParams.get('biz') || null;
  const homeHref = buildBusinessHref('/', businessSlug);
  const registerHref = buildBusinessHref('/register', businessSlug);

  const [phone, setPhone] = useState('');
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [failure, setFailure] = useState<LoginFailureReason | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const phoneRef = useRef<HTMLInputElement>(null);
  const shouldFocusPhone = useRef(false);

  useEffect(() => {
    if (!shouldFocusPhone.current) return;

    shouldFocusPhone.current = false;
    phoneRef.current?.focus();
  }, [phoneError]);

  function updatePhone(event: ChangeEvent<HTMLInputElement>) {
    setPhone(event.target.value);

    if (phoneError) setPhoneError(null);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFailure(null);

    const fullPhone = parsePhone(phone);
    if (!fullPhone) {
      setPhoneError('Ingresá tu número de teléfono.');
      shouldFocusPhone.current = true;
      return;
    }

    setSubmitting(true);

    try {
      const result = await login(fullPhone, businessSlug ?? undefined);

      if (result.ok) {
        router.push('/profile');
        return;
      }

      setFailure(result.reason);
    } catch {
      // `login` is contracted to resolve, so this is a defensive net only.
      setFailure('unavailable');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <ClubShell backLink={{ href: homeHref, label: 'Volver al inicio' }} className="club-login-shell">
      <section className="club-login" aria-labelledby="club-login-title">
        <div className="club-login__intro">
          <p className="club-login__eyebrow">Club del barrio</p>
          <h1 id="club-login-title" className="club-login__title">
            Ingresá
          </h1>
          <p className="club-login__summary">
            Con el teléfono con el que te registraste entrás directo a tu club.
          </p>
        </div>

        {businessSlug ? (
          <div className="club-login__context" aria-label="Contexto del programa">
            <p className="club-login__context-label">Estás ingresando en</p>
            <h2 className="club-login__context-title">Este programa</h2>
            <p className="club-login__context-copy">
              El contexto viene del enlace del comercio que abriste.
            </p>
          </div>
        ) : null}

        {failure ? (
          <div
            className="club-login__status club-login__status--error"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            <strong>{LOGIN_FAILURE_TITLES[failure]}</strong>
            <p>{LOGIN_FAILURE_MESSAGES[failure]}</p>
            {failure === 'not_registered' ? (
              <Link className="btn btn--outline club-login__status-action" href={registerHref}>
                Registrarme ahora
              </Link>
            ) : null}
          </div>
        ) : null}

        <form
          className="club-login__form"
          onSubmit={handleSubmit}
          noValidate
          aria-busy={submitting}
        >
          <FormField
            id="phone"
            name="phone"
            label="Teléfono"
            type="tel"
            inputMode="tel"
            value={phone}
            onChange={updatePhone}
            autoComplete="tel"
            className="input--phone"
            helperText="Incluí el código de país. Por ejemplo, +56 9 1234 5678."
            error={phoneError ?? undefined}
            required
            inputRef={phoneRef}
          />

          <button
            className="btn btn--primary club-login__submit"
            type="submit"
            disabled={submitting}
          >
            {submitting ? 'Entrando…' : 'Ingresar'}
          </button>
        </form>

        <p className="club-login__switch">
          ¿Nuevo en este club?{' '}
          <Link href={registerHref}>Registrate aquí</Link>
        </p>
      </section>
    </ClubShell>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<LoginPreparing />}>
      <LoginContent />
    </Suspense>
  );
}
