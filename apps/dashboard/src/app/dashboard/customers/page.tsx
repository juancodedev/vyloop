'use client';

import { Search } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useEffect, type FormEvent } from 'react';

import styles from './page.module.css';

import { api } from '@/lib/api';
import type { Customer } from '@/lib/api';


function TierBadge({ tier }: { tier: string }) {
  const tierKey = tier.toLowerCase();
  const variantClass =
    tierKey === 'bronce'
      ? styles.badgeBronce
      : tierKey === 'plata'
        ? styles.badgePlata
        : tierKey === 'oro'
          ? styles.badgeOro
          : styles.badgePlata;

  return <span className={`${styles.badge} ${variantClass}`}>{tier}</span>;
}

export default function CustomersPage() {
  const router = useRouter();
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
      {/* ─── Toolbar ─── */}
      <div className={styles.toolbar}>
        <div className={styles.searchWrapper}>
          <Search size={14} className={styles.searchIcon} />
          <input
            type="text"
            className={styles.searchInput}
            placeholder="Buscar por nombre, teléfono o correo…"
            value={search}
            onInput={handleSearch}
          />
        </div>
        <span className={styles.count}>
          {customers.length} cliente{customers.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* ─── Table ─── */}
      <div className={styles.card}>
        <div className={styles.tableWrapper}>
          <table className={styles.table}>
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
                  <td colSpan={5} className={styles.loadingCell}>
                    Cargando…
                  </td>
                </tr>
              ) : customers.length === 0 ? (
                <tr>
                  <td colSpan={5} className={styles.emptyCell}>
                    No se encontraron clientes
                  </td>
                </tr>
              ) : (
                customers.map((c) => (
                  <tr
                    key={c.id}
                    onClick={() => router.push(`/dashboard/customers/${c.id}`)}
                  >
                    <td>
                      <div className={styles.cellName}>{c.fullName}</div>
                      {c.email && <div className={styles.cellEmail}>{c.email}</div>}
                    </td>
                    <td>{c.phone}</td>
                    <td className={styles.cellPoints}>
                      {c.points.toLocaleString()}
                    </td>
                    <td>
                      <TierBadge tier={c.currentTier} />
                    </td>
                    <td className={styles.cellDate}>{c.createdAt}</td>
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
