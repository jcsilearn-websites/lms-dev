import type { MeResponse } from '@lms/backend/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { lazy, Suspense, useState } from 'react';
import { describeError } from '../../shared/api/errors';
import { useSimpleForm } from '../../shared/forms/useSimpleForm';
import { Button } from '../../shared/ui/button';
import { Field } from '../../shared/ui/field';
import { safeRedirect } from '../../shared/utils/redirect';
import { AuthLayout } from './AuthLayout';
import { login, meKey } from './auth.api';

const loadValidator = () => import('./auth.validators').then((m) => m.validateLogin);
// the second step is a chunk of its own: only a person who is asked for it loads it
const MfaChallengeStep = lazy(() =>
  import('../mfa/MfaChallengeStep').then((m) => ({ default: m.MfaChallengeStep })),
);

export function LoginPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { redirect?: unknown };
  const [formError, setFormError] = useState<string | null>(null);
  const [second, setSecond] = useState<'totp' | 'enrol_email' | null>(null);

  const signedIn = async (me: MeResponse) => {
    qc.setQueryData(meKey, me);
    await navigate({ to: safeRedirect(search.redirect) ?? '/', replace: true });
  };

  const form = useSimpleForm({
    initial: { email: '', password: '' },
    loadValidator,
    onSubmit: async (values) => {
      setFormError(null);
      try {
        const result = await login(values);
        if ('step' in result) setSecond(result.step);
        else await signedIn(result);
      } catch (err) {
        setFormError(describeError(err));
      }
    },
  });

  if (second) {
    return (
      <AuthLayout title={second === 'totp' ? 'Two-step sign-in' : 'Check your email'}>
        <Suspense fallback={<p role="status">Loading…</p>}>
          <MfaChallengeStep
            step={second}
            email={form.values.email.trim()}
            onSignedIn={signedIn}
            onRestart={() => setSecond(null)}
          />
        </Suspense>
      </AuthLayout>
    );
  }

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
