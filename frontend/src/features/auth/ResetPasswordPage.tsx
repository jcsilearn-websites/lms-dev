import { Link, useSearch } from '@tanstack/react-router';
import { useState } from 'react';
import { describeError } from '../../shared/api/errors';
import { useSimpleForm } from '../../shared/forms/useSimpleForm';
import { Button } from '../../shared/ui/button';
import { Field } from '../../shared/ui/field';
import { AuthLayout } from './AuthLayout';
import { resetPassword } from './auth.api';

const loadValidator = () => import('./auth.validators').then((m) => m.validateReset);

/** The emailed link is /reset-password?token=... */
export function ResetPasswordPage() {
  const { token } = useSearch({ strict: false }) as { token?: string };
  const [done, setDone] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const form = useSimpleForm({
    initial: { token: token ?? '', newPassword: '' },
    loadValidator,
    onSubmit: async (values) => {
      setFormError(null);
      try {
        await resetPassword(values.token, values.newPassword);
        setDone(true);
      } catch (err) {
        setFormError(describeError(err));
      }
    },
  });

  if (!token) {
    return (
      <AuthLayout title="Choose a new password">
        <p role="alert" className="text-sm">
          This link is incomplete. Open the link from the email again, or{' '}
          <Link to="/forgot-password" className="text-primary underline">
            ask for a new one
          </Link>
          .
        </p>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title="Choose a new password">
      {done ? (
        <div role="status" className="space-y-4 text-sm">
          <p>Your password has been changed. You can sign in now.</p>
          <Link to="/login" className="text-primary underline">
            Go to sign in
          </Link>
        </div>
      ) : (
        <form onSubmit={form.submit} noValidate className="space-y-4">
          <Field
            label="New password"
            type="password"
            autoComplete="new-password"
            hint="At least 10 characters. Avoid common passwords."
            error={form.errors.newPassword ?? form.errors.token}
            {...form.field('newPassword')}
          />
          {formError && (
            <p role="alert" className="text-sm text-danger">
              {formError}
            </p>
          )}
          <Button type="submit" className="w-full" loading={form.submitting}>
            Change password
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}
