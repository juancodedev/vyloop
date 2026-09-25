import type { ReactNode } from 'react';

type ClubStatusVariant = 'loading' | 'error' | 'empty';

interface ClubStatusProps {
  children: ReactNode;
  variant: ClubStatusVariant;
}

interface ClubLoadingProps {
  label?: string;
}

interface ClubErrorProps {
  title: string;
  description: string;
  action?: ReactNode;
}

export function ClubStatus({ children, variant }: ClubStatusProps) {
  const isError = variant === 'error';
  const isLoading = variant === 'loading';

  return (
    <div
      className={`club-status club-status--${variant}`}
      role={isError ? 'alert' : 'status'}
      aria-live={isError ? 'assertive' : 'polite'}
      aria-atomic="true"
      aria-busy={isLoading || undefined}
    >
      {children}
    </div>
  );
}

export function ClubLoading({ label = 'Cargando…' }: ClubLoadingProps) {
  return (
    <ClubStatus variant="loading">
      <span className="club-status__indicator" aria-hidden="true" />
      <p className="club-status__description">{label}</p>
    </ClubStatus>
  );
}

export function ClubError({ title, description, action }: ClubErrorProps) {
  return (
    <ClubStatus variant="error">
      <p className="club-status__title">{title}</p>
      <p className="club-status__description">{description}</p>
      {action ? <div className="club-status__action">{action}</div> : null}
    </ClubStatus>
  );
}
