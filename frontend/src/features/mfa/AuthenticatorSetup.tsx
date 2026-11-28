import type { MfaEnrolStartResponse } from '@lms/backend/contracts';
import { type FormEvent, useState } from 'react';
import { describeCodeError } from '../../shared/mfa/CodeForm';
import { Button } from '../../shared/ui/button';
import { Field } from '../../shared/ui/field';
import { QrCode } from './QrCode';

/**
 * Adding an authenticator app: scan (or open the link, or type the key), then prove it with the first code. Used by the
 * enrolment page and by "replace authenticator". `onConfirm` throws what the API answered.
 */
export function AuthenticatorSetup({
  setup,
  onConfirm,
  onError,
}: {
  setup: MfaEnrolStartResponse;
  onConfirm: (code: string) => Promise<void>;
  onError?: (err: unknown) => boolean;
}) {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const digits = code.replace(/\s/g, '');
    if (!/^\d{6}$/.test(digits)) {
      setError('Enter the 6 digits shown in your authenticator app.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onConfirm(digits);
    } catch (err) {
      setCode('');
      if (!onError?.(err)) setError(describeCodeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <ol className="list-decimal space-y-1 pl-5 text-sm">
        <li>Open an authenticator app on your phone.</li>
        <li>Add an account by scanning this code.</li>
        <li>Enter the 6 digits the app shows.</li>
      </ol>
      <QrCode text={setup.otpauthUri} label="QR code for your authenticator app" />
      <details className="text-sm">
        <summary className="min-h-11 cursor-pointer py-2 text-primary underline">
          Cannot scan the code?
        </summary>
        <p className="text-muted-foreground">Type this key into the app (time based):</p>
        <p className="mt-1 select-all break-all rounded-md border border-border p-2 font-mono">
          <span data-testid="totp-secret">{setup.secret}</span>
        </p>
        <p className="mt-2">
          <a href={setup.otpauthUri} className="text-primary underline">
            Open in an authenticator app on this device
          </a>
        </p>
      </details>
      <form onSubmit={submit} noValidate className="space-y-4">
        <Field
          label="Code from your authenticator app"
          name="totp"
          autoComplete="one-time-code"
          inputMode="numeric"
          maxLength={7}
          value={code}
          error={error ?? undefined}
          onChange={(e) => setCode(e.target.value)}
        />
        <Button type="submit" className="w-full" loading={busy}>
          Confirm
        </Button>
      </form>
    </div>
  );
}
