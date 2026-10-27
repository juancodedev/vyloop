'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';

import { ClubShell } from '../components/club-shell';
import { ClubError, ClubStatus } from '../components/club-status';
import { ConsentList } from '../components/consent-list';
import { IdentityCard } from '../components/identity-card';
import { MemberPass } from '../components/member-pass';
import { PersonalData } from '../components/personal-data';
import { PurchaseTimeline } from '../components/purchase-timeline';
import { QrDock } from '../components/qr-dock';
import { WalletCard } from '../components/wallet-card';
import { api, type CustomerProfile } from '../lib/api';
import { useAuth } from '../lib/auth';

const ERROR_TITLE = 'No pudimos cargar tu pase';
const ERROR_DESCRIPTION =
  'Hubo un problema al traer tus datos. Podés reintentar; no modificamos nada en tu cuenta.';

export default function ProfilePage() {
  const { push, replace } = useRouter();
  const { customer, isLoading: authLoading, logout } = useAuth();
  const signingOut = useRef(false);
  const [profile, setProfile] = useState<CustomerProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [memberCode, setMemberCode] = useState<string | null>(null);
  const handlePass = useCallback((pass: { member_code: string }) => setMemberCode(pass.member_code), []);

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
        <ClubStatus variant="loading">
          <span>Cargando tu pase</span>
        </ClubStatus>
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
        <IdentityCard profile={profile} />
        <MemberPass profile={profile} />
        <PurchaseTimeline profile={profile} />
        <PersonalData profile={profile} />
        <WalletCard onPass={handlePass} />
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
      </div>
      <QrDock globalId={profile.globalId} fullName={profile.fullName} memberCode={memberCode} />
    </ClubShell>
  );
}
