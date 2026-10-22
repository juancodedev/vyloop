import { useEffect, useState } from 'react';

import { api } from '../lib/api';

const consentOptions = [
  {
    name: 'promotions',
    label: 'Promociones y novedades',
    description: 'Ofertas y novedades que el commerce quiera compartirte.',
  },
  {
    name: 'nearbyNotifications',
    label: 'Avisos cercanos',
    // Q2 of `branch-reward-trigger`: this consent also carries the push that
    // says a reward can be redeemed somewhere, so the copy has to say so. A
    // consent that only mentions proximity does not cover the reward message.
    description:
      'Información sobre lugares y momentos cercanos, y avisos cuando tenés una recompensa para canjear.',
  },
] as const;

interface ConsentState {
  [key: string]: boolean;
}

export function ConsentList() {
  const [consents, setConsents] = useState<ConsentState>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);

  useEffect(() => {
    const loadConsents = async () => {
      try {
        const data = await api.getCustomerConsents();
        setConsents(data.consents || {});
      } catch (e) {
        console.error('Failed to load consents', e);
      } finally {
        setLoading(false);
      }
    };
    loadConsents();
  }, []);

  const handleChange = async (name: string, granted: boolean) => {
    setSaving(name);
    try {
      await api.updateCustomerConsent({ consentType: name, granted });
      setConsents((prev) => ({ ...prev, [name]: granted }));
    } catch (e) {
      console.error('Failed to update consent', e);
      setConsents((prev) => ({ ...prev, [name]: !granted }));
    } finally {
      setSaving(null);
    }
  };

  if (loading) {
    return (
      <fieldset className="club-consent">
        <legend className="club-consent__title">Comunicaciones</legend>
        <p className="club-consent__intro">Cargando preferencias…</p>
      </fieldset>
    );
  }

  return (
    <fieldset className="club-consent">
      <legend className="club-consent__title">Comunicaciones</legend>
      <div className="club-consent__rows">
        {consentOptions.map((option) => {
          const descriptionId = `${option.name}-description`;
          const checked = consents[option.name] ?? false;

          return (
            <label className="club-consent__row" key={option.name}>
              <input
                type="checkbox"
                name={option.name}
                checked={checked}
                onChange={(e) => handleChange(option.name, e.target.checked)}
                disabled={saving === option.name}
                aria-describedby={descriptionId}
              />
              <span className="club-consent__copy">
                <span className="club-consent__label">{option.label}</span>
                <span className="club-consent__description" id={descriptionId}>
                  {option.description}
                </span>
              </span>
              <span className="club-consent__state">
                {saving === option.name ? 'Guardando…' : checked ? 'Activado' : 'Desactivado'}
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}