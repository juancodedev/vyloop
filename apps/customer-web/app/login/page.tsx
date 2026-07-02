'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { useAuth } from '../lib/auth';

export default function LoginPage() {
  const router = useRouter();
  const { login } = useAuth();
  const [phone, setPhone] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    const cleaned = phone.replace(/[\s-]/g, '');
    if (!cleaned) {
      setError('Ingresá tu número de teléfono');
      return;
    }

    // Auto-prepend +56 if missing
    const fullPhone = cleaned.startsWith('+56')
      ? cleaned
      : cleaned.startsWith('56')
        ? `+${cleaned}`
        : `+56${cleaned}`;

    setSubmitting(true);
    const success = login(fullPhone);

    if (success) {
      router.push('/profile');
    } else {
      setError('Número no registrado. ¿Ya te registraste?');
      setSubmitting(false);
    }
  }

  return (
    <div className="page page--centered">
      <div className="card">
        <h1 className="title">Ingresá</h1>
        <p className="subtitle">Ingresá tu número de teléfono para entrar</p>

        {error && <div className="error-box">{error}</div>}

        <form onSubmit={handleSubmit} noValidate>
          <div className="field">
            <label className="label" htmlFor="phone">
              Teléfono
            </label>
            <input
              id="phone"
              type="tel"
              className={`input input--phone${error ? ' input--error' : ''}`}
              value={phone}
              onChange={(e) => {
                setPhone(e.target.value);
                if (error) setError(null);
              }}
              placeholder="+56 9 1234 5678"
              autoComplete="tel"
              autoFocus
            />
          </div>

          <button
            type="submit"
            className="btn btn--primary"
            disabled={submitting}
          >
            {submitting ? 'Entrando...' : 'Ingresar'}
          </button>
        </form>

        <div className="link-row">
          <span>¿Nuevo?</span>
          <Link href="/register">Registrate aquí</Link>
        </div>
      </div>
    </div>
  );
}
