'use client';

import clsx from 'clsx';
import { useCallback, useRef, type KeyboardEvent, type ReactNode } from 'react';

import styles from './Tabs.module.css';

// ── Types ──

export type TabsVariant = 'underline' | 'pills';

export interface Tab {
  id: string;
  label: string;
  /** Optional badge number or short text */
  badge?: string | number;
}

export interface TabsProps {
  /** Visual variant */
  variant?: TabsVariant;
  /** Tab definitions */
  tabs: Tab[];
  /** Currently active tab id */
  activeTab: string;
  /** Tab change handler */
  onChange: (tabId: string) => void;
  className?: string;
}

export interface TabPanelProps {
  /** Should match the id of the Tab this panel belongs to */
  id: string;
  /** Active state (render hidden when inactive) */
  active?: boolean;
  children?: ReactNode;
  className?: string;
}

// ── Component ──

export function Tabs({
  variant = 'underline',
  tabs,
  activeTab,
  onChange,
  className,
}: TabsProps) {
  const tablistRef = useRef<HTMLDivElement>(null);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      const currentIdx = tabs.findIndex((t) => t.id === activeTab);
      let nextIdx: number | null = null;

      switch (e.key) {
        case 'ArrowRight':
          e.preventDefault();
          nextIdx = (currentIdx + 1) % tabs.length;
          break;
        case 'ArrowLeft':
          e.preventDefault();
          nextIdx = (currentIdx - 1 + tabs.length) % tabs.length;
          break;
        case 'Home':
          e.preventDefault();
          nextIdx = 0;
          break;
        case 'End':
          e.preventDefault();
          nextIdx = tabs.length - 1;
          break;
      }

      if (nextIdx !== null && tabs[nextIdx]) {
        onChange(tabs[nextIdx].id);
        // Focus the newly selected tab button
        const buttons = tablistRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
        buttons?.[nextIdx]?.focus();
      }
    },
    [tabs, activeTab, onChange],
  );

  const handleClick = useCallback(
    (tabId: string) => {
      onChange(tabId);
    },
    [onChange],
  );

  return (
    <div
      ref={tablistRef}
      role="tablist"
      className={clsx(styles.tablist, styles[variant], className)}
      onKeyDown={handleKeyDown}
    >
      {tabs.map((tab) => (
        <button
          key={tab.id}
          role="tab"
          id={`tab-${tab.id}`}
          aria-selected={tab.id === activeTab}
          aria-controls={`tabpanel-${tab.id}`}
          tabIndex={tab.id === activeTab ? 0 : -1}
          className={clsx(styles.tab, tab.id === activeTab && styles.active)}
          onClick={() => handleClick(tab.id)}
        >
          {tab.label}
          {tab.badge !== undefined && (
            <span className={styles.badge}>{tab.badge}</span>
          )}
        </button>
      ))}
    </div>
  );
}

// ── TabPanel ──

export function TabPanel({ id, active, children, className }: TabPanelProps) {
  return (
    <div
      role="tabpanel"
      id={`tabpanel-${id}`}
      aria-labelledby={`tab-${id}`}
      hidden={!active}
      className={className}
    >
      {active && children}
    </div>
  );
}
