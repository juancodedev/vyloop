'use client';

import { clsx } from 'clsx';
import { forwardRef, type ForwardedRef, useId } from 'react';

import styles from './Input.module.css';

export interface SelectProps extends Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'size'> {
  /** Label displayed above the select */
  label?: string;
  /** Helper text below the select */
  hint?: string;
  /** Error message (shows error state) */
  error?: string;
  /** Options to display */
  options: { value: string; label: string; disabled?: boolean }[];
  /** Placeholder option (shown when no value selected) */
  placeholder?: string;
  /** Stretches to fill parent width */
  fullWidth?: boolean;
}

function SelectInner(
  {
    label,
    hint,
    error,
    options,
    placeholder,
    fullWidth = false,
    className,
    id: externalId,
    'aria-describedby': ariaDescribedby,
    ...rest
  }: SelectProps,
  ref: ForwardedRef<HTMLSelectElement>,
) {
  const generatedId = useId();
  const selectId = externalId ?? generatedId;
  const hintId = hint ? `${selectId}-hint` : undefined;
  const errorId = error ? `${selectId}-error` : undefined;
  const describedBy = [ariaDescribedby, hintId, errorId].filter(Boolean).join(' ') || undefined;

  return (
    <div className={clsx(styles.wrapper, styles.selectWrapper, fullWidth && styles.fullWidth, className)}>
      {label && (
        <label className={styles.label} htmlFor={selectId}>
          {label}
        </label>
      )}
      <select
        ref={ref}
        id={selectId}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={clsx(
          styles.field,
          styles.select,
          error && styles.error,
        )}
        {...rest}
      >
        {placeholder && (
          <option value="" disabled>
            {placeholder}
          </option>
        )}
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
      {hint && !error && (
        <span id={hintId} className={styles.hint}>
          {hint}
        </span>
      )}
      {error && (
        <span id={errorId} className={styles.errorText} role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(SelectInner);
