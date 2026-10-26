import type { CustomerProfile } from '../lib/api';

interface PersonalDataProps {
  profile: CustomerProfile;
}

export function PersonalData({ profile }: PersonalDataProps) {
  const rows: { label: string; value: string }[] = [];
  if (profile.phone) rows.push({ label: 'Teléfono', value: profile.phone });
  if (profile.email) rows.push({ label: 'Correo', value: profile.email });
  if (profile.birthDate) {
    const d = new Date(profile.birthDate);
    if (!Number.isNaN(d.getTime())) {
      rows.push({ label: 'Cumpleaños', value: `${d.getDate()} de ${d.toLocaleString('es-CL', { month: 'long' })}` });
    }
  }

  if (rows.length === 0) return null;

  return (
    <section className="club-personal-data" aria-label="Tus datos">
      <h3 className="club-personal-data__title">Tus datos</h3>
      <dl className="club-personal-data__list">
        {rows.map((row) => (
          <div key={row.label} className="club-personal-data__row">
            <dt>{row.label}</dt>
            <dd>{row.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
