'use client';

import { useState, useEffect } from 'react';
import { api } from '@/lib/api';
import type { Tier } from '@/lib/mock-data';

interface TierForm {
  name: string;
  minPoints: number;
  multiplier: number;
  benefits: string;
  displayOrder: number;
}

const emptyForm: TierForm = {
  name: '',
  minPoints: 0,
  multiplier: 1,
  benefits: '',
  displayOrder: 1,
};

export default function LoyaltyTiersPage() {
  const [tiers, setTiers] = useState<Tier[]>([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState<{ mode: 'create' | 'edit'; tier?: Tier } | null>(null);
  const [form, setForm] = useState<TierForm>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ type: string; message: string } | null>(null);

  useEffect(() => {
    loadTiers();
  }, []);

  async function loadTiers() {
    setLoading(true);
    const data = await api.getTiers();
    setTiers(data);
    setLoading(false);
  }

  function showToast(type: string, message: string) {
    setToast({ type, message });
    setTimeout(() => setToast(null), 3500);
  }

  function openCreate() {
    setForm({ ...emptyForm, displayOrder: tiers.length + 1 });
    setModal({ mode: 'create' });
  }

  function openEdit(tier: Tier) {
    setForm({
      name: tier.name,
      minPoints: tier.minPoints,
      multiplier: tier.multiplier,
      benefits: tier.benefits,
      displayOrder: tier.displayOrder,
    });
    setModal({ mode: 'edit', tier });
  }

  function closeModal() {
    setModal(null);
    setForm(emptyForm);
  }

  async function handleSave() {
    setSaving(true);
    try {
      if (modal?.mode === 'create') {
        await api.createTier(form);
        showToast('success', `Nivel "${form.name}" creado exitosamente`);
      } else if (modal?.mode === 'edit' && modal.tier) {
        await api.updateTier(modal.tier.id, form);
        showToast('success', `Nivel "${form.name}" actualizado exitosamente`);
      }
      closeModal();
      await loadTiers();
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Error al guardar');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(tier: Tier) {
    if (!confirm(`¿Eliminar el nivel "${tier.name}"? Esta acción no se puede deshacer.`)) {
      return;
    }
    try {
      await api.deleteTier(tier.id);
      showToast('success', `Nivel "${tier.name}" eliminado`);
      await loadTiers();
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Error al eliminar');
    }
  }

  if (loading) {
    return (
      <div className="card">
        <div className="card-body text-center text-muted">Cargando…</div>
      </div>
    );
  }

  return (
    <>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <span className="text-sm text-muted">
          {tiers.length} nivel{tiers.length !== 1 ? 'es' : ''} configurado{tiers.length !== 1 ? 's' : ''}
        </span>
        <button className="btn btn-primary btn-sm" onClick={openCreate}>
          + Nuevo Nivel
        </button>
      </div>

      {/* Tier Cards */}
      <div className="tier-grid">
        {tiers.map((tier) => (
          <div className="card tier-card" key={tier.id}>
            <div className="card-body">
              <div className="tier-name">{tier.name}</div>

              <div className="tier-stat">
                <span className="tier-stat-label">Puntos mínimos</span>
                <span className="tier-stat-value">{tier.minPoints.toLocaleString()}</span>
              </div>

              <div className="tier-stat">
                <span className="tier-stat-label">Multiplicador</span>
                <span className="tier-stat-value">{tier.multiplier}x</span>
              </div>

              <div className="tier-stat">
                <span className="tier-stat-label">Clientes</span>
                <span className="tier-stat-value">{tier.customerCount}</span>
              </div>

              <div className="tier-stat">
                <span className="tier-stat-label">Beneficios</span>
                <span className="tier-stat-value" style={{ fontWeight: 400, fontSize: '0.8rem' }}>
                  {tier.benefits}
                </span>
              </div>

              <div className="tier-actions">
                <button className="btn btn-secondary btn-sm" onClick={() => openEdit(tier)}>
                  Editar
                </button>
                <button className="btn btn-danger btn-sm" onClick={() => handleDelete(tier)}>
                  Eliminar
                </button>
              </div>
            </div>
          </div>
        ))}

        {tiers.length === 0 && (
          <div className="card">
            <div className="card-body empty-state">
              <p>No hay niveles configurados. Cree el primer nivel para comenzar.</p>
            </div>
          </div>
        )}
      </div>

      {/* Modal */}
      {modal && (
        <div className="modal-overlay" onClick={closeModal}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>{modal.mode === 'create' ? 'Nuevo Nivel' : 'Editar Nivel'}</h3>
              <button className="modal-close" onClick={closeModal}>
                &times;
              </button>
            </div>

            <div className="modal-body">
              <div className="form-group">
                <label htmlFor="tier-name">Nombre del nivel</label>
                <input
                  id="tier-name"
                  type="text"
                  className="form-control"
                  placeholder="Ej: Diamante"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label htmlFor="tier-minPoints">Puntos mínimos</label>
                  <input
                    id="tier-minPoints"
                    type="number"
                    min="0"
                    className="form-control"
                    value={form.minPoints}
                    onChange={(e) => setForm({ ...form, minPoints: Number(e.target.value) })}
                  />
                </div>
                <div className="form-group">
                  <label htmlFor="tier-multiplier">Multiplicador</label>
                  <input
                    id="tier-multiplier"
                    type="number"
                    step="0.1"
                    min="1"
                    className="form-control"
                    value={form.multiplier}
                    onChange={(e) => setForm({ ...form, multiplier: Number(e.target.value) })}
                  />
                </div>
              </div>

              <div className="form-group">
                <label htmlFor="tier-order">Orden de visualización</label>
                <input
                  id="tier-order"
                  type="number"
                  min="1"
                  className="form-control"
                  value={form.displayOrder}
                  onChange={(e) => setForm({ ...form, displayOrder: Number(e.target.value) })}
                />
              </div>

              <div className="form-group">
                <label htmlFor="tier-benefits">Beneficios</label>
                <textarea
                  id="tier-benefits"
                  className="form-control"
                  rows={3}
                  placeholder="Describe los beneficios de este nivel"
                  value={form.benefits}
                  onChange={(e) => setForm({ ...form, benefits: e.target.value })}
                />
              </div>
            </div>

            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={closeModal} disabled={saving}>
                Cancelar
              </button>
              <button
                className="btn btn-primary"
                onClick={handleSave}
                disabled={saving || !form.name.trim()}
              >
                {saving ? 'Guardando…' : modal.mode === 'create' ? 'Crear Nivel' : 'Guardar Cambios'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div className="toast-container">
          <div className={`toast toast-${toast.type}`}>{toast.message}</div>
        </div>
      )}
    </>
  );
}
