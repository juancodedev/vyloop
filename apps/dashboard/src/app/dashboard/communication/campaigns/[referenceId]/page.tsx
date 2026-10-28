'use client';

import { useParams, useRouter } from 'next/navigation';
import { useState, useEffect, useCallback } from 'react';

import { api, type PushCampaignDetail } from '@/lib/api';
import { describeDeliveryFailure } from '@/lib/delivery-failure';

function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString('es-CL', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Where the campaign went, in words: a branch by name, or a radius. */
function describeTarget(campaign: PushCampaignDetail): string {
  if (campaign.target_type === 'branch') {
    return campaign.branch_name
      ? `Clientes de ${campaign.branch_name}`
      : 'Clientes de una sucursal que ya no existe';
  }
  const target = campaign.target as { radius_m?: number };
  const radius = target.radius_m ?? 0;
  const distance =
    radius >= 1000
      ? `${(radius / 1000).toLocaleString('es-CL', { maximumFractionDigits: 1 })} km`
      : `${radius.toLocaleString('es-CL')} m`;
  return `Clientes a menos de ${distance} de un punto del mapa`;
}

export default function CampaignDetailPage() {
  const router = useRouter();
  const params = useParams();
  const referenceId = params.referenceId as string;

  const [campaign, setCampaign] = useState<PushCampaignDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [failedToLoad, setFailedToLoad] = useState(false);

  const loadCampaign = useCallback(async () => {
    setLoading(true);
    setFailedToLoad(false);
    try {
      setCampaign(await api.getPushCampaignDetail(referenceId));
    } catch {
      setFailedToLoad(true);
    } finally {
      setLoading(false);
    }
  }, [referenceId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadCampaign();
  }, [loadCampaign]);

  const back = () => router.push('/dashboard/communication/campaigns');

  if (loading) {
    return (
      <div className="text-center text-muted" style={{ padding: '4rem' }}>
        Cargando…
      </div>
    );
  }

  if (failedToLoad || !campaign) {
    return (
      <div className="empty-state">
        <p>No pudimos cargar esta campaña.</p>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button className="btn btn-secondary" onClick={back}>
            Volver
          </button>
          <button className="btn btn-primary" onClick={loadCampaign}>
            Reintentar
          </button>
        </div>
      </div>
    );
  }

  const stats = [
    { label: 'Clientes en la audiencia', value: campaign.audience_size },
    { label: 'Enviadas', value: campaign.delivered },
    { label: 'Fallidas', value: campaign.failed },
    { label: 'En cola', value: campaign.pending },
  ];

  return (
    <div className="page fade-in">
      <button className="btn-back" onClick={back}>
        Volver
      </button>

      <div className="card" style={{ marginBottom: '1.5rem' }}>
        <div className="card-body">
          <div className="dash-header" style={{ marginBottom: '1rem' }}>
            <div>
              <h1 className="dash-title">{campaign.title}</h1>
              <p className="dash-subtitle">
                Enviada el {formatDateTime(campaign.created_at)} · {describeTarget(campaign)}
              </p>
            </div>
          </div>

          <p style={{ whiteSpace: 'pre-wrap', marginBottom: '1rem' }}>{campaign.body}</p>
          {campaign.url && (
            <p className="text-sm" style={{ marginBottom: '1rem' }}>
              Al tocarla abre{' '}
              <a href={campaign.url} target="_blank" rel="noopener noreferrer">
                {campaign.url}
              </a>
            </p>
          )}

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
              gap: '1rem',
            }}
          >
            {stats.map((stat) => (
              <div key={stat.label} className="tier-stat">
                <span className="tier-stat-label">{stat.label}</span>
                <span className="tier-stat-value">{stat.value.toLocaleString('es-CL')}</span>
              </div>
            ))}
          </div>
          <p className="text-sm text-muted" style={{ marginTop: '0.75rem' }}>
            Se cuentan las notificaciones al navegador: un cliente con dos dispositivos recibe dos.
            Los clientes que no aceptaron notificaciones no reciben ninguna.
          </p>
        </div>
      </div>

      {campaign.failures.length > 0 && (
        <div className="card">
          <div className="card-header">
            <h3>Por qué fallaron</h3>
          </div>
          <div className="table-container">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Cliente</th>
                  <th>Motivo</th>
                  <th>Fecha</th>
                </tr>
              </thead>
              <tbody>
                {campaign.failures.map((failure, i) => (
                  <tr key={`${failure.created_at}-${i}`}>
                    <td style={{ fontWeight: 500 }}>
                      {failure.customer_name ?? (
                        <span className="text-muted">Cliente no disponible</span>
                      )}
                    </td>
                    <td className="text-sm">{describeDeliveryFailure({ error: failure.error })}</td>
                    <td className="text-sm text-muted">{formatDateTime(failure.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
