'use client';

import { useState, useEffect } from 'react';

import { api } from '@/lib/api';
import type { EarnBy, LoyaltyConfig } from '@/lib/api';
import { describeEarnRule } from '@/lib/loyalty-earn-rule';

const EARN_BY_OPTIONS: Array<{ value: EarnBy; label: string; hint: string }> = [
  {
    value: 'visit',
    label: 'Por visita / conteo',
    hint: 'Cada visita, chequeo o conteo válido otorga puntos. No depende del monto.',
  },
  {
    value: 'purchase',
    label: 'Por monto de compra',
    hint: 'Los puntos se calculan a partir del monto en pesos, según la tasa y el monto base de abajo.',
  },
];

export default function LoyaltyConfigPage() {
  const [config, setConfig] = useState<LoyaltyConfig | null>(null);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({
    earnRate: 1,
    earnBy: 'visit' as EarnBy,
    earnUnitAmount: 1000,
    programName: '',
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ type: string; message: string } | null>(null);

  useEffect(() => {
    api.getLoyaltyConfig().then((data) => {
      setConfig(data);
      setForm({
        earnRate: data.earnRate,
        earnBy: data.earnBy,
        earnUnitAmount: data.earnUnitAmount,
        programName: data.programName,
      });
      setLoading(false);
    });
  }, []);

  function showToast(type: string, message: string) {
    setToast({ type, message });
    setTimeout(() => setToast(null), 3000);
  }

  function handleEdit() {
    if (!config) return;
    setForm({
      earnRate: config.earnRate,
      earnBy: config.earnBy,
      earnUnitAmount: config.earnUnitAmount,
      programName: config.programName,
    });
    setEditing(true);
  }

  function handleCancel() {
    setEditing(false);
    if (config) {
      setForm({
        earnRate: config.earnRate,
        earnBy: config.earnBy,
        earnUnitAmount: config.earnUnitAmount,
        programName: config.programName,
      });
    }
  }

  async function handleSave() {
    if (!config) return;
    setSaving(true);
    try {
      // The unit travels with the mechanic. The worker refuses
      // `earn_by: 'purchase'` without one (INVALID_EARN_UNIT_AMOUNT), because
      // paying out against its default would be a rate the merchant never chose.
      const updated = await api.updateLoyaltyConfig({
        earnRate: form.earnRate,
        earnBy: form.earnBy,
        earnUnitAmount: form.earnUnitAmount,
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

  const rule = describeEarnRule({
    earnBy: config.earnBy,
    earnRate: config.earnRate,
    earnUnitAmount: config.earnUnitAmount,
  });

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
                {/* Built from the configured mechanic, so this sentence can never
                    describe a rule the worker is not running. */}
                <div style={{ fontSize: '1rem', fontWeight: 500 }}>
                  {rule.headline}
                </div>
                <div className="text-xs text-muted" style={{ marginTop: '0.25rem' }}>
                  {rule.detail}
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
                <label htmlFor="earnBy">Los puntos se acumulan por</label>
                <select
                  id="earnBy"
                  className="form-control"
                  value={form.earnBy}
                  onChange={(e) => setForm({ ...form, earnBy: e.target.value as EarnBy })}
                >
                  {EARN_BY_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <div className="hint">
                  {EARN_BY_OPTIONS.find((option) => option.value === form.earnBy)?.hint}
                </div>
              </div>
              {form.earnBy === 'purchase' && (
                <div className="form-group">
                  <label htmlFor="earnUnitAmount">Monto base por unidad (pesos)</label>
                  <input
                    id="earnUnitAmount"
                    type="number"
                    step="0.01"
                    min="1"
                    className="form-control"
                    value={form.earnUnitAmount}
                    onChange={(e) =>
                      setForm({ ...form, earnUnitAmount: Number(e.target.value) })
                    }
                  />
                  <div className="hint">
                    Cada pesos de este monto equivalen a {form.earnRate}{' '}
                    {Math.abs(form.earnRate - 1) < 1e-9 ? 'punto' : 'puntos'} base para el
                    cliente
                  </div>
                </div>
              )}
              <div className="form-group">
                <label htmlFor="earnRate">
                  Tasa de acumulación (puntos base por {form.earnBy === 'purchase' ? 'unidad de monto' : 'visita'})
                </label>
                <input
                  id="earnRate"
                  type="number"
                  step="0.1"
                  min="0.1"
                  max="1000"
                  className="form-control"
                  value={form.earnRate}
                  onChange={(e) => setForm({ ...form, earnRate: Number(e.target.value) })}
                />
                <div className="hint">
                  El total se multiplica por el nivel del cliente y se redondea hacia abajo
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
