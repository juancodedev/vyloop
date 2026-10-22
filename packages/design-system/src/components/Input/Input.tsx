import { clsx } from 'clsx';
import { forwardRef, type ForwardedRef, useId } from 'react';

import styles from './Input.module.css';

export interface InputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size'> {
  /** Label displayed above the input */
  label?: string;
  /** Helper text below the input */
  hint?: string;
  /** Error message (shows error state) */
  error?: string;
  /** Icon slot on the left side */
  leftIcon?: React.ReactNode;
  /** Stretches to fill parent width */
  fullWidth?: boolean;
}

function InputInner(
  {
    label,
    hint,
    error,
    leftIcon,
    fullWidth = false,
    className,
    id: externalId,
    'aria-describedby': ariaDescribedby,
    ...rest
  }: InputProps,
  ref: ForwardedRef<HTMLInputElement>,
) {
  const generatedId = useId();
  const inputId = externalId ?? generatedId;
  const hintId = hint ? `${inputId}-hint` : undefined;
  const errorId = error ? `${inputId}-error` : undefined;
  const describedBy = [ariaDescribedby, hintId, errorId].filter(Boolean).join(' ') || undefined;

  return (
    <div className={clsx(styles.wrapper, fullWidth && styles.fullWidth, className)}>
      {label && (
        <label className={styles.label} htmlFor={inputId}>
          {label}
        </label>
      )}
      <div
        className={clsx(
          styles.field,
          error && styles.error,
          rest.disabled && styles.disabled,
        )}
      >
        {leftIcon && (
          <span className={styles.iconSlot} aria-hidden="true">
            {leftIcon}
          </span>
        )}
        <input
          ref={ref}
          id={inputId}
          className={styles.nativeInput}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          {...rest}
        />
      </div>
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

export const Input = forwardRef<HTMLInputElement, InputProps>(InputInner);
