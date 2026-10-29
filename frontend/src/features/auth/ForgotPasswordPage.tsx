import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { describeError } from '../../shared/api/errors';
import { useSimpleForm } from '../../shared/forms/useSimpleForm';
import { Button } from '../../shared/ui/button';
import { Field } from '../../shared/ui/field';
import { AuthLayout } from './AuthLayout';
import { forgotPassword } from './auth.api';

const loadValidator = () => import('./auth.validators').then((m) => m.validateForgot);

export function ForgotPasswordPage() {
  const [sent, setSent] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const form = useSimpleForm({
    initial: { email: '' },
    loadValidator,
    onSubmit: async ({ email }) => {
      setFormError(null);
      try {
        await forgotPassword(email);
        setSent(true);
      } catch (err) {
        setFormError(describeError(err));
      }
    },
  });

  return (
    <AuthLayout title="Reset your password">
      {sent ? (
        <div role="status" className="space-y-4 text-sm">
          <p>
            If there is an account for that email, we have sent a link to choose a new password. It
            works for 30 minutes.
          </p>
          <Link to="/login" className="text-primary underline">
            Back to sign in
          </Link>
        </div>
      ) : (
        <form onSubmit={form.submit} noValidate className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Enter your email and we will send you a link to choose a new password.
          </p>
          <Field
            label="Email"
            type="email"
            autoComplete="username"
            inputMode="email"
            error={form.errors.email}
            {...form.field('email')}
          />
          {formError && (
            <p role="alert" className="text-sm text-danger">
              {formError}
            </p>
          )}
          <Button type="submit" className="w-full" loading={form.submitting}>
            Send the link
          </Button>
          <p className="text-center text-sm">
            <Link to="/login" className="text-primary underline">
              Back to sign in
            </Link>
          </p>
        </form>
      )}
    </AuthLayout>
  );
}
