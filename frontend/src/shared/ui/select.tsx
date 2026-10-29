import { forwardRef, type ReactNode, type SelectHTMLAttributes, useId } from 'react';
import { cn } from '../utils/cn';
import { INPUT_CLASS } from './field';

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label: string;
  error?: string | undefined;
  hint?: string | undefined;
  /** Visually hide the label (still read by screen readers), e.g. in a filter bar. */
  hideLabel?: boolean;
  children: ReactNode;
}

/** A native <select> (accessible on every device, including the phone pickers) with a real label. */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { label, error, hint, hideLabel, className, id, name, children, ...rest },
  ref,
) {
  const auto = useId();
  const selectId = id ?? `${name ?? 'select'}-${auto}`;
  const errorId = `${selectId}-error`;
  const hintId = `${selectId}-hint`;
  const describedBy = [error ? errorId : null, hint ? hintId : null].filter(Boolean).join(' ');
  return (
    <div className={cn('space-y-1', className)}>
      <label htmlFor={selectId} className={cn('block text-sm font-medium', hideLabel && 'sr-only')}>
        {label}
      </label>
      <select
        ref={ref}
        id={selectId}
        name={name}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
        className={INPUT_CLASS}
        {...rest}
      >
        {children}
      </select>
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
