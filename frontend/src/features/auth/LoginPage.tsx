import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { useState } from 'react';
import { describeError } from '../../shared/api/errors';
import { useSimpleForm } from '../../shared/forms/useSimpleForm';
import { Button } from '../../shared/ui/button';
import { Field } from '../../shared/ui/field';
import { safeRedirect } from '../../shared/utils/redirect';
import { AuthLayout } from './AuthLayout';
import { login, meKey } from './auth.api';

const loadValidator = () => import('./auth.validators').then((m) => m.validateLogin);

export function LoginPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { redirect?: unknown };
  const [formError, setFormError] = useState<string | null>(null);

  const form = useSimpleForm({
    initial: { email: '', password: '' },
    loadValidator,
    onSubmit: async (values) => {
      setFormError(null);
      try {
        const me = await login(values);
        qc.setQueryData(meKey, me);
        await navigate({ to: safeRedirect(search.redirect) ?? '/', replace: true });
      } catch (err) {
        setFormError(describeError(err));
      }
    },
  });

  return (
    <AuthLayout title="Sign in">
      <form onSubmit={form.submit} noValidate className="space-y-4">
        <Field
          label="Email"
          type="email"
          autoComplete="username"
          inputMode="email"
          error={form.errors.email}
          {...form.field('email')}
        />
        <Field
          label="Password"
          type="password"
          autoComplete="current-password"
          error={form.errors.password}
          {...form.field('password')}
        />
        {formError && (
          <p role="alert" className="text-sm text-danger">
            {formError}
          </p>
        )}
        <Button type="submit" className="w-full" loading={form.submitting}>
          Sign in
        </Button>
        <p className="text-center text-sm">
          <Link to="/forgot-password" className="text-primary underline">
            Forgot your password?
          </Link>
        </p>
      </form>
    </AuthLayout>
  );
}
