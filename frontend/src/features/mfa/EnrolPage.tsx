import type { MfaEnrolConfirmResponse, MfaEnrolStartResponse } from '@lms/backend/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { type FormEvent, useState } from 'react';
import { ApiError } from '../../shared/api/client';
import { describeError } from '../../shared/api/errors';
import { Button } from '../../shared/ui/button';
import { Field } from '../../shared/ui/field';
import { AuthLayout } from '../auth/AuthLayout';
import { forgetMe, meKey } from '../auth/auth.api';
import { AuthenticatorSetup } from './AuthenticatorSetup';
import { confirmEnrolment, startEnrolment } from './mfa.api';
import { RecoveryCodes } from './RecoveryCodes';

type Stage =
  | { name: 'password' }
  | { name: 'app'; setup: MfaEnrolStartResponse }
  | { name: 'codes'; result: MfaEnrolConfirmResponse }
  | { name: 'ended' };

/**
 * The page behind the e-mailed link (/mfa/enrol?token=...). It works whether or not this browser is signed in: the link
 * AND the password are the authority, and confirming replaces whatever session the browser had.
 */
export function EnrolPage() {
  const { token } = useSearch({ strict: false }) as { token?: string };
  const [stage, setStage] = useState<Stage>({ name: 'password' });
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const title = 'Set up two-step sign-in';

  if (!token || stage.name === 'ended') {
    return (
      <AuthLayout title={title}>
        <p role="alert" className="text-sm">
          {token
            ? 'This setup has ended: the link was used, replaced or is too old. '
            : 'This link is incomplete. '}
          <Link to="/login" className="text-primary underline">
            Sign in
          </Link>{' '}
          to get a new one.
        </p>
      </AuthLayout>
    );
  }

  const start = async (e: FormEvent) => {
    e.preventDefault();
    if (!password) {
      setError('Enter your password.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setStage({ name: 'app', setup: await startEnrolment(token, password) });
      setPassword('');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'invalid_or_expired_token') {
        setStage({ name: 'ended' });
      } else {
        setError(describeError(err));
      }
    } finally {
      setBusy(false);
    }
  };

  const finish = async (result: MfaEnrolConfirmResponse) => {
    // whatever this browser held belonged to another sign-in
    forgetMe();
    qc.clear();
    qc.setQueryData(meKey, result.me);
    await navigate({ to: '/', replace: true });
  };

  return (
    <AuthLayout title={title}>
      {stage.name === 'password' && (
        <form onSubmit={start} noValidate className="space-y-4">
          <p className="text-sm">Enter your password to continue.</p>
          <Field
            label="Password"
            name="password"
            type="password"
            autoComplete="current-password"
            value={password}
            error={error ?? undefined}
            onChange={(e) => setPassword(e.target.value)}
          />
          <Button type="submit" className="w-full" loading={busy}>
            Continue
          </Button>
        </form>
      )}
      {stage.name === 'app' && (
        <AuthenticatorSetup
          setup={stage.setup}
          onConfirm={async (code) => {
            setStage({ name: 'codes', result: await confirmEnrolment(code) });
          }}
          onError={(err) => {
            if (err instanceof ApiError && err.code === 'mfa_challenge_invalid') {
              setStage({ name: 'ended' });
              return true;
            }
            return false;
          }}
        />
      )}
      {stage.name === 'codes' && (
        <RecoveryCodes
          codes={stage.result.recoveryCodes}
          doneLabel="Continue"
          onDone={() => void finish(stage.result)}
        />
      )}
    </AuthLayout>
  );
}
