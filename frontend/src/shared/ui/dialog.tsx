import { type ReactNode, useEffect, useRef } from 'react';
import { Button } from './button';

// Dialogs use the native <dialog> element opened with showModal(): the browser provides the focus
// trap, Escape to close, the backdrop, aria-modal and returning focus to the opener. No library.

export function Dialog({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);
  return (
    // Escape closes the dialog natively; the click handler is only a mouse convenience (backdrop).
    // biome-ignore lint/a11y/useKeyWithClickEvents: <dialog> handles the keyboard itself
    <dialog
      ref={ref}
      aria-labelledby="dialog-title"
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose(); // click on the backdrop
      }}
      className="m-auto w-[min(32rem,calc(100vw-2rem))] rounded-md border border-border bg-surface p-0 text-foreground"
    >
      {open && (
        <div className="space-y-4 p-5">
          <h2 id="dialog-title" className="text-lg font-semibold">
            {title}
          </h2>
          {children}
        </div>
      )}
    </dialog>
  );
}

/** Confirmation for a destructive action. The title and the confirm button NAME the target. */
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel,
  pending = false,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  pending?: boolean;
}) {
  return (
    <Dialog open={open} onClose={onClose} title={title}>
      <div className="text-sm text-muted-foreground">{description}</div>
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button variant="secondary" onClick={onClose} disabled={pending}>
          Cancel
        </Button>
        <Button variant="danger" onClick={onConfirm} loading={pending}>
          {confirmLabel}
        </Button>
      </div>
    </Dialog>
  );
}
