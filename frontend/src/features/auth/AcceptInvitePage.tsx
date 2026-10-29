import { Link, useSearch } from '@tanstack/react-router';
import { useState } from 'react';
import { ApiError } from '../../shared/api/client';
import { describeError } from '../../shared/api/errors';
import { useSimpleForm } from '../../shared/forms/useSimpleForm';
import { Button } from '../../shared/ui/button';
import { Field } from '../../shared/ui/field';
import { AuthLayout } from './AuthLayout';
import { acceptInvite } from './auth.api';

const loadValidator = () => import('./auth.validators').then((m) => m.validateAccept);

/** The emailed link is /accept-invite?token=... A new person chooses a password; an existing one just accepts. */
export function AcceptInvitePage() {
  const { token } = useSearch({ strict: false }) as { token?: string };
  const [done, setDone] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [needsPassword, setNeedsPassword] = useState(false);
  const form = useSimpleForm({
    initial: { token: token ?? '', password: '' },
    loadValidator,
    onSubmit: async (values) => {
      setFormError(null);
      try {
        await acceptInvite(values.token, values.password || undefined);
        setDone(true);
      } catch (err) {
        if (err instanceof ApiError && err.code === 'password_required') setNeedsPassword(true);
        setFormError(describeError(err));
      }
    },
  });

  if (!token) {
    return (
      <AuthLayout title="Accept your invitation">
        <p role="alert" className="text-sm">
          This link is incomplete. Open the link from your invitation email again.
        </p>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title="Accept your invitation">
      {done ? (
        <div role="status" className="space-y-4 text-sm">
          <p>Your invitation is accepted. You can sign in now.</p>
          <Link to="/login" className="text-primary underline">
            Go to sign in
          </Link>
        </div>
      ) : (
        <form onSubmit={form.submit} noValidate className="space-y-4">
          <Field
            label="Choose a password"
            type="password"
            autoComplete="new-password"
            hint={
              needsPassword
                ? 'At least 10 characters.'
                : 'If you already have an account here, leave this empty. Otherwise choose one (at least 10 characters).'
            }
            error={form.errors.password}
            {...form.field('password')}
          />
          {formError && (
            <p role="alert" className="text-sm text-danger">
              {formError}
            </p>
          )}
          <Button type="submit" className="w-full" loading={form.submitting}>
            Accept invitation
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}
