'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

import { ClubShell } from '../components/club-shell';
import { ClubError, ClubStatus } from '../components/club-status';
import { ConsentList } from '../components/consent-list';
import { IdentityCard } from '../components/identity-card';
import { MemberPass } from '../components/member-pass';
import { PersonalData } from '../components/personal-data';
import { PurchaseTimeline } from '../components/purchase-timeline';
import { WalletCard } from '../components/wallet-card';
import { api, type CustomerProfile } from '../lib/api';
import { useAuth } from '../lib/auth';

const ERROR_TITLE = 'No pudimos cargar tu pase';
const ERROR_DESCRIPTION =
  'Hubo un problema al traer tus datos. Podés reintentar; no modificamos nada en tu cuenta.';

export default function ProfilePage() {
  const router = useRouter();
  const { logout } = useAuth();
  const [profile, setProfile] = useState<CustomerProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
    load();
  }, [load]);

  if (loading) {
    return (
      <ClubShell>
        <ClubStatus variant="loading">
          <span>Cargando tu perfil…</span>
        </ClubStatus>
      </ClubShell>
    );
  }

  if (error || !profile) {
    return (
      <ClubShell>
        <ClubError title={ERROR_TITLE} description={ERROR_DESCRIPTION} action={
          <button className="btn btn-primary" onClick={load}>Reintentar</button>
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
        <WalletCard />
        <ConsentList />
        <button
          type="button"
          className="club-profile__logout"
          onClick={() => {
            logout();
            router.push('/login');
          }}
        >
          Cerrar sesión
        </button>
      </div>
    </ClubShell>
  );
}
