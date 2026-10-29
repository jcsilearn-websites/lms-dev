import type { InputHTMLAttributes, ReactNode } from 'react';
import { forwardRef, useId } from 'react';
import { cn } from '../utils/cn';

export const INPUT_CLASS =
  'block min-h-11 w-full rounded-md border border-input bg-surface px-3 text-base text-foreground placeholder:text-muted-foreground sm:min-h-9 sm:text-sm aria-[invalid=true]:border-danger';

export interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  error?: string | undefined;
  hint?: string | undefined;
  /** extra element after the input (e.g. a "show password" toggle) */
  suffix?: ReactNode;
}

/**
 * A labelled input. The label is a real <label for>, the error is linked with aria-describedby and
 * announced (role="alert"), and the input is marked aria-invalid.
 */
export const Field = forwardRef<HTMLInputElement, FieldProps>(function Field(
  { label, error, hint, suffix, className, id, name, ...rest },
  ref,
) {
  const auto = useId();
  const inputId = id ?? `${name ?? 'field'}-${auto}`;
  const errorId = `${name ?? inputId}-error`;
  const hintId = `${inputId}-hint`;
  const describedBy = [error ? errorId : null, hint ? hintId : null].filter(Boolean).join(' ');
  return (
    <div className={cn('space-y-1', className)}>
      <label htmlFor={inputId} className="block text-sm font-medium">
        {label}
      </label>
      <div className="flex items-center gap-2">
        <input
          ref={ref}
          id={inputId}
          name={name}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy || undefined}
          className={INPUT_CLASS}
          {...rest}
        />
        {suffix}
      </div>
      {hint && !error && (
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
});
