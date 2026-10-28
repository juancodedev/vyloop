'use client';

import { useRouter } from 'next/navigation';
import { useState, useEffect, useCallback } from 'react';

import { api, type PushCampaignPayload, type PushCampaignPreview, type BranchView } from '@/lib/api';

// ---------------------------------------------------------------------------
// Composer Page
// ---------------------------------------------------------------------------

export default function CampaignComposerPage() {
  const router = useRouter();

  // Form state
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [url, setUrl] = useState('');
  const [referenceId, setReferenceId] = useState('');
  const [targetType, setTargetType] = useState<'branch' | 'radius'>('branch');
  const [branchId, setBranchId] = useState('');
  const [latitude, setLatitude] = useState('');
  const [longitude, setLongitude] = useState('');
  const [radiusMeters, setRadiusMeters] = useState(1000);

  // Venue data for dropdown
  const [venues, setVenues] = useState<BranchView[]>([]);
  const [loadingVenues, setLoadingVenues] = useState(false);

  // Preview state
  const [preview, setPreview] = useState<PushCampaignPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);

  // Submit state
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  // Load venues for dropdown
  const loadVenues = useCallback(async () => {
    setLoadingVenues(true);
    try {
      const { branches } = await api.getVenues({ includeInactive: false });
      // Filter for active + located venues
      const located = branches.filter(v => v.latitude !== null && v.longitude !== null && v.is_active);
      setVenues(located);
    } catch {
      showToast('error', 'Error al cargar sedes');
    } finally {
      setLoadingVenues(false);
    }
  }, []);

   
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadVenues();
  }, [loadVenues]);

  const validateForm = (): boolean => {
    const errors: Record<string, string> = {};

    if (!title.trim()) errors.title = 'El título es obligatorio';
    else if (title.length > 40) errors.title = 'El título no puede exceder 40 caracteres';

    if (!body.trim()) errors.body = 'El cuerpo es obligatorio';
    else if (body.length > 300) errors.body = 'El cuerpo no puede exceder 300 caracteres';

    if (url.trim() && !isValidUrl(url)) {
      errors.url = 'El link debe ser una URL válida';
    }

    if (targetType === 'branch') {
      if (!branchId) errors.branchId = 'Seleccioná una sede';
    } else {
      const lat = Number(latitude);
      const lng = Number(longitude);
      const radius = Number(radiusMeters);

      if (isNaN(lat) || lat < -90 || lat > 90) errors.latitude = 'Latitud inválida (-90 a 90)';
      if (isNaN(lng) || lng < -180 || lng > 180) errors.longitude = 'Longitud inválida (-180 a 180)';
      if (isNaN(radius) || radius < 1 || radius > 50000) errors.radiusMeters = 'Radio entre 1 y 50 000 metros';
    }

    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const buildPayload = (): PushCampaignPayload => {
    const payload: PushCampaignPayload = {
      title: title.trim(),
      body: body.trim(),
      target: targetType === 'branch'
        ? { branch_id: branchId }
        : { latitude: Number(latitude), longitude: Number(longitude), radius_m: Number(radiusMeters) },
    };
    if (url.trim()) payload.url = url.trim();
    if (referenceId.trim()) payload.reference_id = referenceId.trim();
    return payload;
  };

  const isFormValid = () => {
    if (!title.trim() || !body.trim()) return false;
    if (title.length > 40 || body.length > 300) return false;
    if (url.trim() && !isValidUrl(url)) return false;
    if (targetType === 'branch') return !!branchId;
    const lat = Number(latitude), lng = Number(longitude), r = Number(radiusMeters);
    return !isNaN(lat) && lat >= -90 && lat <= 90 &&
           !isNaN(lng) && lng >= -180 && lng <= 180 &&
           !isNaN(r) && r >= 1 && r <= 50000;
  };

  const isValidUrl = (string: string) => {
    try {
      const url = new URL(string);
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
      return false;
    }
  };

  const handlePreview = async () => {
    if (!isFormValid()) return;
    setPreviewing(true);
    setPreview(null);
    setError(null);
    try {
      const data = await api.composePushCampaign({ ...buildPayload(), dry_run: true });
      setPreview(data);
      showToast('info', `Audiencia estimada: ${data.audience_size}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Error al previsualizar';
      setError(msg);
      showToast('error', msg);
    } finally {
      setPreviewing(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setFieldErrors({});

    if (!validateForm()) return;

    setSending(true);
    try {
      const data = await api.composePushCampaign(buildPayload());
      showToast('success', `Campaña enviada a ${data.audience_size} dispositivos`);
      router.push(`/dashboard/communication/campaigns/${data.reference_id}`);
    } catch {
      if (e instanceof Error && 'code' in e && typeof e.code === 'string') {
        setError(e.message);
      } else if (e instanceof Error) {
        setError(e.message);
      } else {
        setError('Error al enviar campaña');
      }
      showToast('error', 'Error al enviar campaña');
    } finally {
      setSending(false);
    }
  };

  const useMyLocation = () => {
    if (!navigator.geolocation) {
      showToast('error', 'Tu navegador no soporta geolocalización');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLatitude(String(pos.coords.latitude).replace(',', '.'));
        setLongitude(String(pos.coords.longitude).replace(',', '.'));
        showToast('success', 'Ubicación capturada');
      },
      (err) => showToast('error', 'No se pudo obtener la ubicación: ' + err.message),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
  };

  const isSecureContext = typeof window !== 'undefined' && (window.location.protocol === 'https:' || window.location.hostname === 'localhost');

  return (
    <div className="page fade-in">
      <div className="dash-header">
        <div>
          <h1 className="dash-title">Nueva campaña push</h1>
          <p className="dash-subtitle">Componé un mensaje para clientes cercanos</p>
        </div>
        <div className="dash-actions">
          <button className="btn btn-secondary" onClick={() => router.push('/dashboard/communication/campaigns')} disabled={sending}>
            ← Volver
          </button>
        </div>
      </div>

      <div className="card" style={{ maxWidth: 800 }}>
        <div className="card-body">
          <form onSubmit={handleSubmit}>
            {error && <div className="toast toast-error" style={{ marginBottom: '1rem' }}>{error}</div>}

            <div className="form-group">
              <label htmlFor="title">Título <span className="text-muted">*</span></label>
              <input
                id="title"
                type="text"
                className="form-control"
                maxLength={40}
                value={title}
                onChange={(e) => { setTitle(e.target.value); if (fieldErrors.title) setFieldErrors(prev => ({ ...prev, title: '' })); }}
                disabled={sending}
                required
              />
              {fieldErrors.title && <p style={{ color: 'var(--error)', fontSize: '0.875rem', marginTop: '0.25rem' }}>{fieldErrors.title}</p>}
              <p className="text-sm text-muted">{title.length}/40 caracteres</p>
            </div>

            <div className="form-group">
              <label htmlFor="body">Cuerpo <span className="text-muted">*</span></label>
              <textarea
                id="body"
                className="form-control"
                maxLength={300}
                rows={4}
                value={body}
                onChange={(e) => { setBody(e.target.value); if (fieldErrors.body) setFieldErrors(prev => ({ ...prev, body: '' })); }}
                disabled={sending}
                required
              />
              {fieldErrors.body && <p style={{ color: 'var(--error)', fontSize: '0.875rem', marginTop: '0.25rem' }}>{fieldErrors.body}</p>}
              <p className="text-sm text-muted">{body.length}/300 caracteres</p>
            </div>

            <div className="form-group">
              <label htmlFor="url">Link (opcional)</label>
              <input
                id="url"
                type="url"
                className="form-control"
                placeholder="https://..."
                value={url}
                onChange={(e) => { setUrl(e.target.value); if (fieldErrors.url) setFieldErrors(prev => ({ ...prev, url: '' })); }}
                disabled={sending}
              />
              {fieldErrors.url && <p style={{ color: 'var(--error)', fontSize: '0.875rem', marginTop: '0.25rem' }}>{fieldErrors.url}</p>}
              <p className="text-sm text-muted">Debe ser una URL permitida (mismo origen que la app)</p>
            </div>

            <fieldset className="form-group" style={{ marginTop: '1.5rem', paddingTop: '1rem', borderTop: '1px solid var(--color-border)' }}>
              <legend className="form-label" style={{ fontWeight: 600, marginBottom: '1rem' }}>Objetivo</legend>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                <label style={{ display: 'flex', alignItems: 'flex-start', gap: '0.75rem', cursor: 'pointer' }}>
                  <input type="radio" name="target" value="branch" checked={targetType === 'branch'} onChange={() => { setTargetType('branch'); setPreview(null); }} />
                  <div>
                    <div style={{ fontWeight: 500 }}>Una sede</div>
                    <div className="text-sm text-muted">Seleccioná una sede con coordenadas registradas</div>
                  </div>
                </label>
                <label style={{ display: 'flex', alignItems: 'flex-start', gap: '0.75rem', cursor: 'pointer' }}>
                  <input type="radio" name="target" value="radius" checked={targetType === 'radius'} onChange={() => { setTargetType('radius'); setPreview(null); }} />
                  <div>
                    <div style={{ fontWeight: 500 }}>Radio alrededor de un punto</div>
                    <div className="text-sm text-muted">Coordenadas + radio en metros (máx 50 km)</div>
                  </div>
                </label>
              </div>

              {targetType === 'branch' && (
                <div className="form-group">
                  <label htmlFor="branch_id">Sede <span className="text-muted">*</span></label>
                  <select
                    id="branch_id"
                    className="form-control"
                    value={branchId}
                    onChange={(e) => { setBranchId(e.target.value); if (fieldErrors.branchId) setFieldErrors(prev => ({ ...prev, branchId: '' })); }}
                    disabled={loadingVenues || sending}
                  >
                    <option value="">Seleccioná una sede</option>
                    {venues.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.name} {v.latitude !== null && v.longitude !== null && `(${v.latitude.toFixed(4)}, ${v.longitude.toFixed(4)})`}
                      </option>
                    ))}
                  </select>
                  {loadingVenues && <p className="text-sm text-muted">Cargando sedes…</p>}
                  {fieldErrors.branchId && <p style={{ color: 'var(--error)', fontSize: '0.875rem', marginTop: '0.25rem' }}>{fieldErrors.branchId}</p>}
                </div>
              )}

              {targetType === 'radius' && (
                <>
                  <div className="form-group">
                    <label htmlFor="latitude">Latitud <span className="text-muted">*</span></label>
                    <div style={{ display: 'flex', gap: '0.5rem' }}>
                      <input
                        id="latitude"
                        type="number"
                        step="any"
                        min="-90"
                        max="90"
                        className="form-control"
                        placeholder="-34.6037"
                        value={latitude}
                        onChange={(e) => { setLatitude(e.target.value.replace(',', '.')); if (fieldErrors.latitude) setFieldErrors(prev => ({ ...prev, latitude: '' })); }}
                        disabled={sending}
                      />
                      {isSecureContext && (
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          onClick={useMyLocation}
                          disabled={sending}
                          style={{ height: '38px', alignSelf: 'flex-end' }}
                        >
                          <LocationIcon /> Usar mi ubicación
                        </button>
                      )}
                    </div>
                    {fieldErrors.latitude && <p style={{ color: 'var(--error)', fontSize: '0.875rem', marginTop: '0.25rem' }}>{fieldErrors.latitude}</p>}
                  </div>
                  <div className="form-group">
                    <label htmlFor="longitude">Longitud <span className="text-muted">*</span></label>
                    <input
                      id="longitude"
                      type="number"
                      step="any"
                      min="-180"
                      max="180"
                      className="form-control"
                      placeholder="-58.3816"
                      value={longitude}
                      onChange={(e) => { setLongitude(e.target.value.replace(',', '.')); if (fieldErrors.longitude) setFieldErrors(prev => ({ ...prev, longitude: '' })); }}
                      disabled={sending}
                    />
                    {fieldErrors.longitude && <p style={{ color: 'var(--error)', fontSize: '0.875rem', marginTop: '0.25rem' }}>{fieldErrors.longitude}</p>}
                  </div>
                  <div className="form-group">
                    <label htmlFor="radius_m">Radio (metros) <span className="text-muted">*</span></label>
                    <input
                      id="radius_m"
                      type="number"
                      min="1"
                      max="50000"
                      step="100"
                      className="form-control"
                      placeholder="1000"
                      value={radiusMeters}
                      onChange={(e) => { setRadiusMeters(Number(e.target.value)); if (fieldErrors.radiusMeters) setFieldErrors(prev => ({ ...prev, radiusMeters: '' })); }}
                      disabled={sending}
                    />
                    <p className="text-sm text-muted">Máximo 50 000 metros (50 km)</p>
                    {fieldErrors.radiusMeters && <p style={{ color: 'var(--error)', fontSize: '0.875rem', marginTop: '0.25rem' }}>{fieldErrors.radiusMeters}</p>}
                  </div>
                </>
              )}

              <div className="form-group">
                <label htmlFor="reference_id">Referencia (opcional)</label>
                <input
                  id="reference_id"
                  type="text"
                  className="form-control"
                  placeholder="Auto-generado si se deja vacío"
                  value={referenceId}
                  onChange={(e) => setReferenceId(e.target.value)}
                  disabled={sending}
                />
                <p className="text-sm text-muted">Clave de idempotencia: la misma referencia evita duplicados</p>
              </div>
            </fieldset>

            {preview && (
              <div className="toast toast-info" style={{ marginTop: '1rem', marginBottom: '1rem' }}>
                <strong>Audiencia estimada: {preview.audience_size}</strong>
                {preview.per_branch && (
                  <details style={{ marginTop: '0.5rem' }}>
                    <summary>Desglose por sede ({preview.per_branch.length})</summary>
                    <ul style={{ marginTop: '0.5rem', fontSize: '0.875rem' }}>
                      {preview.per_branch.map((b) => (
                        <li key={b.branch_id}>{b.name} — {Math.round(b.distance_m)} m</li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            )}

            <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1.5rem', justifyContent: 'flex-end' }}>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={handlePreview}
                disabled={previewing || sending || !isFormValid()}
              >
                {previewing ? <LoaderIcon /> : <EyeIcon />} Previsualizar audiencia
              </button>
              <button
                type="submit"
                className="btn btn-primary"
                disabled={sending || !isFormValid()}
              >
                {sending ? <LoaderIcon /> : <SendIcon />} Enviar campaña
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}



function showToast(type: 'success' | 'error' | 'info', message: string) {
  const event = new CustomEvent('dashboard-toast', { detail: { type, message } });
  window.dispatchEvent(event);
}

function LocationIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
      <circle cx="12" cy="10" r="3" />
    </svg>
  );
}

function EyeIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function SendIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="22" y1="2" x2="11" y2="13" />
      <polygon points="22 2 15 22 11 13 2 9 22 2" />
    </svg>
  );
}

function LoaderIcon({ className = 'w-4 h-4 animate-spin' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" strokeOpacity="0.25" />
      <path d="M12 2a10 10 0 0 1 10 10" strokeOpacity="1" />
    </svg>
  );
}