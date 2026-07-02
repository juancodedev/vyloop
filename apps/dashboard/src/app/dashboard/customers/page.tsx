'use client';

import { useState, useEffect, type FormEvent } from 'react';
import { api } from '@/lib/api';
import type { Customer } from '@/lib/mock-data';

export default function CustomersPage() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    api.getCustomers(search).then((data) => {
      setCustomers(data);
      setLoading(false);
    });
  }, [search]);

  function handleSearch(e: FormEvent<HTMLInputElement>) {
    setSearch(e.currentTarget.value);
  }

  return (
    <div>
      {/* Toolbar */}
      <div className="flex items-center justify-between mb-4">
        <div className="search-input-wrapper">
          <svg
            className="search-icon"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            type="text"
            className="form-control"
            placeholder="Buscar por nombre, teléfono o correo…"
            value={search}
            onInput={handleSearch}
          />
        </div>
        <span className="text-sm text-muted">
          {customers.length} cliente{customers.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Table */}
      <div className="card">
        <div className="table-container">
          <table className="data-table">
            <thead>
              <tr>
                <th>Nombre</th>
                <th>Teléfono</th>
                <th>Puntos</th>
                <th>Nivel</th>
                <th>Miembro desde</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={5} className="text-center text-muted" style={{ padding: '2rem' }}>
                    Cargando…
                  </td>
                </tr>
              ) : customers.length === 0 ? (
                <tr>
                  <td colSpan={5} className="text-center text-muted" style={{ padding: '2rem' }}>
                    No se encontraron clientes
                  </td>
                </tr>
              ) : (
                customers.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <div style={{ fontWeight: 500 }}>{c.fullName}</div>
                      {c.email && (
                        <div className="text-xs text-muted">{c.email}</div>
                      )}
                    </td>
                    <td>{c.phone}</td>
                    <td style={{ fontWeight: 600 }}>{c.points.toLocaleString()}</td>
                    <td>
                      <span className={`badge badge-${c.currentTier.toLowerCase()}`}>
                        {c.currentTier}
                      </span>
                    </td>
                    <td className="text-sm text-muted">{c.createdAt}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
