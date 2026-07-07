'use client';

import { Button } from '@vyloop/design-system';
import { Pencil, Plus, Trash2, X } from 'lucide-react';
import { useState, useEffect } from 'react';

import styles from './page.module.css';

import { api } from '@/lib/api';
import type { Reward } from '@/lib/api';

interface RewardForm {
  name: string;
  description: string;
  pointsCost: number;
  category: string;
  stock: string;
  autoGrantThreshold: string;
  validFrom: string;
  validUntil: string;
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

  useEffect(() => {
    loadRewards();
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
    return <div className={styles.loading}>Cargando…</div>;
  }

  return (
    <>
      {/* Header */}
      <div className={styles.header}>
        <span className={styles.count}>
          {rewards.length} recompensa{rewards.length !== 1 ? 's' : ''} configurada{rewards.length !== 1 ? 's' : ''}
        </span>
        <Button size="sm" icon={<Plus size={16} />} onClick={openCreate}>
          Nueva Recompensa
        </Button>
      </div>

      {/* Rewards Table / Empty */}
      {rewards.length === 0 ? (
        <div className={styles.card}>
          <div className={styles.emptyBody}>
            <p>No hay recompensas configuradas. Cree la primera recompensa para comenzar.</p>
          </div>
        </div>
      ) : (
        <div className={styles.card}>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Nombre</th>
                  <th>Puntos</th>
                  <th>Categoría</th>
                  <th>Stock</th>
                  <th>Auto-grant</th>
                  <th>Vigencia</th>
                  <th>Acciones</th>
                </tr>
              </thead>
              <tbody>
                {rewards.map((reward) => (
                  <tr key={reward.id}>
                    <td className={styles.cellName}>{reward.name}</td>
                    <td>{reward.pointsCost.toLocaleString()}</td>
                    <td>{reward.category || '—'}</td>
                    <td>{reward.stock !== undefined ? reward.stock.toLocaleString() : '∞'}</td>
                    <td>{reward.autoGrantThreshold ? `${reward.autoGrantThreshold.toLocaleString()} pts` : '—'}</td>
                    <td>
                      {reward.validFrom || reward.validUntil
                        ? `${formatDate(reward.validFrom)} — ${formatDate(reward.validUntil)}`
                        : '—'}
                    </td>
                    <td>
                      <div className={styles.cellActions}>
                        <Button variant="secondary" size="sm" icon={<Pencil size={14} />} onClick={() => openEdit(reward)}>
                          Editar
                        </Button>
                        <Button variant="danger" size="sm" icon={<Trash2 size={14} />} onClick={() => handleDelete(reward)}>
                          Eliminar
                        </Button>
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
        <div className={styles.overlay} onClick={closeModal}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div className={styles.modalHeader}>
              <h3 className={styles.modalTitle}>
                {modal.mode === 'create' ? 'Nueva Recompensa' : 'Editar Recompensa'}
              </h3>
              <button className={styles.closeBtn} onClick={closeModal} aria-label="Cerrar">
                <X size={18} />
              </button>
            </div>

            <div className={styles.modalBody}>
              <div className={styles.fieldGroup}>
                <label className={styles.label} htmlFor="reward-name">Nombre</label>
                <input
                  id="reward-name"
                  type="text"
                  className={styles.input}
                  placeholder="Ej: Café Americano"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </div>

              <div className={styles.fieldGroup}>
                <label className={styles.label} htmlFor="reward-desc">Descripción</label>
                <textarea
                  id="reward-desc"
                  className={styles.textarea}
                  rows={2}
                  placeholder="Descripción de la recompensa"
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                />
              </div>

              <div className={styles.fieldRow}>
                <div className={styles.fieldGroup}>
                  <label className={styles.label} htmlFor="reward-points">Costo en puntos</label>
                  <input
                    id="reward-points"
                    type="number"
                    min="1"
                    className={styles.input}
                    value={form.pointsCost}
                    onChange={(e) => setForm({ ...form, pointsCost: Number(e.target.value) })}
                  />
                </div>
                <div className={styles.fieldGroup}>
                  <label className={styles.label} htmlFor="reward-category">Categoría</label>
                  <input
                    id="reward-category"
                    type="text"
                    className={styles.input}
                    placeholder="Ej: Bebidas"
                    value={form.category}
                    onChange={(e) => setForm({ ...form, category: e.target.value })}
                  />
                </div>
              </div>

              <div className={styles.fieldRow}>
                <div className={styles.fieldGroup}>
                  <label className={styles.label} htmlFor="reward-stock">Stock (vacío = ilimitado)</label>
                  <input
                    id="reward-stock"
                    type="number"
                    min="0"
                    className={styles.input}
                    placeholder="Ilimitado"
                    value={form.stock}
                    onChange={(e) => setForm({ ...form, stock: e.target.value })}
                  />
                </div>
                <div className={styles.fieldGroup}>
                  <label className={styles.label} htmlFor="reward-auto">Auto-grant al alcanzar puntos</label>
                  <input
                    id="reward-auto"
                    type="number"
                    min="0"
                    className={styles.input}
                    placeholder="Ej: 5000"
                    value={form.autoGrantThreshold}
                    onChange={(e) => setForm({ ...form, autoGrantThreshold: e.target.value })}
                  />
                </div>
              </div>

              <div className={styles.fieldRow}>
                <div className={styles.fieldGroup}>
                  <label className={styles.label} htmlFor="reward-validFrom">Válido desde</label>
                  <input
                    id="reward-validFrom"
                    type="date"
                    className={styles.input}
                    value={form.validFrom}
                    onChange={(e) => setForm({ ...form, validFrom: e.target.value })}
                  />
                </div>
                <div className={styles.fieldGroup}>
                  <label className={styles.label} htmlFor="reward-validUntil">Válido hasta</label>
                  <input
                    id="reward-validUntil"
                    type="date"
                    className={styles.input}
                    value={form.validUntil}
                    onChange={(e) => setForm({ ...form, validUntil: e.target.value })}
                  />
                </div>
              </div>
            </div>

            <div className={styles.modalFooter}>
              <Button variant="secondary" onClick={closeModal} disabled={saving}>
                Cancelar
              </Button>
              <Button
                onClick={handleSave}
                loading={saving}
                disabled={!form.name.trim() || form.pointsCost < 1}
              >
                {saving ? 'Guardando…' : modal.mode === 'create' ? 'Crear Recompensa' : 'Guardar Cambios'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div className={styles.toastContainer}>
          <div className={toast.type === 'success' ? styles.toastSuccess : styles.toastError}>
            {toast.message}
          </div>
        </div>
      )}
    </>
  );
}
