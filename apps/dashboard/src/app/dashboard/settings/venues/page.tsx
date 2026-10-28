'use client';

import { useState, useEffect, useCallback } from 'react';

import { useConfirm } from '@/components/ConfirmDialog';
import { VenueForm } from '@/components/venue-form';
import { api, type BranchView, type VenueFormData } from '@/lib/api';

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

function SearchIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

function LocationIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
      <circle cx="12" cy="10" r="3" />
    </svg>
  );
}

function EditIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5a2.121 2.121 0 0 1 3 3z" />
    </svg>
  );
}

function TrashIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  );
}

function ToastContainer() {
  const [toasts, setToasts] = useState<Array<{ id: number; type: 'success' | 'error' | 'info'; message: string }>>([]);

   
  const showToast = useCallback((type: 'success' | 'error' | 'info', message: string) => {
    const id = Date.now();
    setToasts(prev => [...prev, { id, type, message }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 3500);
  }, []);

   
  useEffect(() => {
    const handler = (e: CustomEvent) => {
      const { type, message } = e.detail;
      showToast(type, message);
    };
    window.addEventListener('dashboard-toast', handler as EventListener);
    return () => window.removeEventListener('dashboard-toast', handler as EventListener);
  }, [showToast]);

  return (
    <div className="toast-container" style={{ position: 'fixed', bottom: '1.5rem', right: '1.5rem', zIndex: 1000, display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      {toasts.map(t => (
        <div key={t.id} className={`toast toast-${t.type}`} style={{ minWidth: '280px', maxWidth: '400px' }}>
          {t.message}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Venues Page
// ---------------------------------------------------------------------------

const MERCHANT_LOCATION_LIMIT = 10;

function nearbyStatus(venue: BranchView, all: BranchView[]) {
  if (!venue.is_active) {
    return <span className="badge badge-muted">Inactiva</span>;
  }
  if (venue.latitude === null || venue.longitude === null) {
    return <span className="badge badge-muted">Sin posición</span>;
  }
  const eligible = all
    .filter((v) => v.is_active && v.latitude !== null && v.longitude !== null)
    .sort((a, b) => new Date(b.located_at ?? 0).getTime() - new Date(a.located_at ?? 0).getTime())
    .slice(0, MERCHANT_LOCATION_LIMIT);
  const carried = eligible.some((v) => v.id === venue.id);
  if (carried) {
    return <span className="badge badge-success">En pases</span>;
  }
  return <span className="badge badge-warning">Fuera del límite</span>;
}

/** Lowercased and without accents, so "nunoa" finds "Ñuñoa". */
function normalize(text: string): string {
  return text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
}

export default function VenuesPage() {
  const [venues, setVenues] = useState<BranchView[]>([]);
  const [askConfirm, confirmDialog] = useConfirm();
  const [includeInactive, setIncludeInactive] = useState(false);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingVenue, setEditingVenue] = useState<BranchView | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const loadVenues = useCallback(async () => {
    setLoading(true);
    try {
      // Every branch, active or not: the identity worker returns them all in one
      // list, so the inactive filter and the search run on it here.
      const { branches } = await api.getVenues({ includeInactive: true });
      setVenues(branches);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Error al cargar sedes';
      const event = new CustomEvent('dashboard-toast', { detail: { type: 'error', message: msg } });
      window.dispatchEvent(event);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadVenues();
  }, [loadVenues]);

  const query = normalize(search.trim());
  const shown = venues.filter(
    (v) =>
      (includeInactive || v.is_active) &&
      (query === '' ||
        [v.name, v.address, v.city].some((field) => field && normalize(field).includes(query))),
  );

  const openCreateModal = () => {
    setEditingVenue(null);
    setModalOpen(true);
  };

  const openEditModal = (venue: BranchView) => {
    setEditingVenue(venue);
    setModalOpen(true);
  };

  const closeModal = () => {
    setModalOpen(false);
    setEditingVenue(null);
  };

  const handleSubmit = async (data: VenueFormData) => {
    setSubmitting(true);
    try {
      if (editingVenue) {
        await api.updateVenue(editingVenue.id, data);
      } else {
        await api.createVenue(data);
      }
      closeModal();
      loadVenues();
    } finally {
      setSubmitting(false);
    }
  };

  // The switch and the trash button both deactivate, and both ask once. The
  // trash button used to ask, then call the switch's handler, which asked again.
  const deactivate = async (venue: BranchView) => {
    if (!venue.is_active) return; // Only allow deactivation from list
    const confirmed = await askConfirm({
      title: `¿Desactivar "${venue.name}"?`,
      message: 'Seguirá existiendo, pero no aparecerá en las listas.',
      confirmLabel: 'Desactivar',
    });
    if (!confirmed) return;
    try {
      await api.deactivateVenue(venue.id);
      loadVenues();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'No se pudo desactivar la sede';
      window.dispatchEvent(new CustomEvent('dashboard-toast', { detail: { type: 'error', message } }));
    }
  };

  // No confirmation: bringing a branch back undoes nothing and loses nothing.
  const reactivate = async (venue: BranchView) => {
    try {
      await api.reactivateVenue(venue.id);
      loadVenues();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'No se pudo reactivar la sede';
      window.dispatchEvent(new CustomEvent('dashboard-toast', { detail: { type: 'error', message } }));
    }
  };

  return (
    <>
      <ToastContainer />
      {confirmDialog}
      <div className="page fade-in">
        <div className="dash-header">
          <div>
            <h1 className="dash-title">Sedes</h1>
            <p className="dash-subtitle">Gestiona las sedes de tu negocio</p>
          </div>
          <div className="dash-actions">
            <button className="btn btn-primary" onClick={openCreateModal} disabled={loading}>
              Nueva sede
            </button>
          </div>
        </div>

        {/* Toolbar */}
        <div className="flex items-center justify-between mb-4 flex-wrap gap-4">
          <div className="search-input-wrapper" style={{ flex: 1, minWidth: '280px' }}>
            <SearchIcon />
            <input
              type="text"
              className="form-control"
              placeholder="Buscar por nombre o dirección…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              disabled={loading}
            />
          </div>
          <label className="flex items-center gap-2 text-sm text-muted white-space-nowrap">
            <input type="checkbox" className="form-control" checked={includeInactive} onChange={(e) => setIncludeInactive(e.target.checked)} />
            Incluir inactivas
          </label>
        </div>

        <div className="card">
          <div className="table-container">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Nombre</th>
                  <th>Dirección</th>
                  <th>Coordenadas</th>
                  <th>Notificaciones cercanas</th>
                  <th>Estado</th>
                  <th style={{ width: '160px' }}>Acciones</th>
                </tr>
              </thead>
              <tbody>
                {loading && (
                  <tr>
                    <td colSpan={6} className="text-center text-muted" style={{ padding: '2rem' }}>
                      Cargando…
                    </td>
                  </tr>
                )}
                {!loading && venues.length === 0 && (
                  <tr>
                    <td colSpan={6} className="text-center text-muted" style={{ padding: '2rem' }}>
                      <p>No hay sedes registradas</p>
                      <button className="btn btn-primary mt-2" onClick={openCreateModal} disabled={loading}>
                        Registrar primera sede
                      </button>
                    </td>
                  </tr>
                )}
                {!loading && venues.length > 0 && shown.length === 0 && (
                  <tr>
                    <td colSpan={6} className="text-center text-muted" style={{ padding: '2rem' }}>
                      {query === ''
                        ? 'Todas tus sedes están inactivas.'
                        : 'Ninguna sede coincide con la búsqueda.'}
                    </td>
                  </tr>
                )}
                {!loading && shown.map((v) => (
                  <tr key={v.id}>
                    <td>
                      <div style={{ fontWeight: 500 }}>{v.name}</div>
                    </td>
                    <td>
                      {[v.address, v.city].filter(Boolean).join(', ') || '—'}
                    </td>
                    <td>
                      {v.latitude !== null && v.longitude !== null ? (
                        <span className="badge badge-success" title={`${v.latitude}, ${v.longitude}`}>
                          <LocationIcon /> Ubicada
                        </span>
                      ) : (
                        <span className="badge badge-muted">Sin coordenadas</span>
                      )}
                    </td>
                    <td>
                      {nearbyStatus(v, venues)}
                    </td>
                    <td>
                      <label className="switch" style={{ marginRight: '0.5rem' }}>
                        <input
                          type="checkbox"
                          checked={v.is_active}
                          onChange={() => (v.is_active ? deactivate(v) : reactivate(v))}
                          disabled={loading}
                          aria-label={v.is_active ? `Desactivar ${v.name}` : `Activar ${v.name}`}
                        />
                        <span className="slider"></span>
                      </label>
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: '0.25rem' }}>
                        <button
                          className="btn btn-secondary btn-sm"
                          onClick={() => openEditModal(v)}
                          disabled={loading}
                          title="Editar"
                        >
                          <EditIcon />
                        </button>
                        {v.is_active ? (
                          <button
                            className="btn btn-danger btn-sm"
                            onClick={() => deactivate(v)}
                            disabled={loading}
                            title="Desactivar"
                          >
                            <TrashIcon />
                          </button>
                        ) : (
                          <button
                            className="btn btn-secondary btn-sm"
                            onClick={() => reactivate(v)}
                            disabled={loading}
                            aria-label={`Reactivar ${v.name}`}
                          >
                            Reactivar
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {modalOpen && (
          <VenueForm
            initialData={editingVenue}
            onSubmit={handleSubmit}
            onCancel={closeModal}
            isSubmitting={submitting}
            _submitLabel={editingVenue ? 'Guardar cambios' : 'Crear sede'}
          />
        )}
      </div>
    </>
  );
}

