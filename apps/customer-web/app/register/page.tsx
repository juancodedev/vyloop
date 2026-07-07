'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

import { api } from '../lib/api';

interface FormData {
  fullName: string;
  phone: string;
  email: string;
  birthDate: string;
}

interface FormErrors {
  fullName?: string;
  phone?: string;
}

export default function RegisterPage() {
  const router = useRouter();
  const [form, setForm] = useState<FormData>({
    fullName: '',
    phone: '',
    email: '',
    birthDate: '',
  });
  const [errors, setErrors] = useState<FormErrors>({});
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  // Extract business slug from URL (e.g. ?biz=cafe-central)
  const businessSlug =
    typeof window !== 'undefined'
      ? new URLSearchParams(window.location.search).get('biz')
      : null;

  function validate(): FormErrors {
    const errs: FormErrors = {};
    if (!form.fullName.trim()) errs.fullName = 'El nombre es obligatorio';
    if (!form.phone.trim()) errs.phone = 'El teléfono es obligatorio';
    return errs;
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setServerError(null);

    const validationErrors = validate();
    setErrors(validationErrors);

    if (Object.keys(validationErrors).length > 0) return;

    setSubmitting(true);

    try {
      const payload: Record<string, string> = {
        fullName: form.fullName.trim(),
        phone: form.phone.trim(),
      };
      if (businessSlug) payload.businessSlug = businessSlug;
      if (form.email.trim()) payload.email = form.email.trim();
      if (form.birthDate) payload.birthDate = form.birthDate;

      const res = await fetch(
        `${process.env.NEXT_PUBLIC_GATEWAY_URL ?? 'http://localhost:8787'}/v1/customers`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        },
      );

      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(
          body?.error?.message ?? `Error ${res.status}: no se pudo registrar`,
        );
      }

      // Auto-login: issue JWT for the registered phone and redirect to profile
      const authResult = await api.loginCustomer(form.phone.trim(), businessSlug ?? undefined);
      localStorage.setItem('vyloop_jwt', authResult.token);
      localStorage.setItem(
        'vyloop_customer',
        JSON.stringify({
          fullName: authResult.customer.name,
          globalId: authResult.customer.globalId,
        }),
      );
      router.push('/profile');
    } catch (err) {
      setServerError(
        err instanceof Error ? err.message : 'Error inesperado',
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main style={styles.main}>
      <div style={styles.card}>
        <h1 style={styles.title}>Registrate</h1>
        <p style={styles.subtitle}>Completá tus datos para empezar</p>

        {serverError && <div style={styles.serverError}>{serverError}</div>}

        <form onSubmit={handleSubmit} noValidate>
          <div style={styles.field}>
            <label style={styles.label} htmlFor="fullName">
              Nombre completo *
            </label>
            <input
              id="fullName"
              style={{
                ...styles.input,
                ...(errors.fullName ? styles.inputError : {}),
              }}
              value={form.fullName}
              onChange={(e) =>
                setForm({ ...form, fullName: e.target.value })
              }
              placeholder="Juan Pérez"
            />
            {errors.fullName && (
              <span style={styles.errorText}>{errors.fullName}</span>
            )}
          </div>

          <div style={styles.field}>
            <label style={styles.label} htmlFor="phone">
              Teléfono *
            </label>
            <input
              id="phone"
              type="tel"
              style={{
                ...styles.input,
                ...(errors.phone ? styles.inputError : {}),
              }}
              value={form.phone}
              onChange={(e) => setForm({ ...form, phone: e.target.value })}
              placeholder="+56 9 1234 5678"
            />
            {errors.phone && (
              <span style={styles.errorText}>{errors.phone}</span>
            )}
          </div>

          <div style={styles.field}>
            <label style={styles.label} htmlFor="email">
              Email
            </label>
            <input
              id="email"
              type="email"
              style={styles.input}
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              placeholder="cliente@ejemplo.com"
            />
          </div>

          <div style={styles.field}>
            <label style={styles.label} htmlFor="birthDate">
              Fecha de nacimiento
            </label>
            <input
              id="birthDate"
              type="date"
              style={styles.input}
              value={form.birthDate}
              onChange={(e) =>
                setForm({ ...form, birthDate: e.target.value })
              }
            />
          </div>

          <button
            type="submit"
            style={styles.button}
            disabled={submitting}
          >
            {submitting ? 'Registrando...' : 'Registrarme'}
          </button>
        </form>
      </div>
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  main: {
    minHeight: '100dvh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '16px',
    background: 'var(--surface-page)',
    fontFamily: 'var(--font-body), -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  },
  card: {
    background: 'var(--surface-card)',
    borderRadius: 'var(--radius-xl)',
    padding: '32px 24px',
    maxWidth: '360px',
    width: '100%',
    boxShadow: 'var(--shadow-md)',
  },
  title: {
    fontSize: 'var(--text-2xl)',
    fontWeight: 700,
    margin: '0 0 4px',
    color: 'var(--text-primary)',
    textAlign: 'center',
  },
  subtitle: {
    fontSize: 'var(--text-base)',
    color: 'var(--text-secondary)',
    margin: '0 0 var(--space-6)',
    textAlign: 'center',
  },
  serverError: {
    background: 'var(--error-bg)',
    color: 'oklch(0.35 0.15 28)',
    padding: '10px 14px',
    borderRadius: 'var(--radius-md)',
    fontSize: 'var(--text-sm)',
    marginBottom: 'var(--space-4)',
  },
  field: {
    marginBottom: 'var(--space-4)',
  },
  label: {
    display: 'block',
    fontSize: 'var(--text-sm)',
    fontWeight: 600,
    color: 'var(--text-body)',
    marginBottom: '6px',
  },
  input: {
    width: '100%',
    padding: '12px 14px',
    fontSize: 'var(--text-base)',
    border: '1px solid var(--border-input)',
    borderRadius: 'var(--radius-md)',
    outline: 'none',
    boxSizing: 'border-box',
    minHeight: '44px',
  },
  inputError: {
    borderColor: 'var(--error)',
  },
  errorText: {
    display: 'block',
    color: 'var(--error)',
    fontSize: 'var(--text-xs)',
    marginTop: '4px',
  },
  button: {
    width: '100%',
    padding: '14px 0',
    background: 'var(--brand-500)',
    color: 'var(--text-inverse)',
    fontSize: 'var(--text-lg)',
    fontWeight: 600,
    borderRadius: 'var(--radius-md)',
    border: 'none',
    cursor: 'pointer',
    minHeight: '48px',
    marginTop: '8px',
  },
};
