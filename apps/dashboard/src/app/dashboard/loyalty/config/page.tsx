'use client';

import { Button } from '@vyloop/design-system';
import { Check, Pencil, X } from 'lucide-react';
import { useState, useEffect } from 'react';

import styles from './page.module.css';

import { api } from '@/lib/api';
import type { LoyaltyConfig } from '@/lib/api';

export default function LoyaltyConfigPage() {
  const [config, setConfig] = useState<LoyaltyConfig | null>(null);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ earnRate: 1, programName: '' });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ type: string; message: string } | null>(null);

  useEffect(() => {
    api.getLoyaltyConfig().then((data) => {
      setConfig(data);
      setForm({ earnRate: data.earnRate, programName: data.programName });
      setLoading(false);
    });
  }, []);

  function showToast(type: string, message: string) {
    setToast({ type, message });
    setTimeout(() => setToast(null), 3000);
  }

  function handleEdit() {
    if (!config) return;
    setForm({ earnRate: config.earnRate, programName: config.programName });
    setEditing(true);
  }

  function handleCancel() {
    setEditing(false);
    if (config) {
      setForm({ earnRate: config.earnRate, programName: config.programName });
    }
  }

  async function handleSave() {
    if (!config) return;
    setSaving(true);
    try {
      const updated = await api.updateLoyaltyConfig({
        earnRate: form.earnRate,
        programName: form.programName,
      });
      setConfig(updated);
      setEditing(false);
      showToast('success', 'Configuración guardada exitosamente');
    } catch {
      showToast('error', 'Error al guardar la configuración');
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <div className={styles.loading}>Cargando…</div>;
  }

  if (!config) {
    return <div className={styles.loading}>No se pudo cargar la configuración</div>;
  }

  return (
    <>
      <div className={styles.card}>
        <div className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Configuración del Programa</h2>
          {!editing && (
            <Button variant="secondary" size="sm" icon={<Pencil size={14} />} onClick={handleEdit}>
              Editar
            </Button>
          )}
        </div>
        <div className={styles.cardBody}>
          {!editing ? (
            <div className={styles.fieldStack}>
              <div className={styles.fieldGroup}>
                <span className={styles.fieldLabel}>Nombre del programa</span>
                <span className={styles.fieldValue}>{config.programName}</span>
              </div>
              <div className={styles.fieldGroup}>
                <span className={styles.fieldLabel}>Tasa de acumulación</span>
                <span className={styles.fieldValue}>
                  {config.earnRate} punto por cada $1.000
                </span>
                <span className={styles.fieldHint}>
                  Por cada $1.000 pesos de compra, el cliente recibe {config.earnRate} punto
                  {config.earnRate !== 1 ? 's' : ''} (multiplicado por el nivel)
                </span>
              </div>
            </div>
          ) : (
            <div className={styles.fieldStack}>
              <div className={styles.fieldGroup}>
                <label className={styles.label} htmlFor="programName">
                  Nombre del programa
                </label>
                <input
                  id="programName"
                  type="text"
                  className={styles.input}
                  value={form.programName}
                  onChange={(e) => setForm({ ...form, programName: e.target.value })}
                />
              </div>
              <div className={styles.fieldGroup}>
                <label className={styles.label} htmlFor="earnRate">
                  Tasa de acumulación (puntos por $1.000)
                </label>
                <input
                  id="earnRate"
                  type="number"
                  step="0.1"
                  min="0.1"
                  className={styles.input}
                  value={form.earnRate}
                  onChange={(e) => setForm({ ...form, earnRate: Number(e.target.value) })}
                />
                <span className={styles.fieldHint}>
                  Por cada $1.000 pesos de compra, el cliente recibe esta cantidad de puntos base
                </span>
              </div>
              <div className={styles.inlineActions}>
                <Button size="sm" icon={<Check size={14} />} onClick={handleSave} loading={saving}>
                  Guardar
                </Button>
                <Button variant="secondary" size="sm" icon={<X size={14} />} onClick={handleCancel} disabled={saving}>
                  Cancelar
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>

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
