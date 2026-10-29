import { UpdateBrandingRequestSchema } from '@lms/backend/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { describeError } from '../../shared/api/errors';
import { typeboxResolver } from '../../shared/forms/validation';
import { Button } from '../../shared/ui/button';
import { Field } from '../../shared/ui/field';
import { Card, PageHeader } from '../../shared/ui/layout';
import { ErrorState, Skeleton } from '../../shared/ui/states';
import { toast } from '../../shared/ui/toast';
import { brandColors, isHexColor } from '../../shared/utils/color';
import { tenantInfoKey, updateBranding } from '../tenant/tenant.api';
import { useTenantInfo } from '../tenant/useTenantInfo';

interface Values {
  displayName: string;
  primaryColor: string;
}

/** College settings: today only the branding (name and colour). Logos come with file storage. */
export function SettingsPage() {
  const qc = useQueryClient();
  const info = useTenantInfo();
  const form = useForm<Values>({
    values: {
      displayName: info.data?.displayName ?? '',
      primaryColor: info.data?.primaryColor ?? '#2563eb',
    },
    resolver: typeboxResolver<Values>(UpdateBrandingRequestSchema, {
      displayName: 'Display name',
      primaryColor: 'Primary colour',
    }),
  });
  const color = form.watch('primaryColor');
  const colors = isHexColor(color) ? brandColors(color) : null;

  const save = useMutation({
    mutationFn: (v: Values) =>
      updateBranding({
        displayName: v.displayName.trim(),
        primaryColor: v.primaryColor.toLowerCase(),
      }),
    onSuccess: (saved) => {
      // the root layout reads this cache entry: the new colour and name apply at once
      qc.setQueryData(tenantInfoKey, saved);
      toast.success('Branding saved.');
    },
    onError: (err) => toast.error(describeError(err)),
  });
  const { errors } = form.formState;

  return (
    <div className="max-w-xl">
      <PageHeader
        title="College settings"
        description="How your college looks to everyone who signs in."
      />
      <Card title="Branding">
        {info.isPending ? (
          <Skeleton className="h-40 w-full" />
        ) : info.isError ? (
          <ErrorState error={info.error} onRetry={() => void info.refetch()} />
        ) : (
          <form
            onSubmit={form.handleSubmit((v) => save.mutate(v))}
            noValidate
            className="space-y-4"
          >
            <Field
              label="Display name"
              hint="Shown at the top of every page and on the sign-in screen."
              error={errors.displayName?.message}
              {...form.register('displayName')}
            />
            <div className="flex items-end gap-3">
              <Field
                label="Primary colour"
                hint="A hex colour such as #2563eb."
                error={errors.primaryColor?.message}
                className="flex-1"
                {...form.register('primaryColor')}
              />
              <input
                type="color"
                aria-label="Pick the primary colour"
                className="mb-1 h-11 w-14 cursor-pointer rounded border border-input bg-surface p-1 sm:h-9"
                value={isHexColor(color) ? color.toLowerCase() : '#2563eb'}
                onChange={(e) =>
                  form.setValue('primaryColor', e.target.value, {
                    shouldValidate: true,
                    shouldDirty: true,
                  })
                }
              />
            </div>
            {colors && (colors.light.fellBack || colors.dark.fellBack) && (
              <p role="status" className="text-sm text-warning">
                {colors.light.fellBack && colors.dark.fellBack
                  ? 'This colour is hard to read in both light and dark mode, so the default blue is used instead.'
                  : colors.light.fellBack
                    ? 'This colour is too light to read on the light theme: the default blue is used there.'
                    : 'This colour is too dark to read on the dark theme: a default light blue is used there.'}
              </p>
            )}
            <Button type="submit" loading={save.isPending}>
              Save branding
            </Button>
          </form>
        )}
      </Card>
    </div>
  );
}
