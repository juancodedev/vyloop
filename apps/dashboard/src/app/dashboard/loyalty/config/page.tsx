'use client';

import { useState, useEffect } from 'react';
import { api } from '@/lib/api';
import type { LoyaltyConfig } from '@/lib/mock-data';

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
    return (
      <div className="card">
        <div className="card-body text-center text-muted">Cargando…</div>
      </div>
    );
  }

  if (!config) {
    return (
      <div className="card">
        <div className="card-body text-center text-muted">
          No se pudo cargar la configuración
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="card">
        <div className="card-header">
          <h3>Configuración del Programa</h3>
          {!editing && (
            <button className="btn btn-secondary btn-sm" onClick={handleEdit}>
              Editar
            </button>
          )}
        </div>
        <div className="card-body">
          {!editing ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
              <div>
                <div className="text-xs text-muted" style={{ marginBottom: '0.25rem' }}>
                  NOMBRE DEL PROGRAMA
                </div>
                <div style={{ fontSize: '1rem', fontWeight: 500 }}>{config.programName}</div>
              </div>
              <div>
                <div className="text-xs text-muted" style={{ marginBottom: '0.25rem' }}>
                  TASA DE ACUMULACIÓN
                </div>
                <div style={{ fontSize: '1rem', fontWeight: 500 }}>
                  {config.earnRate} punto por cada $1.000
                </div>
                <div className="text-xs text-muted" style={{ marginTop: '0.25rem' }}>
                  Por cada $1.000 pesos de compra, el cliente recibe {config.earnRate} punto
                  {config.earnRate !== 1 ? 's' : ''} (multiplicado por el nivel)
                </div>
              </div>
            </div>
          ) : (
            <div>
              <div className="form-group">
                <label htmlFor="programName">Nombre del programa</label>
                <input
                  id="programName"
                  type="text"
                  className="form-control"
                  value={form.programName}
                  onChange={(e) => setForm({ ...form, programName: e.target.value })}
                />
              </div>
              <div className="form-group">
                <label htmlFor="earnRate">Tasa de acumulación (puntos por $1.000)</label>
                <input
                  id="earnRate"
                  type="number"
                  step="0.1"
                  min="0.1"
                  className="form-control"
                  value={form.earnRate}
                  onChange={(e) => setForm({ ...form, earnRate: Number(e.target.value) })}
                />
                <div className="hint">
                  Por cada $1.000 pesos de compra, el cliente recibe esta cantidad de puntos base
                </div>
              </div>
              <div className="inline-edit-actions">
                <button
                  className="btn btn-primary btn-sm"
                  onClick={handleSave}
                  disabled={saving}
                >
                  {saving ? 'Guardando…' : 'Guardar'}
                </button>
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={handleCancel}
                  disabled={saving}
                >
                  Cancelar
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Toast */}
      {toast && (
        <div className="toast-container">
          <div className={`toast toast-${toast.type}`}>{toast.message}</div>
        </div>
      )}
    </>
  );
}
