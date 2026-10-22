import { clsx } from 'clsx';

import styles from './ProgressBar.module.css';

export type ProgressBarColor = 'brand' | 'success' | 'warning';
export type ProgressBarSize = 'sm' | 'md' | 'lg';

export interface ProgressBarProps {
  /** Value 0–100 */
  value: number;
  /** Bar thickness */
  size?: ProgressBarSize;
  /** Fill color */
  color?: ProgressBarColor;
  /** Show percentage label on the right */
  showLabel?: boolean;
  /** Animated fill transition */
  animated?: boolean;
  className?: string;
}

export function ProgressBar({
  value,
  size = 'md',
  color = 'brand',
  showLabel = false,
  animated = false,
  className,
}: ProgressBarProps) {
  const clampedValue = Math.max(0, Math.min(100, value));

  return (
    <div
      className={clsx(styles.container, className)}
      role="progressbar"
      aria-valuenow={clampedValue}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={`${clampedValue}%`}
    >
      <div className={clsx(styles.track, styles[size])}>
        <div
          className={clsx(
            styles.fill,
            styles[color],
            animated && styles.animated,
          )}
          style={{ width: `${clampedValue}%` }}
        />
      </div>
      {showLabel && (
        <span className={styles.label}>{clampedValue}%</span>
      )}
    </div>
  );
}
