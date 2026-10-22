import { clsx } from 'clsx';
import { type ReactNode } from 'react';

import styles from './Badge.module.css';

export type BadgeVariant = 'default' | 'success' | 'warning' | 'error' | 'info';
export type BadgeSize = 'sm' | 'md';

export interface BadgeProps {
  /** Visual style variant */
  variant?: BadgeVariant;
  /** Size preset */
  size?: BadgeSize;
  /** Shows a colored dot indicator before text */
  dot?: boolean;
  children: ReactNode;
  className?: string;
  /** Additional props for the wrapper span */
  [key: string]: unknown;
}

export function Badge({
  variant = 'default',
  size = 'md',
  dot = false,
  children,
  className,
  ...rest
}: BadgeProps) {
  return (
    <span
      className={clsx(
        styles.base,
        styles[variant],
        styles[size],
        className,
      )}
      {...rest}
    >
      {dot && (
        <span
          className={clsx(styles.dot, styles[`${variant}Dot`])}
          aria-hidden="true"
        />
      )}
      {children}
    </span>
  );
}
