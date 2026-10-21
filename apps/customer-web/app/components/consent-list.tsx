const consentOptions = [
  {
    name: 'serviceWhatsapp',
    label: 'Mensajes de servicio por WhatsApp',
    description: 'Avisos importantes sobre tu cuenta y tu programa.',
  },
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

export function ConsentList() {
  return (
    <fieldset className="club-consent" disabled>
      <legend className="club-consent__title">Comunicaciones</legend>
      <p className="club-consent__intro">
        Estos controles todavía no están disponibles. No se guardan como consentimientos.
      </p>
      <div className="club-consent__rows">
        {consentOptions.map((option) => {
          const descriptionId = `${option.name}-description`;

          return (
            <label className="club-consent__row" key={option.name}>
              <input
                type="checkbox"
                name={option.name}
                checked={false}
                readOnly
                disabled
                aria-describedby={descriptionId}
              />
              <span className="club-consent__copy">
                <span className="club-consent__label">{option.label}</span>
                <span className="club-consent__description" id={descriptionId}>
                  {option.description}
                </span>
              </span>
              <span className="club-consent__state">No disponible todavía · Desactivado</span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
