import { useSyncExternalStore } from 'react';

// A tiny toast store (no dependency). Success toasts disappear after 5 s, errors stay until closed.
// The container is a polite live region, so screen readers announce results of actions.

export interface Toast {
  id: number;
  kind: 'success' | 'error';
  message: string;
}

let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const emit = () => {
  for (const l of listeners) l();
};

export function dismissToast(id: number): void {
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

function push(kind: Toast['kind'], message: string): void {
  const id = nextId++;
  toasts = [...toasts, { id, kind, message }];
  emit();
  if (kind === 'success') setTimeout(() => dismissToast(id), 5000);
}

export const toast = {
  success: (message: string) => push('success', message),
  error: (message: string) => push('error', message),
};

export function resetToasts(): void {
  toasts = [];
  emit();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function Toaster() {
  const items = useSyncExternalStore(subscribe, () => toasts);
  return (
    <div
      aria-live="polite"
      aria-atomic="false"
      className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex flex-col items-center gap-2 p-4 sm:items-end"
    >
      {items.map((t) => (
        <div
          key={t.id}
          role={t.kind === 'error' ? 'alert' : 'status'}
          className={`pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-md border p-3 text-sm shadow-lg bg-surface ${
            t.kind === 'error' ? 'border-danger' : 'border-success'
          }`}
        >
          <p className="flex-1">{t.message}</p>
          <button
            type="button"
            aria-label="Dismiss"
            className="-m-1 min-h-8 min-w-8 rounded p-1 text-muted-foreground hover:bg-muted"
            onClick={() => dismissToast(t.id)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
