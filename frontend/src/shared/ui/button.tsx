import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from '../utils/cn';
import { Spinner } from './spinner';

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';

const VARIANTS: Record<Variant, string> = {
  // hover darkens the colour instead of using opacity: opacity lets the page show through and
  // lowered the contrast of white-on-blue below WCAG AA (4.31:1) in the hover state
  primary:
    'bg-primary text-primary-foreground hover:bg-[color-mix(in_srgb,var(--primary),black_10%)]',
  secondary: 'border border-input bg-surface text-foreground hover:bg-muted',
  danger: 'bg-danger text-danger-foreground hover:bg-[color-mix(in_srgb,var(--danger),black_10%)]',
  ghost: 'text-foreground hover:bg-muted',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  loading?: boolean;
  children: ReactNode;
}

/** 44px minimum touch target on phones (WCAG 2.5.5 is AAA; we follow it for students on phones). */
export function Button({
  variant = 'primary',
  loading = false,
  disabled,
  className,
  children,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        'inline-flex min-h-11 items-center justify-center gap-2 rounded-md px-4 text-sm font-medium disabled:opacity-60 sm:min-h-9',
        VARIANTS[variant],
        className,
      )}
      {...rest}
    >
      {loading && <Spinner />}
      {children}
    </button>
  );
}
