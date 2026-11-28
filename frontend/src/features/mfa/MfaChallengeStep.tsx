import type { MeResponse } from '@lms/backend/contracts';
import { useState } from 'react';
import { ApiError } from '../../shared/api/client';
import { CodeForm } from '../../shared/mfa/CodeForm';
import { Button } from '../../shared/ui/button';
import { verifySecondFactor } from './mfa.api';

/**
 * The second step of a sign-in, on the login page after the password: either the code (the challenge cookie is set), or "a
 * link was e-mailed" for a person who has to set two-step sign-in up first.
 */
export function MfaChallengeStep({
  step,
  email,
  onSignedIn,
  onRestart,
}: {
  step: 'totp' | 'enrol_email';
  email: string;
  onSignedIn: (me: MeResponse) => Promise<void>;
  onRestart: () => void;
}) {
  const [ended, setEnded] = useState(false);

  if (step === 'enrol_email') {
    return (
      <div className="space-y-4 text-sm">
        <p role="status">
          Your account needs two-step sign-in, and it is not set up yet. We sent a link to{' '}
          <strong className="break-all">{email}</strong>.
        </p>
        <p>
          Open the link within 30 minutes. You will be asked for your password again, and then to
          add an authenticator app on your phone.
        </p>
        <Button variant="secondary" className="w-full" onClick={onRestart}>
          Back to sign in
        </Button>
      </div>
    );
  }

  if (ended) {
    return (
      <div className="space-y-4 text-sm">
        <p role="alert">This sign-in attempt has ended. Sign in with your password again.</p>
        <Button className="w-full" onClick={onRestart}>
          Start again
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">Your password was right. One more step.</p>
      <CodeForm
        submitLabel="Sign in"
        onSubmit={async (factor) => {
          await onSignedIn(await verifySecondFactor(factor));
        }}
        onError={(err) => {
          if (err instanceof ApiError && err.code === 'mfa_challenge_invalid') {
            setEnded(true);
            return true;
          }
          return false;
        }}
      />
      <p className="text-center text-sm">
        <button type="button" className="min-h-11 text-primary underline" onClick={onRestart}>
          Back to sign in
        </button>
      </p>
    </div>
  );
}
