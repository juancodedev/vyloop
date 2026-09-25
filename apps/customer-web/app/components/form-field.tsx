import type { ChangeEventHandler, InputHTMLAttributes, Ref } from 'react';

interface FormFieldProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'id' | 'name' | 'value' | 'onChange'
> {
  id: string;
  name: string;
  label: string;
  value: string;
  onChange: ChangeEventHandler<HTMLInputElement>;
  helperText?: string | undefined;
  error?: string | undefined;
  inputRef?: Ref<HTMLInputElement> | undefined;
}

export function FormField({
  id,
  name,
  label,
  value,
  onChange,
  helperText,
  error,
  inputRef,
  className,
  required,
  ...inputProps
}: FormFieldProps) {
  const helperId = helperText ? `${id}-helper` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [helperId, errorId].filter(Boolean).join(' ') || undefined;

  return (
    <div className="field club-register__field">
      <label className="label" htmlFor={id}>
        {label}
        {required ? <span aria-hidden="true"> *</span> : null}
      </label>
      <input
        {...inputProps}
        ref={inputRef}
        id={id}
        name={name}
        value={value}
        onChange={onChange}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={className ? `input ${className}` : 'input'}
      />
      {helperText ? (
        <span className="club-register__helper" id={helperId}>
          {helperText}
        </span>
      ) : null}
      {error ? (
        <span className="error-text" id={errorId} role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}
