import { type FormEvent, useState } from 'react';
import { ApiError } from '../api/client';
import { describeError } from '../api/errors';
import { Button } from '../ui/button';
import { Field } from '../ui/field';

/** What a person types: a code of the authenticator app, or one of the saved recovery codes. */
export type SecondFactor = { code: string } | { recoveryCode: string };

const wait = (seconds: number) => {
  if (seconds < 90) return `${seconds} seconds`;
  if (seconds < 5400) return `${Math.ceil(seconds / 60)} minutes`;
  return `${Math.ceil(seconds / 3600)} hours`;
};

/** Words for the answers of the code routes; a lock says how long to wait. */
export function describeCodeError(err: unknown): string {
  if (err instanceof ApiError && err.code === 'mfa_locked') {
    return `Too many wrong codes. Try again in ${wait(err.retryAfterSeconds ?? 60)}.`;
  }
  return describeError(err);
}

/**
 * The one code input of the product: sign-in, step-up. It switches between the authenticator code and a recovery code;
 * `onSubmit` throws what the API answered, which is shown under the field.
 */
export function CodeForm({
  submitLabel,
  onSubmit,
  onError,
}: {
  submitLabel: string;
  onSubmit: (factor: SecondFactor) => Promise<void>;
  /** return true when the error was handled (the sign-in attempt ended, ...) */
  onError?: (err: unknown) => boolean;
}) {
  const [recovery, setRecovery] = useState(false);
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const typed = value.trim();
    const code = typed.replace(/\s/g, '');
    if (!recovery && !/^\d{6}$/.test(code)) {
      setError('Enter the 6 digits shown in your authenticator app.');
      return;
    }
    if (recovery && typed.length < 10) {
      setError('Enter a whole recovery code, for example ABCDE-12345.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit(recovery ? { recoveryCode: typed } : { code });
    } catch (err) {
      setValue('');
      if (!onError?.(err)) setError(describeCodeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      <Field
        // a new input per kind: the keyboard and autofill follow
        key={recovery ? 'recovery' : 'code'}
        label={recovery ? 'Recovery code' : 'Code from your authenticator app'}
        name="secondFactor"
        autoComplete={recovery ? 'off' : 'one-time-code'}
        inputMode={recovery ? 'text' : 'numeric'}
        autoCapitalize={recovery ? 'characters' : 'off'}
        spellCheck={false}
        maxLength={recovery ? 24 : 7}
        autoFocus
        value={value}
        error={error ?? undefined}
        onChange={(e) => setValue(e.target.value)}
      />
      <Button type="submit" className="w-full" loading={busy}>
        {submitLabel}
      </Button>
      <p className="text-center text-sm">
        <button
          type="button"
          className="min-h-11 text-primary underline"
          onClick={() => {
            setRecovery(!recovery);
            setValue('');
            setError(null);
          }}
        >
          {recovery ? 'Use the authenticator app instead' : 'Use a recovery code instead'}
        </button>
      </p>
    </form>
  );
}
