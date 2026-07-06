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
    background: '#f9fafb',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  },
  card: {
    background: 'white',
    borderRadius: '16px',
    padding: '32px 24px',
    maxWidth: '360px',
    width: '100%',
    boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
  },
  title: {
    fontSize: '24px',
    fontWeight: 700,
    margin: '0 0 4px',
    color: '#111827',
    textAlign: 'center',
  },
  subtitle: {
    fontSize: '14px',
    color: '#6b7280',
    margin: '0 0 24px',
    textAlign: 'center',
  },
  serverError: {
    background: '#fef2f2',
    color: '#991b1b',
    padding: '10px 14px',
    borderRadius: '8px',
    fontSize: '13px',
    marginBottom: '16px',
  },
  field: {
    marginBottom: '16px',
  },
  label: {
    display: 'block',
    fontSize: '13px',
    fontWeight: 600,
    color: '#374151',
    marginBottom: '6px',
  },
  input: {
    width: '100%',
    padding: '12px 14px',
    fontSize: '15px',
    border: '1px solid #d1d5db',
    borderRadius: '8px',
    outline: 'none',
    boxSizing: 'border-box',
    minHeight: '44px',
  },
  inputError: {
    borderColor: '#ef4444',
  },
  errorText: {
    display: 'block',
    color: '#ef4444',
    fontSize: '12px',
    marginTop: '4px',
  },
  button: {
    width: '100%',
    padding: '14px 0',
    background: '#2563eb',
    color: 'white',
    fontSize: '16px',
    fontWeight: 600,
    borderRadius: '10px',
    border: 'none',
    cursor: 'pointer',
    minHeight: '48px',
    marginTop: '8px',
  },
};
