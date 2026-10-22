'use client';

import { useState, useEffect } from 'react';

import { type BranchView, type VenueFormData, locationErrorMessage } from '@/lib/api';

// ---------------------------------------------------------------------------
// Icons (inline SVG to avoid extra dependencies)
// ---------------------------------------------------------------------------

function _LocationIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
      <circle cx="12" cy="10" r="3" />
    </svg>
  );
}

function _CloseIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Toast context (reuses existing pattern from dashboard)
// ---------------------------------------------------------------------------

function _showToast(type: 'success' | 'error' | 'info', message: string) {
  const event = new CustomEvent('dashboard-toast', { detail: { type, message } });
  window.dispatchEvent(event);
}

// ---------------------------------------------------------------------------
// Venue Form Component
// ---------------------------------------------------------------------------

interface VenueFormProps {
  initialData: BranchView | null;
  onSubmit: (data: VenueFormData) => Promise<void>;
  onCancel: () => void;
  isSubmitting: boolean;
  _submitLabel: string;
}

export function VenueForm({ initialData, onSubmit, onCancel, isSubmitting, _submitLabel }: VenueFormProps) {
  const [form, setForm] = useState<{
    name: string;
    address: string;
    city: string;
    country: string;
    timezone: string;
    latitude: string;
    longitude: string;
    isActive: boolean;
  }>({
    name: '',
    address: '',
    city: '',
    country: 'AR',
    timezone: 'America/Argentina/Buenos_Aires',
    latitude: '',
    longitude: '',
    isActive: true,
  });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [globalError, setGlobalError] = useState<string | null>(null);

  // Initialize form from initialData
  useEffect(() => {
    if (initialData) {
      setForm({
        name: initialData.name,
        address: initialData.address ?? '',
        city: initialData.city ?? '',
        country: initialData.country,
        timezone: initialData.timezone ?? 'America/Argentina/Buenos_Aires',
        latitude: initialData.latitude !== null ? String(initialData.latitude) : '',
        longitude: initialData.longitude !== null ? String(initialData.longitude) : '',
        isActive: initialData.is_active,
      });
    } else {
      setForm({
        name: '',
        address: '',
        city: '',
        country: 'AR',
        timezone: 'America/Argentina/Buenos_Aires',
        latitude: '',
        longitude: '',
        isActive: true,
      });
    }
    setFieldErrors({});
    setGlobalError(null);
  }, [initialData]);

  // Show/hide location button based on secure context
  const _isSecureContext = typeof window !== 'undefined' && (window.location.protocol === 'https:' || window.location.hostname === 'localhost');

  const _handleChange = (key: string, value: string | boolean) => {
    setForm(prev => ({ ...prev, [key]: value }));
    if (fieldErrors[key]) setFieldErrors(prev => ({ ...prev, [key]: '' }));
  };

  const validateForm = (): boolean => {
    const errors: Record<string, string> = {};

    if (!form.name.trim()) errors.name = 'El nombre es obligatorio';
    if (!form.country.trim()) errors.country = 'El país es obligatorio';

    const lat = form.latitude.trim();
    const lng = form.longitude.trim();
    const hasLat = lat !== '';
    const hasLng = lng !== '';

    if (hasLat !== hasLng) {
      errors.latitude = 'Ambas coordenadas son obligatorias si se proporciona una';
      errors.longitude = 'Ambas coordenadas son obligatorias si se proporciona una';
    }

    if (hasLat) {
      const latNum = Number(lat);
      if (!Number.isFinite(latNum) || latNum < -90 || latNum > 90) {
        errors.latitude = 'Latitud debe estar entre -90 y 90';
      }
    }
    if (hasLng) {
      const lngNum = Number(lng);
      if (!Number.isFinite(lngNum) || lngNum < -180 || lngNum > 180) {
        errors.longitude = 'Longitud debe estar entre -180 y 180';
      }
    }

    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setGlobalError(null);
    setFieldErrors({});

    if (!validateForm()) return;

    const payload: VenueFormData = {
      name: form.name.trim(),
      address: form.address.trim() || null,
      city: form.city.trim() || null,
      country: form.country.trim(),
      timezone: form.timezone.trim() || null,
      latitude: form.latitude.trim() !== '' && form.longitude.trim() !== '' ? Number(form.latitude) : null,
      longitude: form.latitude.trim() !== '' && form.longitude.trim() !== '' ? Number(form.longitude) : null,
      isActive: form.isActive,
    };

    try {
      await onSubmit(payload);
    } catch (err) {
      if (err instanceof Error && 'code' in err && typeof err.code === 'string' && err.code in { BRANCH_LOCATION_INCOMPLETE: 1, BRANCH_LOCATION_INVALID: 1, BRANCH_LOCATION_OUT_OF_RANGE: 1 }) {
        const msg = locationErrorMessage(err.code as 'BRANCH_LOCATION_INCOMPLETE' | 'BRANCH_LOCATION_INVALID' | 'BRANCH_LOCATION_OUT_OF_RANGE');
        setFieldErrors({ latitude: msg, longitude: msg });
      } else if (err instanceof Error) {
        setGlobalError(err.message);
      } else {
        setGlobalError('Error al guardar la sede');
      }
    }
  };

  return (
    <div className="modal-overlay" onClick={onCancel} role="dialog" aria-modal="true" aria-labelledby="venue-form-title">
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3 id="venue-form-title">{initialData ? 'Editar sede' : 'Nueva sede'}</h3>
          <button className="modal-close" onClick={onCancel} disabled={isSubmitting} aria-label="Cerrar">
            <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="modal-body">
          <form onSubmit={handleSubmit}>
            {globalError && (
              <p style={{ color: '#ef4444', fontSize: '0.875rem', marginBottom: '1rem' }}>{globalError}</p>
            )}

            <div className="form-group">
              <label htmlFor="venue-name">Nombre <span className="text-muted">*</span></label>
              <input
                id="venue-name"
                type="text"
                className="form-control"
                autoComplete="name"
                value={form.name}
                onChange={(e) => _handleChange('name', e.target.value)}
                disabled={isSubmitting}
                required
              />
              {fieldErrors.name && <p style={{ color: '#ef4444', fontSize: '0.875rem', marginTop: '0.25rem' }}>{fieldErrors.name}</p>}
            </div>

            <div className="form-group">
              <label htmlFor="venue-address">Dirección</label>
              <input
                id="venue-address"
                type="text"
                className="form-control"
                autoComplete="street-address"
                value={form.address}
                onChange={(e) => _handleChange('address', e.target.value)}
                disabled={isSubmitting}
              />
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
              <div className="form-group">
                <label htmlFor="venue-city">Ciudad</label>
                <input
                  id="venue-city"
                  type="text"
                  className="form-control"
                  autoComplete="address-level2"
                  value={form.city}
                  onChange={(e) => _handleChange('city', e.target.value)}
                  disabled={isSubmitting}
                />
              </div>
              <div className="form-group">
                <label htmlFor="venue-country">País <span className="text-muted">*</span></label>
                <input
                  id="venue-country"
                  type="text"
                  className="form-control"
                  autoComplete="country"
                  value={form.country}
                  onChange={(e) => _handleChange('country', e.target.value)}
                  disabled={isSubmitting}
                  required
                />
              </div>
            </div>

            <div className="form-group">
              <label htmlFor="venue-timezone">Zona horaria</label>
              <input
                id="venue-timezone"
                type="text"
                className="form-control"
                placeholder="America/Argentina/Buenos_Aires"
                value={form.timezone}
                onChange={(e) => _handleChange('timezone', e.target.value)}
                disabled={isSubmitting}
              />
            </div>

            <div className="form-group">
              <label>Coordenadas</label>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
                <div className="form-group">
                  <label htmlFor="venue-lat">Latitud</label>
                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <input
                      id="venue-lat"
                      type="number"
                      step="0.000001"
                      min="-90"
                      max="90"
                      className="form-control"
                      placeholder="-34.6037"
                      value={form.latitude}
                      onChange={(e) => _handleChange('latitude', e.target.value)}
                      disabled={isSubmitting}
                    />
                    {typeof window !== 'undefined' && (window.location.protocol === 'https:' || window.location.hostname === 'localhost') && (
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={() => {
                          if (!navigator.geolocation) {
                            const event = new CustomEvent('dashboard-toast', { detail: { type: 'error', message: 'Tu navegador no soporta geolocalización' } });
                            window.dispatchEvent(event);
                            return;
                          }
                          navigator.geolocation.getCurrentPosition(
                            (pos) => {
                              setForm(prev => ({ ...prev, latitude: String(pos.coords.latitude), longitude: String(pos.coords.longitude) }));
                              const event = new CustomEvent('dashboard-toast', { detail: { type: 'success', message: 'Ubicación capturada' } });
                              window.dispatchEvent(event);
                            },
                            (err) => {
                              const event = new CustomEvent('dashboard-toast', { detail: { type: 'error', message: 'No se pudo obtener la ubicación: ' + err.message } });
                              window.dispatchEvent(event);
                            },
                            { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
                          );
                        }}
                        disabled={isSubmitting}
                        style={{ height: '38px', alignSelf: 'flex-end' }}
                      >
                        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
                          <circle cx="12" cy="10" r="3" />
                        </svg> Usar mi ubicación
                      </button>
                    )}
                  </div>
                  {fieldErrors.latitude && <p style={{ color: '#ef4444', fontSize: '0.875rem', marginTop: '0.25rem' }}>{fieldErrors.latitude}</p>}
                </div>
                <div className="form-group">
                  <label htmlFor="venue-lng">Longitud</label>
                  <input
                    id="venue-lng"
                    type="number"
                    step="0.000001"
                    min="-180"
                    max="180"
                    className="form-control"
                    placeholder="-58.3816"
                    value={form.longitude}
                    onChange={(e) => _handleChange('longitude', e.target.value)}
                    disabled={isSubmitting}
                  />
                  {fieldErrors.longitude && <p style={{ color: '#ef4444', fontSize: '0.875rem', marginTop: '0.25rem' }}>{fieldErrors.longitude}</p>}
                </div>
              </div>
              {form.latitude && form.longitude && (
                <p className="text-sm text-muted" style={{ marginTop: '0.5rem' }}>
                  Coordenadas actuales: <code>{Number(form.latitude).toFixed(6)}, {Number(form.longitude).toFixed(6)}</code>
                  {' '}
                  <button type="button" className="btn btn-secondary btn-xs" onClick={() => setForm(prev => ({ ...prev, latitude: '', longitude: '' }))}>
                    Limpiar
                  </button>
                </p>
              )}
            </div>

            <div className="form-group">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  className="form-control"
                  checked={form.isActive}
                  onChange={(e) => _handleChange('isActive', e.target.checked)}
                  disabled={isSubmitting}
                />
                <span>Activa</span>
              </label>
            </div>

            {globalError && <p style={{ color: '#ef4444', fontSize: '0.875rem', marginBottom: '1rem' }}>{globalError}</p>}

            <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem', justifyContent: 'flex-end' }}>
              <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={isSubmitting}>
                Cancelar
              </button>
              <button type="submit" className="btn btn-primary" disabled={isSubmitting}>
                {isSubmitting ? 'Guardando…' : initialData ? 'Guardar cambios' : 'Crear sede'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type { VenueFormData } from '@/lib/api';