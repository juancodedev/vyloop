import clsx from 'clsx';
import { type CSSProperties } from 'react';

import styles from './Skeleton.module.css';

export type SkeletonVariant = 'text' | 'circular' | 'rectangular';

export interface SkeletonProps {
  /** Shape variant */
  variant?: SkeletonVariant;
  /** Custom width (CSS value) */
  width?: string | number;
  /** Custom height (CSS value) */
  height?: string | number;
  /** Repeat count for text lines (only applies to 'text' variant) */
  count?: number;
  className?: string;
}

export function Skeleton({
  variant = 'text',
  width,
  height,
  count,
  className,
}: SkeletonProps) {
  const style: CSSProperties = {
    ...(width !== undefined ? { width: typeof width === 'number' ? `${width}px` : width } : {}),
    ...(height !== undefined ? { height: typeof height === 'number' ? `${height}px` : height } : {}),
  };

  // For text with count, render multiple lines
  if (variant === 'text' && count && count > 1) {
    const items = Array.from({ length: count }, (_, i) => i);
    return (
      <div className={styles.group} role="status" aria-label="Loading">
        {items.map((i) => (
          <div
            key={i}
            className={clsx(styles.base, styles.text, i === count - 1 && styles.lastLine, className)}
            style={
              width !== undefined
                ? style
                : i === count - 1
                  ? { width }
                  : undefined
            }
          />
        ))}
      </div>
    );
  }

  return (
    <div
      className={clsx(styles.base, styles[variant], className)}
      style={style}
      role="status"
      aria-label="Loading"
    />
  );
}
