import { QrCode, ScanLine, UserPlus } from 'lucide-react';

const steps = [
  {
    number: '01',
    title: 'Escaneá el QR',
    description: 'En el mostrador de tu local.',
    icon: QrCode,
  },
  {
    number: '02',
    title: 'Creá tu cuenta',
    description: 'Desde el teléfono.',
    icon: UserPlus,
  },
  {
    number: '03',
    title: 'Mostrá tu código',
    description: 'Para seguir con tu programa.',
    icon: ScanLine,
  },
] as const;

export function ClubQrExplainer() {
  return (
    <section className="club-qr-explainer" aria-labelledby="club-qr-explainer-title">
      <div className="club-qr-explainer__heading">
        <h2 id="club-qr-explainer-title">Así empieza tu club</h2>
        <p>Todo pasa en el mostrador, en tres pasos.</p>
      </div>

      <div className="club-qr-explainer__stamp" aria-hidden="true">
        <QrCode size={48} strokeWidth={1.75} />
        <span>En el mostrador</span>
      </div>

      <ol className="club-qr-explainer__steps">
        {steps.map((step) => {
          const Icon = step.icon;

          return (
            <li key={step.number} className="club-qr-explainer__step">
              <span className="club-qr-explainer__step-number" aria-hidden="true">
                {step.number}
              </span>
              <span className="club-qr-explainer__step-copy">
                <strong>{step.title}</strong>
                <span>{step.description}</span>
              </span>
              <Icon
                className="club-qr-explainer__step-icon"
                size={22}
                strokeWidth={1.75}
                aria-hidden="true"
              />
            </li>
          );
        })}
      </ol>

      <p className="club-qr-explainer__note">No necesitás descargar una aplicación para empezar.</p>
    </section>
  );
}
