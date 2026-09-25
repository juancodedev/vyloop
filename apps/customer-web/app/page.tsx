'use client';

import { ArrowRight } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect } from 'react';

import { ClubQrExplainer } from './components/club-qr-explainer';
import { ClubShell } from './components/club-shell';
import { ClubLoading } from './components/club-status';
import { useAuth } from './lib/auth';

function EntryLoading() {
  return (
    <ClubShell className="club-entry-shell">
      <div className="club-entry-loading">
        <ClubLoading />
      </div>
    </ClubShell>
  );
}

function buildBusinessHref(pathname: string, businessSlug: string | null) {
  if (!businessSlug) return pathname;

  const searchParams = new URLSearchParams();
  searchParams.set('biz', businessSlug);
  return `${pathname}?${searchParams.toString()}`;
}

function HomeEntry() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { customer, isLoading } = useAuth();
  const businessSlug = searchParams.get('biz');
  const loginHref = buildBusinessHref('/login', businessSlug);
  const registerHref = buildBusinessHref('/register', businessSlug);
  // Registration needs a tenant: the page refuses to create a customer without
  // one, so offering the action here without a `biz` parameter would send the
  // visitor to a screen that can only tell them to go back. Login has no such
  // requirement, so it stays available either way.
  const canRegister = businessSlug !== null;

  useEffect(() => {
    if (!isLoading && customer) {
      router.replace('/profile');
    }
  }, [isLoading, customer, router]);

  if (isLoading) return <EntryLoading />;
  if (customer) return null;

  return (
    <ClubShell className="club-entry-shell">
      <div className="club-entry">
        <section className="club-entry__copy" aria-labelledby="club-entry-title">
          <p className="club-entry__eyebrow">Fidelización sin instalar nada</p>
          <h1 id="club-entry-title" className="club-entry__title">
            <span>Tu local de siempre,</span> <span>con un motivo para volver.</span>
          </h1>
          <p className="club-entry__summary">
            Acumulá progreso, revisá las recompensas de tu programa y volvé a tu local de siempre.
          </p>

          <nav className="club-entry__actions" aria-label="Acciones para entrar al club">
            <Link href={loginHref} className="btn btn--primary club-entry__action">
              <span>Ingresar</span>
              <ArrowRight className="club-entry__action-arrow" size={18} aria-hidden="true" />
            </Link>
            {canRegister ? (
              <Link href={registerHref} className="btn btn--outline club-entry__action">
                Registrarme
              </Link>
            ) : null}
          </nav>
        </section>

        <ClubQrExplainer />
      </div>
    </ClubShell>
  );
}

export default function Home() {
  return (
    <Suspense fallback={<EntryLoading />}>
      <HomeEntry />
    </Suspense>
  );
}
