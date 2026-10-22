'use client';

import { useParams, useRouter } from 'next/navigation';
import { useState, useEffect, useCallback } from 'react';

import { api, type PushCampaignDetail, type PushCampaignPayload } from '@/lib/api';

function showToast(type: 'success' | 'error' | 'info', message: string) {
  const event = new CustomEvent('dashboard-toast', { detail: { type, message } });
  window.dispatchEvent(event);
}

export default function CampaignDetailPage() {
  const router = useRouter();
  const params = useParams();
  const referenceId = params.referenceId as string;

  const [campaign, setCampaign] = useState<PushCampaignDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error] = useState<string | null>(null);
  const [resending, setResending] = useState(false);
  const [showResendConfirm, setShowResendConfirm] = useState(false);
  const [toast] = useState<{ type: 'success' | 'error' | 'info'; message: string } | null>(null);

  const loadCampaign = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.getPushCampaignDetail(referenceId);
      setCampaign(data);
    } catch (e) {
      showToast('error', e instanceof Error ? e.message : 'Error al cargar campaña');
    } finally {
      setLoading(false);
    }
  }, [referenceId]);

   
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadCampaign();
  }, [loadCampaign]);

  const handleResend = async () => {
    if (!campaign) return;
    setResending(true);
    try {
      const payload: PushCampaignPayload = {
        title: campaign.title,
        body: campaign.body,
        ...(campaign.url ? { url: campaign.url } : {}),
        reference_id: campaign.reference_id,
        target: campaign.target,
      };
      await api.composePushCampaign(payload);
      showToast('success', 'Campaña reenviada');
      setShowResendConfirm(false);
      const updated = await api.getPushCampaignDetail(referenceId);
      setCampaign(updated);
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Error al reenviar');
    } finally {
      setResending(false);
    }
  };

  const formatDate = (dateStr: string) => {
    try {
      const date = new Date(dateStr);
      return date.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    } catch {
      return dateStr;
    }
  };

  if (loading) return <div className="text-center text-muted" style={{ padding: '4rem' }}>Cargando…</div>;
  if (error || !campaign) return <div className="text-center" style={{ padding: '4rem' }}><p style={{ color: '#ef4444' }}>{error || 'Campaña no encontrada'}</p><button className="btn btn-secondary" onClick={() => router.push('/dashboard/communication/campaigns')}>Volver</button></div>;

  return (
    <div className="page fade-in">
      <button className="btn-back" onClick={() => router.push('/dashboard/communication/campaigns')}>
        Volver
      </button>

      <div className="card" style={{ marginBottom: '1.5rem' }}>
        <div className="dash-header" style={{ marginBottom: '1rem' }}>
          <div>
            <h1 className="dash-title">{campaign.title}</h1>
            <p className="dash-subtitle">Referencia: <code>{campaign.reference_id}</code> · {formatDate(campaign.created_at)}</p>
          </div>
        </div>

        <div className="card-body">
          <div style={{ marginBottom: '1rem' }}>
            <label className="text-sm text-muted">Cuerpo</label>
            <p style={{ whiteSpace: 'pre-wrap' }}>{campaign.body}</p>
          </div>
          {campaign.url && (
            <div style={{ marginBottom: '1rem' }}>
              <label className="text-sm text-muted">Link</label>
              <a href={campaign.url} target="_blank" rel="noopener noreferrer" className="text-sm">{campaign.url}</a>
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '1rem', marginBottom: '1.5rem' }}>
            <div className="tier-stat">
              <span className="tier-stat-label">Objetivo</span>
              <span className="tier-stat-value">{campaign.target_type === 'branch' ? 'Sede única' : 'Radio'}</span>
            </div>
            <div className="tier-stat">
              <span className="tier-stat-label">Audiencia</span>
              <span className="tier-stat-value">{campaign.audience_size.toLocaleString()}</span>
            </div>
            <div className="tier-stat">
              <span className="tier-stat-label">Entregados</span>
              <span className="tier-stat-value" style={{ color: '#16a34a' }}>{campaign.delivered.toLocaleString()}</span>
            </div>
            <div className="tier-stat">
              <span className="tier-stat-label">Fallidos</span>
              <span className="tier-stat-value" style={{ color: '#dc2626' }}>{campaign.failed.toLocaleString()}</span>
            </div>
            <div className="tier-stat">
              <span className="tier-stat-label">Omitidos</span>
              <span className="tier-stat-value" style={{ color: '#f59e0b' }}>{campaign.skipped.toLocaleString()}</span>
            </div>
          </div>

          {campaign.target_type === 'radius' && campaign.target && 'latitude' in campaign.target && (
            <div style={{ marginBottom: '1rem', padding: '1rem', background: '#f9fafb', borderRadius: '6px' }}>
              <p className="text-sm text-muted">Centro: {campaign.target.latitude}, {campaign.target.longitude} · Radio: {campaign.target.radius_m} m</p>
            </div>
          )}

          {campaign.target_type === 'branch' && campaign.target && 'branch_id' in campaign.target && (
            <div style={{ marginBottom: '1rem', padding: '1rem', background: '#f9fafb', borderRadius: '6px' }}>
              <p className="text-sm text-muted">Sede: {campaign.target.branch_id}</p>
            </div>
          )}

          {campaign.per_branch && campaign.per_branch.length > 0 && (
            <div>
              <h3 style={{ marginBottom: '0.5rem' }}>Desglose por sede</h3>
              <div className="card">
                <div className="table-container">
                  <table className="data-table">
                    <thead><tr><th>Sede</th><th>Distancia</th><th>Entregados</th><th>Fallidos</th></tr></thead>
                    <tbody>
                      {campaign.per_branch.map((b) => (
                        <tr key={b.branch_id}>
                          <td>{b.name}</td>
                          <td className="text-muted">{Math.round(b.distance_m)} m</td>
                          <td style={{ color: '#16a34a' }}>{b.delivered}</td>
                          <td style={{ color: '#dc2626' }}>{b.failed}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem' }}>
            <button className="btn btn-secondary" onClick={() => router.push('/dashboard/communication/campaigns')}>Volver</button>
            <button className="btn btn-primary" onClick={() => setShowResendConfirm(true)}>Reenviar</button>
          </div>
        </div>
      </div>

      {showResendConfirm && (
        <div className="modal-overlay" onClick={() => setShowResendConfirm(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Reenviar campaña</h3>
              <button className="modal-close" onClick={() => setShowResendConfirm(false)}>&times;</button>
            </div>
            <div className="modal-body">
              <p>Esto volverá a enviar la misma campaña. Los destinatarios que ya la recibieron no la recibirán de nuevo (idempotencia por reference_id).</p>
              <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem', justifyContent: 'flex-end' }}>
                <button className="btn btn-secondary" onClick={() => setShowResendConfirm(false)}>Cancelar</button>
                <button className="btn btn-primary" onClick={handleResend} disabled={resending}>{resending ? 'Reenviando…' : 'Reenviar'}</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div className="toast-container" style={{ position: 'fixed', bottom: '1.5rem', right: '1.5rem', zIndex: 1000, display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          <div className={`toast toast-${toast.type}`}>{toast.message}</div>
        </div>
      )}
    </div>
  );
}
