import clsx from 'clsx';
import { forwardRef, type ForwardedRef, useId } from 'react';

import styles from './Input.module.css';

export interface TextareaProps extends Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'size'> {
  /** Label displayed above the textarea */
  label?: string;
  /** Helper text below the textarea */
  hint?: string;
  /** Error message (shows error state) */
  error?: string;
  /** Stretches to fill parent width */
  fullWidth?: boolean;
  /** Fixed rows (default: 3) */
  rows?: number;
  /** Resize behavior */
  resize?: 'none' | 'vertical' | 'horizontal' | 'both';
}

function TextareaInner(
  {
    label,
    hint,
    error,
    fullWidth = false,
    rows = 3,
    resize = 'vertical',
    className,
    id: externalId,
    'aria-describedby': ariaDescribedby,
    ...rest
  }: TextareaProps,
  ref: ForwardedRef<HTMLTextAreaElement>,
) {
  const generatedId = useId();
  const textareaId = externalId ?? generatedId;
  const hintId = hint ? `${textareaId}-hint` : undefined;
  const errorId = error ? `${textareaId}-error` : undefined;
  const describedBy = [ariaDescribedby, hintId, errorId].filter(Boolean).join(' ') || undefined;

  return (
    <div className={clsx(styles.wrapper, styles.textareaWrapper, fullWidth && styles.fullWidth, className)}>
      {label && (
        <label className={styles.label} htmlFor={textareaId}>
          {label}
        </label>
      )}
      <textarea
        ref={ref}
        id={textareaId}
        rows={rows}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={clsx(
          styles.field,
          styles.textarea,
          error && styles.error,
          resize === 'none' && styles.resizeNone,
          resize === 'horizontal' && styles.resizeHorizontal,
          resize === 'both' && styles.resizeBoth,
        )}
        {...rest}
      />
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

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(TextareaInner);
