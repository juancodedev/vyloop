'use client';

import { useState, useEffect } from 'react';

import { api } from '@/lib/api';
import type { Reward, Venue } from '@/lib/api';

interface RewardForm {
  name: string;
  description: string;
  pointsCost: number;
  category: string;
  stock: string;
  autoGrantThreshold: string;
  validFrom: string;
  validUntil: string;
  /** Empty means every venue of the business. */
  branchIds: string[];
}

const emptyForm: RewardForm = {
  name: '',
  description: '',
  pointsCost: 100,
  category: '',
  stock: '',
  autoGrantThreshold: '',
  validFrom: '',
  validUntil: '',
  branchIds: [],
};

function formatDate(iso?: string): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('es-CL');
}

export default function LoyaltyRewardsPage() {
  const [rewards, setRewards] = useState<Reward[]>([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState<{ mode: 'create' | 'edit'; reward?: Reward } | null>(null);
  const [form, setForm] = useState<RewardForm>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ type: string; message: string } | null>(null);
  const [venues, setVenues] = useState<Venue[]>([]);

  useEffect(() => {
    loadRewards();
    // Venues are only needed inside the modal, so a failure here must not stop
    // the catalog from rendering: the form then offers "all venues" alone.
    api.getVenues().then(setVenues).catch(() => setVenues([]));
  }, []);

  async function loadRewards() {
    setLoading(true);
    const data = await api.getRewards();
    setRewards(data);
    setLoading(false);
  }

  function showToast(type: string, message: string) {
    setToast({ type, message });
    setTimeout(() => setToast(null), 3500);
  }

  function openCreate() {
    setForm(emptyForm);
    setModal({ mode: 'create' });
  }

  function openEdit(reward: Reward) {
    setForm({
      name: reward.name,
      description: reward.description || '',
      pointsCost: reward.pointsCost,
      category: reward.category || '',
      stock: reward.stock !== undefined ? String(reward.stock) : '',
      autoGrantThreshold: reward.autoGrantThreshold !== undefined ? String(reward.autoGrantThreshold) : '',
      validFrom: reward.validFrom ? reward.validFrom.slice(0, 10) : '',
      validUntil: reward.validUntil ? reward.validUntil.slice(0, 10) : '',
      branchIds: reward.branchIds ?? [],
    });
    setModal({ mode: 'edit', reward });
  }

  function closeModal() {
    setModal(null);
    setForm(emptyForm);
  }

  async function handleSave() {
    setSaving(true);
    try {
      const payload: Partial<Reward> = {
        name: form.name,
        pointsCost: form.pointsCost,
        ...(form.description && { description: form.description }),
        ...(form.category && { category: form.category }),
        ...(form.stock && { stock: Number(form.stock) }),
        ...(form.autoGrantThreshold && { autoGrantThreshold: Number(form.autoGrantThreshold) }),
        ...(form.validFrom && { validFrom: new Date(form.validFrom).toISOString() }),
        ...(form.validUntil && { validUntil: new Date(form.validUntil).toISOString() }),
        // Always sent: the checkbox group is the authority on this field, and
        // an empty array is the explicit "every venue" answer.
        branchIds: form.branchIds,
      };

      if (modal?.mode === 'create') {
        await api.createReward(payload as Omit<Reward, 'id'>);
        showToast('success', `Recompensa "${form.name}" creada exitosamente`);
      } else if (modal?.mode === 'edit' && modal.reward) {
        await api.updateReward(modal.reward.id, payload);
        showToast('success', `Recompensa "${form.name}" actualizada exitosamente`);
      }
      closeModal();
      await loadRewards();
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Error al guardar');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(reward: Reward) {
    if (!confirm(`¿Eliminar la recompensa "${reward.name}"? Esta acción no se puede deshacer.`)) {
      return;
    }
    try {
      await api.deleteReward(reward.id);
      showToast('success', `Recompensa "${reward.name}" eliminada`);
      await loadRewards();
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
          {rewards.length} recompensa{rewards.length !== 1 ? 's' : ''} configurada{rewards.length !== 1 ? 's' : ''}
        </span>
        <button className="btn btn-primary btn-sm" onClick={openCreate}>
          + Nueva Recompensa
        </button>
      </div>

      {/* Rewards Table */}
      {rewards.length === 0 ? (
        <div className="card">
          <div className="card-body empty-state">
            <p>No hay recompensas configuradas. Cree la primera recompensa para comenzar.</p>
          </div>
        </div>
      ) : (
        <div className="card">
          <div className="table-container">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Nombre</th>
                  <th>Puntos</th>
                  <th>Categoría</th>
                  <th>Locales</th>
                  <th>Stock</th>
                  <th>Auto-grant</th>
                  <th>Vigencia</th>
                  <th className="actions">Acciones</th>
                </tr>
              </thead>
              <tbody>
                {rewards.map((reward) => (
                  <tr key={reward.id}>
                    <td style={{ fontWeight: 500 }}>{reward.name}</td>
                    <td>{reward.pointsCost.toLocaleString()}</td>
                    <td>{reward.category || '—'}</td>
                    <td>
                      {reward.branchIds && reward.branchIds.length > 0
                        ? `${reward.branchIds.length} local${reward.branchIds.length !== 1 ? 'es' : ''}`
                        : 'Todos'}
                    </td>
                    <td>{reward.stock !== undefined ? reward.stock.toLocaleString() : '∞'}</td>
                    <td>{reward.autoGrantThreshold ? `${reward.autoGrantThreshold.toLocaleString()} pts` : '—'}</td>
                    <td>
                      {reward.validFrom || reward.validUntil
                        ? `${formatDate(reward.validFrom)} — ${formatDate(reward.validUntil)}`
                        : '—'}
                    </td>
                    <td className="actions">
                      <div className="flex gap-1">
                        <button className="btn btn-secondary btn-sm" onClick={() => openEdit(reward)}>
                          Editar
                        </button>
                        <button className="btn btn-danger btn-sm" onClick={() => handleDelete(reward)}>
                          Eliminar
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Modal */}
      {modal && (
        <div className="modal-overlay" onClick={closeModal}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>{modal.mode === 'create' ? 'Nueva Recompensa' : 'Editar Recompensa'}</h3>
              <button className="modal-close" onClick={closeModal}>
                &times;
              </button>
            </div>

            <div className="modal-body">
              <div className="form-group">
                <label htmlFor="reward-name">Nombre</label>
                <input
                  id="reward-name"
                  type="text"
                  className="form-control"
                  placeholder="Ej: Café Americano"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </div>

              <div className="form-group">
                <label htmlFor="reward-desc">Descripción</label>
                <textarea
                  id="reward-desc"
                  className="form-control"
                  rows={2}
                  placeholder="Descripción de la recompensa"
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                />
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label htmlFor="reward-points">Costo en puntos</label>
                  <input
                    id="reward-points"
                    type="number"
                    min="1"
                    className="form-control"
                    value={form.pointsCost}
                    onChange={(e) => setForm({ ...form, pointsCost: Number(e.target.value) })}
                  />
                </div>
                <div className="form-group">
                  <label htmlFor="reward-category">Categoría</label>
                  <input
                    id="reward-category"
                    type="text"
                    className="form-control"
                    placeholder="Ej: Bebidas"
                    value={form.category}
                    onChange={(e) => setForm({ ...form, category: e.target.value })}
                  />
                </div>
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label htmlFor="reward-stock">Stock (vacío = ilimitado)</label>
                  <input
                    id="reward-stock"
                    type="number"
                    min="0"
                    className="form-control"
                    placeholder="Ilimitado"
                    value={form.stock}
                    onChange={(e) => setForm({ ...form, stock: e.target.value })}
                  />
                </div>
                <div className="form-group">
                  <label htmlFor="reward-auto">Auto-grant al alcanzar puntos</label>
                  <input
                    id="reward-auto"
                    type="number"
                    min="0"
                    className="form-control"
                    placeholder="Ej: 5000"
                    value={form.autoGrantThreshold}
                    onChange={(e) => setForm({ ...form, autoGrantThreshold: e.target.value })}
                  />
                </div>
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label htmlFor="reward-validFrom">Válido desde</label>
                  <input
                    id="reward-validFrom"
                    type="date"
                    className="form-control"
                    value={form.validFrom}
                    onChange={(e) => setForm({ ...form, validFrom: e.target.value })}
                  />
                </div>
                <div className="form-group">
                  <label htmlFor="reward-validUntil">Válido hasta</label>
                  <input
                    id="reward-validUntil"
                    type="date"
                    className="form-control"
                    value={form.validUntil}
                    onChange={(e) => setForm({ ...form, validUntil: e.target.value })}
                  />
                </div>
              </div>

              <div className="form-group">
                <label>Locales donde se puede canjear</label>
                <p className="text-sm text-muted" style={{ marginTop: 0 }}>
                  Sin ninguno marcado, la recompensa se canjea en todos los locales del negocio.
                </p>
                {venues.length === 0 ? (
                  <p className="text-sm text-muted">No hay locales configurados.</p>
                ) : (
                  <div className="flex flex-col gap-1">
                    {venues.map((venue) => (
                      <label key={venue.id} className="flex items-center gap-1" htmlFor={`reward-venue-${venue.id}`}>
                        <input
                          id={`reward-venue-${venue.id}`}
                          type="checkbox"
                          checked={form.branchIds.includes(venue.id)}
                          onChange={(e) =>
                            setForm({
                              ...form,
                              branchIds: e.target.checked
                                ? [...form.branchIds, venue.id]
                                : form.branchIds.filter((id) => id !== venue.id),
                            })
                          }
                        />
                        <span>
                          {venue.name}
                          {venue.city ? ` — ${venue.city}` : ''}
                          {!venue.isActive ? ' (cerrado)' : ''}
                        </span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={closeModal} disabled={saving}>
                Cancelar
              </button>
              <button
                className="btn btn-primary"
                onClick={handleSave}
                disabled={saving || !form.name.trim() || form.pointsCost < 1}
              >
                {saving ? 'Guardando…' : modal.mode === 'create' ? 'Crear Recompensa' : 'Guardar Cambios'}
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
