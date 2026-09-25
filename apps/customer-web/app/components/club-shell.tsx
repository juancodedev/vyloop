import Link from 'next/link';
import type { ReactNode } from 'react';

interface ClubShellProps {
  children: ReactNode;
  backLink?: {
    href: string;
    label: string;
  };
  className?: string;
  header?: ReactNode;
}

export function ClubShell({ children, backLink, className, header }: ClubShellProps) {
  const shellClassName = className ? `club-shell ${className}` : 'club-shell';

  return (
    <main className={shellClassName}>
      <div className="club-shell__frame">
        {backLink ? (
          <Link className="club-back-link" href={backLink.href}>
            <span aria-hidden="true">←</span> {backLink.label}
          </Link>
        ) : null}

        {header ? <header className="club-shell__header">{header}</header> : null}
        {children}
      </div>
    </main>
  );
}
