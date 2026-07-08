'use client';

import clsx from 'clsx';
import { ChevronUp, ChevronDown } from 'lucide-react';
import { useState, useCallback, useMemo, type ReactNode } from 'react';

import styles from './Table.module.css';

// ── Types ──

export type SortDirection = 'asc' | 'desc';

export interface TableColumn<T extends Record<string, unknown>> {
  /** Key to access the data value */
  key: string;
  /** Column header label */
  header: string;
  /** Custom cell renderer */
  render?: (value: unknown, row: T, index: number) => ReactNode;
  /** Cell alignment */
  align?: 'left' | 'center' | 'right';
  /** Enable sorting for this column */
  sortable?: boolean;
  /** Column width (CSS value) */
  width?: string;
  /** Column min-width (CSS value) */
  minWidth?: string;
}

export interface TableProps<T extends Record<string, unknown>> {
  /** Column definitions */
  columns: TableColumn<T>[];
  /** Data rows */
  data: T[];
  /** Unique key extractor or key field name */
  rowKey?: string | ((row: T) => string | number);
  /** Loading skeleton state */
  loading?: boolean;
  /** Message when data is empty */
  emptyMessage?: string;
  /** Row click handler */
  onRowClick?: (row: T) => void;
  /** Enable header sorting (click to sort) */
  sortable?: boolean;
  /** Default sort column key */
  defaultSortKey?: string;
  /** Default sort direction */
  defaultSortDirection?: SortDirection;
}

// ── Helper ──

function extractRowKey<T extends Record<string, unknown>>(
  row: T,
  rowKey: string | ((row: T) => string | number) | undefined,
  index: number,
): string | number {
  if (typeof rowKey === 'function') return rowKey(row);
  if (typeof rowKey === 'string') return String(row[rowKey] ?? index);
  return index;
}

function getCellValue<T extends Record<string, unknown>>(row: T, key: string): unknown {
  return row[key];
}

// ── Table Component ──

export function Table<T extends Record<string, unknown>>({
  columns,
  data,
  rowKey,
  loading = false,
  emptyMessage = 'No data',
  onRowClick,
  sortable: globallySortable = false,
  defaultSortKey,
  defaultSortDirection = 'asc',
}: TableProps<T>) {
  const [sortKey, setSortKey] = useState<string | undefined>(defaultSortKey);
  const [sortDir, setSortDir] = useState<SortDirection>(defaultSortDirection);

  const handleHeaderClick = useCallback(
    (col: TableColumn<T>) => {
      if (!globallySortable && !col.sortable) return;
      const key = col.key;
      if (sortKey === key) {
        setSortDir((prev) => (prev === 'asc' ? 'desc' : 'asc'));
      } else {
        setSortKey(key);
        setSortDir('asc');
      }
    },
    [globallySortable, sortKey],
  );

  const sortedData = useMemo(() => {
    if (!sortKey || data.length === 0) return data;

    return [...data].sort((a, b) => {
      const aVal = getCellValue(a, sortKey);
      const bVal = getCellValue(b, sortKey);

      let cmp = 0;
      if (aVal == null && bVal == null) cmp = 0;
      else if (aVal == null) cmp = 1;
      else if (bVal == null) cmp = -1;
      else if (typeof aVal === 'number' && typeof bVal === 'number') cmp = aVal - bVal;
      else if (typeof aVal === 'string' && typeof bVal === 'string') cmp = aVal.localeCompare(bVal);
      else cmp = String(aVal).localeCompare(String(bVal));

      return sortDir === 'desc' ? -cmp : cmp;
    });
  }, [data, sortKey, sortDir]);

  // ── Loading: 5 skeleton rows ──

  if (loading) {
    return (
      <div className={styles.wrapper}>
        <table className={styles.table}>
          <thead className={styles.header}>
            <tr>
              {columns.map((col) => (
                <th
                  key={col.key}
                  className={clsx(styles.headerCell, col.align && styles[`align${col.align.charAt(0).toUpperCase()}${col.align.slice(1)}`])}
                  style={{ width: col.width, minWidth: col.minWidth }}
                  scope="col"
                >
                  {col.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: 5 }, (_, rowIdx) => (
              <tr key={rowIdx} className={styles.skeletonRow}>
                {columns.map((col) => (
                  <td key={col.key} className={styles.skeletonCell}>
                    <div
                      className={styles.skeletonBar}
                      style={{ width: `${60 + Math.random() * 30}%` }}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  // ── Empty state ──

  if (data.length === 0) {
    return (
      <div className={styles.wrapper}>
        <table className={styles.table}>
          <thead className={styles.header}>
            <tr>
              {columns.map((col) => (
                <th
                  key={col.key}
                  className={clsx(styles.headerCell, col.align && styles[`align${col.align.charAt(0).toUpperCase()}${col.align.slice(1)}`])}
                  style={{ width: col.width, minWidth: col.minWidth }}
                  scope="col"
                >
                  {col.header}
                </th>
              ))}
            </tr>
          </thead>
        </table>
        <div className={styles.empty}>{emptyMessage}</div>
      </div>
    );
  }

  // ── Normal render ──

  return (
    <div className={styles.wrapper}>
      <table className={styles.table}>
        <thead className={styles.header}>
          <tr>
            {columns.map((col) => {
              const isActiveSort = sortKey === col.key;
              const isSortable = globallySortable || col.sortable;

              return (
                <th
                  key={col.key}
                  className={clsx(
                    styles.headerCell,
                    col.align && styles[`align${col.align.charAt(0).toUpperCase()}${col.align.slice(1)}`],
                    isSortable && styles.sortable,
                  )}
                  style={{ width: col.width, minWidth: col.minWidth }}
                  scope="col"
                  aria-sort={
                    isActiveSort
                      ? (sortDir === 'asc' ? 'ascending' : 'descending')
                      : undefined
                  }
                  onClick={() => isSortable && handleHeaderClick(col)}
                  tabIndex={isSortable ? 0 : undefined}
                  onKeyDown={(e) => {
                    if (isSortable && (e.key === 'Enter' || e.key === ' ')) {
                      e.preventDefault();
                      handleHeaderClick(col);
                    }
                  }}
                >
                  {col.header}
                  {isSortable && (
                    <span className={clsx(styles.sortIcon, isActiveSort && styles.active)}>
                      {isActiveSort && sortDir === 'asc' ? (
                        <ChevronUp size={14} aria-hidden="true" />
                      ) : isActiveSort && sortDir === 'desc' ? (
                        <ChevronDown size={14} aria-hidden="true" />
                      ) : (
                        <ChevronUp size={14} aria-hidden="true" />
                      )}
                    </span>
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody className={styles.body}>
          {sortedData.map((row, rowIdx) => (
            <tr
              key={extractRowKey(row, rowKey, rowIdx)}
              className={clsx(styles.row, onRowClick && styles.clickable)}
              onClick={() => onRowClick?.(row)}
              tabIndex={onRowClick ? 0 : undefined}
              onKeyDown={(e) => {
                if (onRowClick && (e.key === 'Enter' || e.key === ' ')) {
                  e.preventDefault();
                  onRowClick(row);
                }
              }}
            >
              {columns.map((col) => {
                const value = getCellValue(row, col.key);
                const rendered = col.render ? col.render(value, row, rowIdx) : String(value ?? '');
                return (
                  <td
                    key={col.key}
                    className={clsx(styles.cell, col.align && styles[`align${col.align.charAt(0).toUpperCase()}${col.align.slice(1)}`])}
                    style={{ width: col.width, minWidth: col.minWidth }}
                  >
                    {rendered}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
