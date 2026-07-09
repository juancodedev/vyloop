'use client';

import Link from 'next/link';
import { useState } from 'react';

import { apiFetch } from '@/lib/api';

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function SendMessagePage() {
  const [customerId, setCustomerId] = useState('');
  const [templateName, setTemplateName] = useState('');
  const [phone, setPhone] = useState('');
  const [parameters, setParameters] = useState<Array<{ key: string; value: string }>>([
    { key: '1', value: '' },
  ]);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<{ id: string; status: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const addParam = () => {
    setParameters([...parameters, { key: String(parameters.length + 1), value: '' }]);
  };

  const removeParam = (index: number) => {
    if (parameters.length <= 1) return;
    const updated = parameters.filter((_, i) => i !== index).map((p, i) => ({ ...p, key: String(i + 1) }));
    setParameters(updated);
  };

  const updateParam = (index: number, value: string) => {
    const updated = [...parameters];
    updated[index] = { ...updated[index], value };
    setParameters(updated);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setResult(null);

    if (!customerId.trim() || !templateName.trim()) {
      setError('El ID del cliente y el nombre de la plantilla son obligatorios');
      return;
    }

    const paramsRecord: Record<string, string> = {};
    parameters.forEach((p) => {
      if (p.value.trim()) paramsRecord[p.key] = p.value.trim();
    });

    setSending(true);
    try {
      const data = await apiFetch('/v1/communication/send', {
        method: 'POST',
        body: JSON.stringify({
          customer_id: customerId.trim(),
          template_name: templateName.trim(),
          ...(phone.trim() ? { phone: phone.trim() } : {}),
          ...(Object.keys(paramsRecord).length > 0 ? { parameters: paramsRecord } : {}),
        }),
      });
      const resp = data as { data: { id: string; status: string } };
      setResult(resp.data);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Error al enviar mensaje';
      setError(msg);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="page fade-in">
      {/* ─── Header ─── */}
      <div className="dash-header">
        <div>
          <h1 className="dash-title">Enviar Mensaje</h1>
          <p className="dash-subtitle">Enviá un mensaje WhatsApp a un cliente</p>
        </div>
        <div className="dash-actions">
          <Link href="/dashboard/communication/messages" className="btn btn-secondary btn-sm">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6" />
            </svg>
            Volver al historial
          </Link>
        </div>
      </div>

      <div className="card" style={{ maxWidth: 600 }}>
        <div className="card-body">
          {result ? (
            <div>
              <div className="toast toast-success" style={{ marginBottom: '1rem' }}>
                Mensaje encolado exitosamente
              </div>
              <div className="tier-stat">
                <span className="tier-stat-label">ID del mensaje</span>
                <span className="tier-stat-value" style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8rem' }}>{result.id}</span>
              </div>
              <div className="tier-stat">
                <span className="tier-stat-label">Estado</span>
                <span className="tier-stat-value">{result.status}</span>
              </div>
              <div style={{ marginTop: '1rem', display: 'flex', gap: '0.5rem' }}>
                <button className="btn btn-primary" onClick={() => { setResult(null); setError(null); }}>
                  Enviar otro mensaje
                </button>
                <Link href="/dashboard/communication/messages" className="btn btn-secondary">
                  Ver historial
                </Link>
              </div>
            </div>
          ) : (
            <form onSubmit={handleSubmit}>
              {error && <div className="toast toast-error" style={{ marginBottom: '1rem' }}>{error}</div>}

              <div className="form-group">
                <label>ID del Cliente</label>
                <input
                  className="form-control"
                  value={customerId}
                  onChange={(e) => setCustomerId(e.target.value)}
                  placeholder="Ej: 550e8400-e29b-..."
                />
              </div>

              <div className="form-group">
                <label>Nombre de la Plantilla</label>
                <input
                  className="form-control"
                  value={templateName}
                  onChange={(e) => setTemplateName(e.target.value)}
                  placeholder="Ej: bienvenida_cliente"
                />
              </div>

              <div className="form-group">
                <label>Teléfono (opcional)</label>
                <input
                  className="form-control"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="Ej: 56912345678"
                />
                <span className="hint">Si no se especifica, se usa el teléfono del cliente.</span>
              </div>

              <div className="form-group">
                <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span>Parámetros</span>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={addParam}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="12" y1="5" x2="12" y2="19" />
                      <line x1="5" y1="12" x2="19" y2="12" />
                    </svg>
                    Agregar
                  </button>
                </label>
                {parameters.map((param, i) => (
                  <div key={i} style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.5rem', alignItems: 'center' }}>
                    <input
                      className="form-control"
                      style={{ width: 60, textAlign: 'center', fontFamily: 'var(--font-mono)' }}
                      value={param.key}
                      disabled
                    />
                    <input
                      className="form-control"
                      style={{ flex: 1 }}
                      value={param.value}
                      onChange={(e) => updateParam(i, e.target.value)}
                      placeholder={`Valor del parámetro ${param.key}`}
                    />
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => removeParam(i)}
                      disabled={parameters.length <= 1}
                      style={{ color: 'var(--text-muted)', padding: '0.25rem' }}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="18" y1="6" x2="6" y2="18" />
                        <line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                    </button>
                  </div>
                ))}
              </div>

              <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem' }}>
                <button className="btn btn-primary" type="submit" disabled={sending}>
                  {sending ? 'Enviando…' : 'Enviar Mensaje'}
                </button>
                <Link href="/dashboard/communication/messages" className="btn btn-secondary">
                  Cancelar
                </Link>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
