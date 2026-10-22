'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState, useCallback, type FormEvent } from 'react';

import { signupBusiness } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { registrationPath } from '@/lib/merchant-qr';

const EyeIcon = (
  <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

const EyeOffIcon = (
  <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
    <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
    <path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
    <line x1="2" x2="22" y1="2" y2="22" />
  </svg>
);

/**
 * Self-service signup, at `/login?signup=true`.
 *
 * The landing page's "Comenzar gratis" button points here, so this is the whole
 * self-service path: before it, the only way to create a business was
 * `POST /v1/auth/business/signup` by hand. A merchant who finds the product on their
 * own has no curl, and a signup that exists only as an endpoint is not self-service.
 *
 * On success it signs the new operator in with the credentials they just chose. The
 * alternative — showing "now go to the login page and type it again" — is a second
 * password entry that exists only because two requests could not be chained.
 *
 * What it does not do is pretend the Google Wallet class is ready. Creating a
 * business submits its pass class for review, and that review is Google's and takes
 * time, so the slug is shown immediately and the wallet is not mentioned at all
 * rather than promised.
 */
function SignupCard({ onDone }: { onDone: () => void }) {
  const router = useRouter();
  const { login } = useAuth();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ name: string; slug: string } | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const result = await signupBusiness({ name, email, password, fullName });
      setCreated({ name: result.name, slug: result.slug });

      // The account exists; a session is a separate request. If it fails, the
      // business is still created and the person can sign in from the normal form,
      // which is better than losing the signup because the login blipped.
      try {
        await login(email, password);
        router.push('/dashboard');
      } catch {
        onDone();
      }
    } catch (err) {
      // The server's own words. `BUSINESS_SLUG_TAKEN` names the slug it collided on,
      // which is exactly what someone needs to change the name; a generic "try again"
      // would leave them guessing at an invisible string.
      setError(err instanceof Error ? err.message : 'No pudimos crear el comercio.');
    } finally {
      setBusy(false);
    }
  }

  if (created) {
    return (
      <div className="login-page">
        <div className="login-card">
          <div className="login-brand">
            <h1>
              <span className="brand-accent">V</span>yloop
            </h1>
            <p>Comercio creado</p>
          </div>

          <div className="login-error">
            No pudimos iniciar tu sesión automáticamente. Entrá con el correo y la
            contraseña que acabás de elegir.
          </div>

          {/*
            The slug is the whole point of showing this at all: it is the customer
            URL and the QR the merchant prints. A merchant who cannot read it here
            cannot onboard anyone.
          */}
          <div className="form-group">
            <label htmlFor="created-slug">Tu enlace de registro</label>
            <input
              id="created-slug"
              className="form-control"
              readOnly
              value={registrationPath(created.slug)}
            />
            <small>
              Compartilo con tus clientes, o imprimilo como código QR. También es{' '}
              <code>{created.slug}</code>.
            </small>
          </div>

          <button type="button" className="btn btn-primary" onClick={onDone}>
            Ir a iniciar sesión
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-brand">
          <h1>
            <span className="brand-accent">V</span>yloop
          </h1>
          <p>Crear tu comercio</p>
        </div>

        {error && <div className="login-error">{error}</div>}

        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label htmlFor="s-name">Nombre del comercio</label>
            <input
              id="s-name"
              className="form-control"
              placeholder="Ej. Panadería del Barrio"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              autoFocus
            />
            <small>De este nombre sale el enlace de tus clientes.</small>
          </div>

          <div className="form-group">
            <label htmlFor="s-email">Correo electrónico</label>
            <input
              id="s-email"
              type="email"
              className="form-control"
              placeholder="hola@tucomercio.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>

          <div className="form-group">
            <label htmlFor="s-password">Contraseña</label>
            <input
              id="s-password"
              type="password"
              className="form-control"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={8}
            />
          </div>

          <div className="form-group">
            <label htmlFor="s-fullname">Tu nombre (opcional)</label>
            <input
              id="s-fullname"
              className="form-control"
              placeholder="Juan Muñoz"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
            />
          </div>

          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Creando…' : 'Crear comercio'}
          </button>
        </form>

        <div className="login-footer">
          <button type="button" className="btn btn-link" onClick={onDone}>
            Ya tengo un comercio
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Which form this URL asks for.
 *
 * Isolated into its own component so it is the only thing inside the Suspense
 * boundary. `useSearchParams` suspends during prerendering, and a static export of
 * this page fails the build with "useSearchParams() should be wrapped in a suspense
 * boundary at page /login" — which it did, on `deploy-dashboard`, before this split.
 */
function WhichForm() {
  const searchParams = useSearchParams();
  const goToLogin = useGoToLogin();

  // `signup=true` is the only spelling that opens the signup form. Anything else is
  // the login, so a stray query parameter cannot replace one form with the other.
  return searchParams.get('signup') === 'true' ? <SignupCard onDone={goToLogin} /> : <LoginCard />;
}

/**
 * `replace` rather than `push`: the signup form is a state of this page rather than
 * a place, and backing out of it should not return to the form the merchant just
 * completed.
 */
function useGoToLogin() {
  const router = useRouter();
  return useCallback(() => router.replace('/login'), [router]);
}

export default function LoginPage() {
  return (
    <Suspense fallback={<LoginFallback />}>
      <WhichForm />
    </Suspense>
  );
}

/**
 * What shows while the query string resolves.
 *
 * The login card's own chrome rather than a spinner: the boundary is only reached on
 * a static export where the param is unknown at build time, and a blank screen there
 * reads as a broken page rather than a loading one.
 */
function LoginFallback() {
  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-brand">
          <h1>
            <span className="brand-accent">V</span>yloop
          </h1>
          <p>Panel de administración</p>
        </div>
      </div>
    </div>
  );
}

function LoginCard() {
  const router = useRouter();
  const { login, isLoading } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    try {
      await login(email, password);
      router.push('/dashboard');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al iniciar sesión');
    }
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-brand">
          <h1>
            <span className="brand-accent">V</span>yloop
          </h1>
          <p>Panel de administración</p>
        </div>

        {error && <div className="login-error">{error}</div>}

        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label htmlFor="email">Correo electrónico</label>
            <input
              id="email"
              type="email"
              className="form-control"
              placeholder="demo@cafecentral.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoFocus
            />
          </div>

          <div className="form-group">
            <label htmlFor="password">Contraseña</label>
            <div className="password-wrapper">
              <input
                id="password"
                type={showPassword ? 'text' : 'password'}
                className="form-control"
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
              <button
                type="button"
                className="password-toggle"
                onClick={() => setShowPassword(!showPassword)}
                aria-label={showPassword ? 'Ocultar contraseña' : 'Mostrar contraseña'}
              >
                {showPassword ? EyeOffIcon : EyeIcon}
              </button>
            </div>
          </div>

          <button
            type="submit"
            className="btn btn-primary"
            disabled={isLoading}
          >
            {isLoading ? 'Iniciando sesión…' : 'Iniciar Sesión'}
          </button>
        </form>

        <div className="login-footer">
          Demo: demo@cafecentral.com / demo123
        </div>
      </div>
    </div>
  );
}
