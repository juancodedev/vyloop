'use client';

import { Button } from '@vyloop/design-system';
import { Pencil, Plus, Trash2, X } from 'lucide-react';
import { useState, useEffect } from 'react';

import styles from './page.module.css';

import { api } from '@/lib/api';
import type { Tier } from '@/lib/api';

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
    return <div className={styles.loading}>Cargando…</div>;
  }

  return (
    <>
      {/* Header */}
      <div className={styles.header}>
        <span className={styles.count}>
          {tiers.length} nivel{tiers.length !== 1 ? 'es' : ''} configurado{tiers.length !== 1 ? 's' : ''}
        </span>
        <Button size="sm" icon={<Plus size={16} />} onClick={openCreate}>
          Nuevo Nivel
        </Button>
      </div>

      {/* Tier Grid */}
      <div className={styles.grid}>
        {tiers.map((tier) => (
          <div className={styles.card} key={tier.id}>
            <div className={styles.cardBody}>
              <div className={styles.tierName}>{tier.name}</div>

              <div className={styles.statRow}>
                <span className={styles.statLabel}>Puntos mínimos</span>
                <span className={styles.statValue}>{tier.minPoints.toLocaleString()}</span>
              </div>

              <div className={styles.statRow}>
                <span className={styles.statLabel}>Multiplicador</span>
                <span className={styles.statValue}>{tier.multiplier}x</span>
              </div>

              <div className={styles.statRow}>
                <span className={styles.statLabel}>Clientes</span>
                <span className={styles.statValue}>{tier.customerCount}</span>
              </div>

              <div className={styles.statRow}>
                <span className={styles.statLabel}>Beneficios</span>
                <span className={styles.statBenefits}>{tier.benefits}</span>
              </div>

              <div className={styles.actions}>
                <Button variant="secondary" size="sm" icon={<Pencil size={14} />} onClick={() => openEdit(tier)}>
                  Editar
                </Button>
                <Button variant="danger" size="sm" icon={<Trash2 size={14} />} onClick={() => handleDelete(tier)}>
                  Eliminar
                </Button>
              </div>
            </div>
          </div>
        ))}

        {tiers.length === 0 && (
          <div className={styles.emptyCard}>
            <div className={styles.emptyBody}>
              <p>No hay niveles configurados. Cree el primer nivel para comenzar.</p>
            </div>
          </div>
        )}
      </div>

      {/* Modal */}
      {modal && (
        <div className={styles.overlay} onClick={closeModal}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div className={styles.modalHeader}>
              <h3 className={styles.modalTitle}>
                {modal.mode === 'create' ? 'Nuevo Nivel' : 'Editar Nivel'}
              </h3>
              <button className={styles.closeBtn} onClick={closeModal} aria-label="Cerrar">
                <X size={18} />
              </button>
            </div>

            <div className={styles.modalBody}>
              <div className={styles.fieldGroup}>
                <label className={styles.label} htmlFor="tier-name">Nombre del nivel</label>
                <input
                  id="tier-name"
                  type="text"
                  className={styles.input}
                  placeholder="Ej: Diamante"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </div>

              <div className={styles.fieldRow}>
                <div className={styles.fieldGroup}>
                  <label className={styles.label} htmlFor="tier-minPoints">Puntos mínimos</label>
                  <input
                    id="tier-minPoints"
                    type="number"
                    min="0"
                    className={styles.input}
                    value={form.minPoints}
                    onChange={(e) => setForm({ ...form, minPoints: Number(e.target.value) })}
                  />
                </div>
                <div className={styles.fieldGroup}>
                  <label className={styles.label} htmlFor="tier-multiplier">Multiplicador</label>
                  <input
                    id="tier-multiplier"
                    type="number"
                    step="0.1"
                    min="1"
                    className={styles.input}
                    value={form.multiplier}
                    onChange={(e) => setForm({ ...form, multiplier: Number(e.target.value) })}
                  />
                </div>
              </div>

              <div className={styles.fieldGroup}>
                <label className={styles.label} htmlFor="tier-order">Orden de visualización</label>
                <input
                  id="tier-order"
                  type="number"
                  min="1"
                  className={styles.input}
                  value={form.displayOrder}
                  onChange={(e) => setForm({ ...form, displayOrder: Number(e.target.value) })}
                />
              </div>

              <div className={styles.fieldGroup}>
                <label className={styles.label} htmlFor="tier-benefits">Beneficios</label>
                <textarea
                  id="tier-benefits"
                  className={styles.textarea}
                  rows={3}
                  placeholder="Describe los beneficios de este nivel"
                  value={form.benefits}
                  onChange={(e) => setForm({ ...form, benefits: e.target.value })}
                />
              </div>
            </div>

            <div className={styles.modalFooter}>
              <Button variant="secondary" onClick={closeModal} disabled={saving}>
                Cancelar
              </Button>
              <Button
                onClick={handleSave}
                loading={saving}
                disabled={!form.name.trim()}
              >
                {modal.mode === 'create' ? 'Crear Nivel' : 'Guardar Cambios'}
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
