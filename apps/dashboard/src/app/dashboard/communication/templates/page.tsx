'use client';

import { useState, useEffect } from 'react';

import { apiFetch } from '@/lib/api';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface WhatsAppTemplate {
  id: string;
  name: string;
  language: string;
  category: string;
  body: string;
  status: string;
  createdAt: string;
}

interface NewTemplateForm {
  name: string;
  language: string;
  category: string;
  body: string;
}

const LANGUAGES = [
  { value: 'es', label: 'Español' },
  { value: 'en', label: 'Inglés' },
  { value: 'pt', label: 'Portugués' },
];

const CATEGORIES = [
  { value: 'marketing', label: 'Marketing' },
  { value: 'utility', label: 'Utilidad' },
  { value: 'authentication', label: 'Autenticación' },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getStatusBadge(status: string): { label: string; className: string } {
  switch (status) {
    case 'approved':
      return { label: 'Aprobada', className: 'badge badge-oro' };
    case 'rejected':
      return { label: 'Rechazada', className: 'badge' };
    case 'pending':
    default:
      return { label: 'Pendiente', className: 'badge badge-plata' };
  }
}

function formatRelative(time: string): string {
  const diff = Date.now() - new Date(time).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Ahora';
  if (mins < 60) return `Hace ${mins} min`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `Hace ${hrs} h`;
  const days = Math.floor(hrs / 24);
  if (days === 1) return 'Ayer';
  return `Hace ${days} días`;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function TemplatesPage() {
  const [templates, setTemplates] = useState<WhatsAppTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [form, setForm] = useState<NewTemplateForm>({
    name: '',
    language: 'es',
    category: 'utility',
    body: '',
  });

  const fetchTemplates = () => {
    setLoading(true);
    setError(null);
    apiFetch('/v1/communication/templates')
      .then((data) => {
        const resp = data as { data: WhatsAppTemplate[] };
        setTemplates(resp.data ?? []);
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchTemplates();
  }, []);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);

    if (!form.name.trim() || !form.body.trim()) {
      setFormError('El nombre y el cuerpo son obligatorios');
      return;
    }

    setCreating(true);
    try {
      await apiFetch('/v1/communication/templates', {
        method: 'POST',
        body: JSON.stringify(form),
      });
      setShowForm(false);
      setForm({ name: '', language: 'es', category: 'utility', body: '' });
      fetchTemplates();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Error al crear plantilla';
      setFormError(msg);
    } finally {
      setCreating(false);
    }
  };

  // ─── Loading ───

  if (loading) {
    return (
      <div className="loading-screen">
        <div className="spinner" />
        <p className="text-muted">Cargando plantillas…</p>
      </div>
    );
  }

  // ─── Error ───

  if (error && templates.length === 0) {
    return (
      <div className="page fade-in">
        <div className="empty-state">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--text-muted)' }}>
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          <p>{error}</p>
          <button className="btn btn-primary mt-4" onClick={() => fetchTemplates()}>
            Reintentar
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="page fade-in">
      {/* ─── Header ─── */}
      <div className="dash-header">
        <div>
          <h1 className="dash-title">Plantillas WhatsApp</h1>
          <p className="dash-subtitle">Gestioná las plantillas de mensajes para tus campañas</p>
        </div>
        <div className="dash-actions">
          <button className="btn btn-primary btn-sm" onClick={() => setShowForm(!showForm)}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            Nueva Plantilla
          </button>
        </div>
      </div>

      {/* ─── Create Form ─── */}
      {showForm && (
        <div className="card mb-4">
          <div className="card-header">
            <h3>Crear nueva plantilla</h3>
            <button className="modal-close" onClick={() => { setShowForm(false); setFormError(null); }}>×</button>
          </div>
          <div className="card-body">
            {formError && <div className="toast toast-error" style={{ marginBottom: '1rem' }}>{formError}</div>}
            <form onSubmit={handleCreate}>
              <div className="form-row">
                <div className="form-group">
                  <label>Nombre</label>
                  <input
                    className="form-control"
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    placeholder="Ej: bienvenida_cliente"
                  />
                </div>
                <div className="form-group">
                  <label>Idioma</label>
                  <select
                    className="form-control"
                    value={form.language}
                    onChange={(e) => setForm({ ...form, language: e.target.value })}
                  >
                    {LANGUAGES.map((l) => (
                      <option key={l.value} value={l.value}>{l.label}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label>Categoría</label>
                  <select
                    className="form-control"
                    value={form.category}
                    onChange={(e) => setForm({ ...form, category: e.target.value })}
                  >
                    {CATEGORIES.map((c) => (
                      <option key={c.value} value={c.value}>{c.label}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="form-group">
                <label>Cuerpo del mensaje</label>
                <textarea
                  className="form-control"
                  rows={5}
                  value={form.body}
                  onChange={(e) => setForm({ ...form, body: e.target.value })}
                  placeholder="Ej: ¡Hola {{1}}! Gracias por registrarte..."
                />
                <span className="hint">Usá {'{{1}}'}, {'{{2}}'}, etc. para parámetros variables.</span>
              </div>
              <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem' }}>
                <button className="btn btn-primary" type="submit" disabled={creating}>
                  {creating ? 'Creando…' : 'Crear Plantilla'}
                </button>
                <button className="btn btn-secondary" type="button" onClick={() => { setShowForm(false); setFormError(null); }}>
                  Cancelar
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ─── Empty state ─── */}
      {templates.length === 0 && !error ? (
        <div className="card">
          <div className="empty-state">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--text-muted)' }}>
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
            <p>No hay plantillas todavía.</p>
            <button className="btn btn-primary mt-4" onClick={() => setShowForm(true)}>
              Crear primera plantilla
            </button>
          </div>
        </div>
      ) : (
        /* ─── Template List ─── */
        <div className="tier-grid">
          {templates.map((tpl) => {
            const badge = getStatusBadge(tpl.status);
            return (
              <div key={tpl.id} className="card">
                <div className="card-body">
                  <h3 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '0.5rem' }}>{tpl.name}</h3>
                  <div className="tier-stat">
                    <span className="tier-stat-label">Idioma</span>
                    <span className="tier-stat-value">{tpl.language}</span>
                  </div>
                  <div className="tier-stat">
                    <span className="tier-stat-label">Categoría</span>
                    <span className="tier-stat-value">{CATEGORIES.find((c) => c.value === tpl.category)?.label ?? tpl.category}</span>
                  </div>
                  <div className="tier-stat">
                    <span className="tier-stat-label">Estado</span>
                    <span className="tier-stat-value">
                      <span className={badge.className} style={{ background: tpl.status === 'rejected' ? 'var(--error-light)' : undefined, color: tpl.status === 'rejected' ? 'var(--error)' : undefined }}>
                        {badge.label}
                      </span>
                    </span>
                  </div>
                  <div className="tier-stat">
                    <span className="tier-stat-label">Creada</span>
                    <span className="tier-stat-value" style={{ fontWeight: 400 }}>{formatRelative(tpl.createdAt)}</span>
                  </div>
                  {tpl.body && (
                    <div style={{ marginTop: '0.5rem', padding: '0.5rem', background: '#f8fafc', borderRadius: 'var(--radius-sm)', fontSize: '0.8rem', color: 'var(--text-secondary)', maxHeight: '80px', overflow: 'hidden' }}>
                      {tpl.body}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
