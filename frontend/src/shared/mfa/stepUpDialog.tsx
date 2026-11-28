import type { MfaStepUpResponse } from '@lms/backend/contracts';
import { useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { api } from '../api/client';
import { Button } from '../ui/button';
import { Dialog } from '../ui/dialog';
import { CodeForm } from './CodeForm';

// THE STEP-UP DIALOG (docs/adr/0026-mfa.md): a sensitive request answered 403 `mfa_step_up_required`; the person proves their
// second factor again and the API client repeats the request. A lazy chunk of its own, in its own React root: it opens over
// whatever asked for it (also over a confirm dialog) without any page having to know about it.

function StepUpDialog({ onDone }: { onDone: (verified: boolean) => void }) {
  // closing the dialog after a success also fires its close event: the first answer counts
  const answered = useRef(false);
  const done = (verified: boolean) => {
    if (answered.current) return;
    answered.current = true;
    onDone(verified);
  };
  return (
    <Dialog open onClose={() => done(false)} title="Confirm it is you">
      <p className="text-sm text-muted-foreground">
        This action asks for your second step again. You will not be asked for the next 10 minutes.
      </p>
      <CodeForm
        submitLabel="Confirm and continue"
        onSubmit={async (factor) => {
          await api<MfaStepUpResponse>('/me/mfa/step-up', { method: 'POST', body: factor });
          done(true);
        }}
      />
      <div className="flex justify-end">
        <Button variant="secondary" onClick={() => done(false)}>
          Not now
        </Button>
      </div>
    </Dialog>
  );
}

let pending: Promise<boolean> | null = null;

/** Asks once, however many requests are waiting. true = verified: the caller repeats its request. */
export function askStepUp(): Promise<boolean> {
  pending ??= new Promise<boolean>((resolve) => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host, { identifierPrefix: 'step-up-' });
    root.render(
      <StepUpDialog
        onDone={(verified) => {
          pending = null;
          // after the current event: a root cannot be unmounted while it is rendering
          setTimeout(() => {
            root.unmount();
            host.remove();
          }, 0);
          resolve(verified);
        }}
      />,
    );
  });
  return pending;
}
