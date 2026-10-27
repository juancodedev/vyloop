'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';

import { api, ApiError, type CustomerProfile, type ProfileFields, type ProfileUpdate } from '../lib/api';

import { FormField } from './form-field';

interface PersonalDataProps {
  profile: CustomerProfile;
  /** The server's answer after a save, for the page to merge into its profile. */
  onSaved: (fields: ProfileFields) => void;
}

const MONTHS = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
];

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TOAST_MS = 4000;

/**
 * "27 de julio" from "1981-07-27", read as the calendar date it is. `new Date`
 * would read it as UTC midnight and show the day before west of Greenwich.
 */
function formatBirthday(value: string): string | null {
  const match = DATE_PATTERN.exec(value);
  if (!match) return null;
  const month = MONTHS[Number(match[2]) - 1];
  if (!month) return null;
  return `${Number(match[3])} de ${month}`;
}

interface Draft {
  fullName: string;
  email: string;
  birthDate: string;
}

function draftFrom(profile: CustomerProfile): Draft {
  return {
    fullName: profile.fullName,
    email: profile.email ? profile.email : '',
    birthDate: profile.birthDate ? profile.birthDate.slice(0, 10) : '',
  };
}

/** Only what changed. An emptied email or birth date is sent as null, which clears it. */
function changesBetween(before: Draft, after: Draft): ProfileUpdate {
  const patch: ProfileUpdate = {};
  const name = after.fullName.trim();
  if (name !== before.fullName) patch.fullName = name;
  const email = after.email.trim();
  if (email !== before.email) patch.email = email === '' ? null : email;
  if (after.birthDate !== before.birthDate) patch.birthDate = after.birthDate === '' ? null : after.birthDate;
  return patch;
}

type FieldErrors = Partial<Record<keyof Draft, string>>;

/** Today on this device as YYYY-MM-DD, the same shape a date input holds. */
function todayIso(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function validate(draft: Draft): FieldErrors {
  const errors: FieldErrors = {};
  if (draft.fullName.trim() === '') errors.fullName = 'Ingresá tu nombre.';
  const email = draft.email.trim();
  if (email !== '' && !EMAIL_PATTERN.test(email)) {
    errors.email = 'Ingresá un email válido, por ejemplo nombre@dominio.cl';
  }
  // The server refuses it too; caught here so the message lands on the field.
  if (draft.birthDate !== '' && draft.birthDate > todayIso()) {
    errors.birthDate = 'Ingresá una fecha de nacimiento que ya haya pasado.';
  }
  return errors;
}

/** Where a refused save belongs on screen. */
function failureFor(err: unknown): { field?: keyof Draft; message: string } {
  if (err instanceof ApiError && err.code === 'CUSTOMER_EMAIL_TAKEN') {
    return { field: 'email', message: 'Ese email ya lo usa otra persona en este club.' };
  }
  if (err instanceof ApiError && err.code === 'AUTH_SCOPE_MISSING') {
    return { message: 'Para editar tus datos, cerrá sesión y volvé a entrar.' };
  }
  return { message: 'No pudimos guardar los cambios. Intentá de nuevo.' };
}

export function PersonalData({ profile, onSaved }: PersonalDataProps) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const editRef = useRef<HTMLButtonElement>(null);
  const editing = draft !== null;

  // Focus follows the mode: into the form when it opens, back to "Editar" when it closes.
  const wasEditing = useRef(false);
  useEffect(() => {
    if (editing) nameRef.current?.focus();
    else if (wasEditing.current) editRef.current?.focus();
    wasEditing.current = editing;
  }, [editing]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast]);

  function open() {
    setDraft(draftFrom(profile));
    setErrors({});
    setFormError(null);
  }

  function close() {
    setDraft(null);
    setErrors({});
    setFormError(null);
  }

  function update(field: keyof Draft, value: string) {
    setDraft((current) => (current ? { ...current, [field]: value } : current));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft || saving) return;

    const found = validate(draft);
    setErrors(found);
    setFormError(null);
    if (Object.keys(found).length > 0) return;

    const patch = changesBetween(draftFrom(profile), draft);
    if (Object.keys(patch).length === 0) {
      close();
      return;
    }

    setSaving(true);
    try {
      const saved = await api.updateProfile(patch);
      onSaved(saved);
      close();
      setToast('Cambios guardados');
    } catch (err) {
      // The draft stays as typed; only the server's answer moves the list.
      const failure = failureFor(err);
      if (failure.field) setErrors({ [failure.field]: failure.message });
      else setFormError(failure.message);
    } finally {
      setSaving(false);
    }
  }

  const rows: { label: string; value: string }[] = [];
  if (profile.fullName) rows.push({ label: 'Nombre', value: profile.fullName });
  if (profile.phone) rows.push({ label: 'Teléfono', value: profile.phone });
  if (profile.email) rows.push({ label: 'Correo', value: profile.email });
  const birthday = profile.birthDate ? formatBirthday(profile.birthDate) : null;
  if (birthday) rows.push({ label: 'Cumpleaños', value: birthday });

  return (
    <section className="club-personal-data" aria-labelledby="club-personal-data-title">
      <div className="club-personal-data__header">
        <h2 className="club-personal-data__title" id="club-personal-data-title">
          Tus datos
        </h2>
        {editing ? null : (
          <button ref={editRef} type="button" className="btn btn--outline club-personal-data__edit" onClick={open}>
            Editar
          </button>
        )}
      </div>

      {draft ? (
        <form className="club-personal-data__form" onSubmit={submit} noValidate>
          <FormField
            id="profile-fullName"
            name="fullName"
            label="Nombre"
            type="text"
            autoComplete="name"
            value={draft.fullName}
            onChange={(event) => update('fullName', event.target.value)}
            error={errors.fullName}
            required
            inputRef={nameRef}
          />
          <FormField
            id="profile-email"
            name="email"
            label="Correo"
            type="email"
            inputMode="email"
            autoComplete="email"
            value={draft.email}
            onChange={(event) => update('email', event.target.value)}
            error={errors.email}
          />
          <FormField
            id="profile-birthDate"
            name="birthDate"
            label="Fecha de nacimiento"
            type="date"
            autoComplete="bday"
            max={todayIso()}
            value={draft.birthDate}
            onChange={(event) => update('birthDate', event.target.value)}
            error={errors.birthDate}
          />
          <p className="club-personal-data__note">Para cambiar tu teléfono, pedilo en el local.</p>
          {formError ? (
            <p className="error-text" role="alert">
              {formError}
            </p>
          ) : null}
          <div className="club-personal-data__actions">
            <button type="submit" className="btn btn--primary" disabled={saving}>
              Guardar cambios
            </button>
            <button type="button" className="btn btn--outline" onClick={close} disabled={saving}>
              Cancelar
            </button>
          </div>
        </form>
      ) : (
        <dl className="club-personal-data__list">
          {rows.map((row) => (
            <div key={row.label} className="club-personal-data__row">
              <dt>{row.label}</dt>
              <dd>{row.value}</dd>
            </div>
          ))}
        </dl>
      )}

      <p className="club-personal-data__toast" role="status">
        {toast}
      </p>
    </section>
  );
}
