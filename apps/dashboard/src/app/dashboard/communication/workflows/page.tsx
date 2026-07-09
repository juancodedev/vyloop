'use client';

import { useState, useEffect } from 'react';

import { apiFetch } from '@/lib/api';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Workflow {
  id: string;
  name: string;
  triggerEvent: string;
  conditions: unknown[];
  actions: unknown[];
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

interface NewWorkflowForm {
  name: string;
  triggerEvent: string;
  conditions: string;
  actions: string;
}

const TRIGGER_LABELS: Record<string, string> = {
  customer_registered: 'Registro de cliente',
  points_milestone: 'Hito de puntos',
  reward_redeemed: 'Canje de recompensa',
  birthday: 'Cumpleaños',
  inactivity: 'Inactividad',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function getStatusLabel(triggerEvent: string): string {
  return TRIGGER_LABELS[triggerEvent] ?? triggerEvent;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function WorkflowsPage() {
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [toggling, setToggling] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<NewWorkflowForm>({
    name: '',
    triggerEvent: 'customer_registered',
    conditions: '[]',
    actions: '[]',
  });
  const [formError, setFormError] = useState<string | null>(null);

  const fetchWorkflows = () => {
    setLoading(true);
    setError(null);
    apiFetch('/v1/automation/workflows')
      .then((data) => {
        const resp = data as { data: Workflow[] };
        setWorkflows(resp.data ?? []);
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchWorkflows();
  }, []);

  const handleToggle = async (id: string) => {
    setToggling(id);
    try {
      await apiFetch(`/v1/automation/workflows/${id}/toggle`, { method: 'PUT' });
      setWorkflows((prev) =>
        prev.map((w) => (w.id === id ? { ...w, isActive: !w.isActive } : w)),
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Error al cambiar estado';
      setError(msg);
    } finally {
      setToggling(null);
    }
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);

    if (!form.name.trim()) {
      setFormError('El nombre es obligatorio');
      return;
    }

    let parsedConditions: unknown[];
    let parsedActions: unknown[];
    try {
      parsedConditions = JSON.parse(form.conditions);
      parsedActions = JSON.parse(form.actions);
    } catch {
      setFormError('Los campos JSON no son válidos');
      return;
    }

    setCreating(true);
    try {
      await apiFetch('/v1/automation/workflows', {
        method: 'POST',
        body: JSON.stringify({
          name: form.name.trim(),
          trigger_event: form.triggerEvent,
          conditions: parsedConditions,
          actions: parsedActions,
        }),
      });
      setShowForm(false);
      setForm({ name: '', triggerEvent: 'customer_registered', conditions: '[]', actions: '[]' });
      fetchWorkflows();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Error al crear flujo';
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
        <p className="text-muted">Cargando flujos…</p>
      </div>
    );
  }

  // ─── Error ───

  if (error && workflows.length === 0) {
    return (
      <div className="page fade-in">
        <div className="empty-state">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--text-muted)' }}>
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          <p>{error}</p>
          <button className="btn btn-primary mt-4" onClick={() => fetchWorkflows()}>
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
          <h1 className="dash-title">Flujos de Automatización</h1>
          <p className="dash-subtitle">Configurá flujos automáticos de comunicación</p>
        </div>
        <div className="dash-actions">
          <button className="btn btn-primary btn-sm" onClick={() => setShowForm(!showForm)}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            Nuevo Flujo
          </button>
        </div>
      </div>

      {/* ─── Create Form ─── */}
      {showForm && (
        <div className="card mb-4">
          <div className="card-header">
            <h3>Crear nuevo flujo</h3>
            <button className="modal-close" onClick={() => { setShowForm(false); setFormError(null); }}>×</button>
          </div>
          <div className="card-body">
            {formError && <div className="toast toast-error" style={{ marginBottom: '1rem' }}>{formError}</div>}
            <form onSubmit={handleCreate}>
              <div className="form-row">
                <div className="form-group">
                  <label>Nombre del flujo</label>
                  <input
                    className="form-control"
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    placeholder="Ej: Bienvenida por registro"
                  />
                </div>
                <div className="form-group">
                  <label>Evento disparador</label>
                  <select
                    className="form-control"
                    value={form.triggerEvent}
                    onChange={(e) => setForm({ ...form, triggerEvent: e.target.value })}
                  >
                    {Object.entries(TRIGGER_LABELS).map(([value, label]) => (
                      <option key={value} value={value}>{label}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label>Condiciones (JSON)</label>
                  <textarea
                    className="form-control"
                    rows={4}
                    value={form.conditions}
                    onChange={(e) => setForm({ ...form, conditions: e.target.value })}
                    placeholder='[{ "field": "metadata.tier", "operator": "eq", "value": "oro" }]'
                    style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8rem' }}
                  />
                  <span className="hint">Arreglo de condiciones. Dejar [] si no aplica.</span>
                </div>
                <div className="form-group">
                  <label>Acciones (JSON)</label>
                  <textarea
                    className="form-control"
                    rows={4}
                    value={form.actions}
                    onChange={(e) => setForm({ ...form, actions: e.target.value })}
                    placeholder='[{ "type": "send_whatsapp", "config": { "template_name": "welcome", "parameters": [] } }]'
                    style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8rem' }}
                  />
                  <span className="hint">Arreglo de acciones a ejecutar.</span>
                </div>
              </div>
              <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem' }}>
                <button className="btn btn-primary" type="submit" disabled={creating}>
                  {creating ? 'Creando…' : 'Crear Flujo'}
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
      {workflows.length === 0 && !error ? (
        <div className="card">
          <div className="empty-state">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--text-muted)' }}>
              <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
            </svg>
            <p>No hay flujos de automatización todavía.</p>
            <button className="btn btn-primary mt-4" onClick={() => setShowForm(true)}>
              Crear primer flujo
            </button>
          </div>
        </div>
      ) : (
        /* ─── Workflow List ─── */
        <div className="tier-grid">
          {workflows.map((wf) => (
            <div key={wf.id} className="card" style={{ borderLeft: wf.isActive ? '3px solid var(--success)' : '3px solid var(--text-muted)' }}>
              <div className="card-body">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '0.75rem' }}>
                  <h3 style={{ fontSize: '1rem', fontWeight: 600, margin: 0 }}>{wf.name}</h3>
                  <button
                    className={`btn btn-sm ${wf.isActive ? 'btn-secondary' : 'btn-primary'}`}
                    disabled={toggling === wf.id}
                    onClick={() => handleToggle(wf.id)}
                  >
                    {toggling === wf.id ? '…' : wf.isActive ? 'Desactivar' : 'Activar'}
                  </button>
                </div>
                <div className="tier-stat">
                  <span className="tier-stat-label">Disparador</span>
                  <span className="tier-stat-value">{getStatusLabel(wf.triggerEvent)}</span>
                </div>
                <div className="tier-stat">
                  <span className="tier-stat-label">Estado</span>
                  <span className="tier-stat-value" style={{ color: wf.isActive ? 'var(--success)' : 'var(--text-muted)' }}>
                    {wf.isActive ? 'Activo' : 'Inactivo'}
                  </span>
                </div>
                <div className="tier-stat">
                  <span className="tier-stat-label">Creado</span>
                  <span className="tier-stat-value" style={{ fontWeight: 400 }}>{formatRelative(wf.createdAt)}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
