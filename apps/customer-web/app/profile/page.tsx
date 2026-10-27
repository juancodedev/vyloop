'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';

import { ClubShell } from '../components/club-shell';
import { ClubError, ClubStatus } from '../components/club-status';
import { ConsentList } from '../components/consent-list';
import { DeleteAccount } from '../components/delete-account';
import { IdentityCard } from '../components/identity-card';
import { NextRedemptionCard } from '../components/next-redemption-card';
import { mergeSavedFields, PersonalData } from '../components/personal-data';
import { ProfileTopBar } from '../components/profile-top-bar';
import { PurchaseTimeline } from '../components/purchase-timeline';
import { QrDock } from '../components/qr-dock';
import { WalletCard } from '../components/wallet-card';
import { api, type CustomerProfile, type ProfileFields } from '../lib/api';
import { useAuth } from '../lib/auth';

const ERROR_TITLE = 'No pudimos cargar tu pase';
const ERROR_DESCRIPTION =
  'Hubo un problema al traer tus datos. Podés reintentar; no modificamos nada en tu cuenta.';

/**
 * The shape of the page while it loads: the identity card, the redemption card
 * and three purchase rows. No spinner; the status text is for screen readers.
 */
function ProfileSkeleton() {
  return (
    <ClubStatus variant="loading">
      <span className="club-sr-only">Cargando tu pase</span>
      <div className="club-profile club-profile--skeleton" aria-hidden="true">
        <div className="club-skeleton club-skeleton--identity" />
        <div className="club-skeleton club-skeleton--redemption" />
        <div className="club-skeleton club-skeleton--row" />
        <div className="club-skeleton club-skeleton--row" />
        <div className="club-skeleton club-skeleton--row" />
      </div>
    </ClubStatus>
  );
}

export default function ProfilePage() {
  const { push, replace } = useRouter();
  const { customer, isLoading: authLoading, logout } = useAuth();
  const signingOut = useRef(false);
  const [profile, setProfile] = useState<CustomerProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [memberCode, setMemberCode] = useState<string | null>(null);
  const handlePass = useCallback((pass: { member_code: string }) => setMemberCode(pass.member_code), []);
  // The server's answer to a save, merged into the profile the page shows.
  const handleSaved = useCallback((fields: ProfileFields) => {
    setProfile((current) => (current ? mergeSavedFields(current, fields) : current));
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.getProfile();
      setProfile(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error desconocido');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (authLoading) return;
    if (!customer) {
      if (!signingOut.current) replace('/login');
      return;
    }

    let cancelled = false;
    void Promise.resolve().then(() => {
      if (!cancelled) load();
    });

    return () => {
      cancelled = true;
    };
  }, [authLoading, customer, load, replace]);

  if (authLoading || (customer && loading)) {
    return (
      <ClubShell>
        <ProfileSkeleton />
      </ClubShell>
    );
  }

  if (!customer) return null;

  if (error || !profile) {
    return (
      <ClubShell>
        <ClubError title={ERROR_TITLE} description={ERROR_DESCRIPTION} action={
          <button className="btn btn--primary" onClick={load}>Reintentar</button>
        } />
      </ClubShell>
    );
  }

  return (
    <ClubShell>
      <div className="club-profile">
        <ProfileTopBar business={profile.business} />
        <IdentityCard profile={profile} />
        <NextRedemptionCard profile={profile} />
        <PurchaseTimeline profile={profile} />
        <WalletCard onPass={handlePass} />
        <PersonalData profile={profile} onSaved={handleSaved} />
        <ConsentList />
        <button
          type="button"
          className="club-profile__logout"
          onClick={() => {
            signingOut.current = true;
            logout();
            push('/');
          }}
        >
          Cerrar sesión
        </button>
        <DeleteAccount
          points={profile.points}
          pointsCurrency={profile.program?.pointsCurrency ?? null}
          onDeleted={() => {
            signingOut.current = true;
            logout();
            push('/');
          }}
        />
      </div>
      <QrDock globalId={profile.globalId} fullName={profile.fullName} memberCode={memberCode} />
    </ClubShell>
  );
}
