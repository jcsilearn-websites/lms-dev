import type { MfaEnrolStartResponse, MfaStatus } from '@lms/backend/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { describeError } from '../../shared/api/errors';
import { Button } from '../../shared/ui/button';
import { ConfirmDialog } from '../../shared/ui/dialog';
import { Badge, Card, PageHeader } from '../../shared/ui/layout';
import { ErrorState, Skeleton } from '../../shared/ui/states';
import { toast } from '../../shared/ui/toast';
import { AuthenticatorSetup } from './AuthenticatorSetup';
import {
  confirmReplacement,
  disableMfa,
  getMfaStatus,
  mfaKeys,
  newRecoveryCodes,
  startReplacement,
} from './mfa.api';
import { RecoveryCodes } from './RecoveryCodes';

/**
 * My two-step sign-in: status, a new authenticator app, new recovery codes, and turning it off where no role needs it. Every
 * change asks for a step-up (the API client opens that dialog by itself).
 */
export function SecurityPage() {
  const status = useQuery({
    queryKey: mfaKeys.status,
    queryFn: ({ signal }) => getMfaStatus(signal),
  });
  return (
    <div className="max-w-xl space-y-6">
      <PageHeader title="Sign-in security" description="Two-step sign-in for your account" />
      {status.isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : status.isError ? (
        <ErrorState error={status.error} onRetry={() => void status.refetch()} />
      ) : (
        <TwoStep status={status.data} />
      )}
    </div>
  );
}

function TwoStep({ status }: { status: MfaStatus }) {
  const qc = useQueryClient();
  const [setup, setSetup] = useState<MfaEnrolStartResponse | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [confirm, setConfirm] = useState<'codes' | 'disable' | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: mfaKeys.status });
  const fail = (err: unknown) => {
    setConfirm(null);
    toast.error(describeError(err));
  };

  const replace = useMutation({
    mutationFn: startReplacement,
    onSuccess: setSetup,
    onError: fail,
  });
  const regenerate = useMutation({
    mutationFn: newRecoveryCodes,
    onSuccess: (r) => {
      setConfirm(null);
      setCodes(r.recoveryCodes);
    },
    onError: fail,
  });
  const disable = useMutation({
    mutationFn: disableMfa,
    onSuccess: async () => {
      setConfirm(null);
      toast.success('Two-step sign-in is off.');
      await refresh();
    },
    onError: fail,
  });

  if (!status.enrolled) {
    return (
      <Card title="Two-step sign-in">
        <p className="text-sm">
          <Badge tone={status.required ? 'warning' : 'neutral'}>Not set up</Badge>
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          {status.required
            ? 'Your role needs it: you will be asked to set it up at your next sign-in.'
            : 'Your account does not use two-step sign-in. Administrators are required to.'}
        </p>
      </Card>
    );
  }

  if (codes) {
    return (
      <Card title="Two-step sign-in">
        <RecoveryCodes
          codes={codes}
          doneLabel="Done"
          onDone={() => {
            setCodes(null);
            void refresh();
          }}
        />
      </Card>
    );
  }

  if (setup) {
    return (
      <Card title="Replace your authenticator app">
        <AuthenticatorSetup
          setup={setup}
          onConfirm={async (code) => {
            await confirmReplacement(code);
            setSetup(null);
            toast.success('Your new app is in use. Your other sessions were signed out.');
            await refresh();
          }}
        />
        <div className="mt-3 flex justify-end">
          <Button variant="secondary" onClick={() => setSetup(null)}>
            Keep the current app
          </Button>
        </div>
      </Card>
    );
  }

  const left = status.recoveryCodesRemaining;
  return (
    <>
      <Card title="Two-step sign-in">
        <p className="text-sm">
          <Badge tone="success">On</Badge>{' '}
          {status.enrolledAt && `since ${new Date(status.enrolledAt).toLocaleDateString()}`}
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          {status.canDisable
            ? 'Your role does not need it any more: you may turn it off.'
            : 'Your role needs it, so it cannot be turned off.'}
        </p>
      </Card>
      <Card title="Authenticator app">
        <p className="mb-3 text-sm text-muted-foreground">
          New phone? Add the new app before you remove the old one.
        </p>
        <Button variant="secondary" loading={replace.isPending} onClick={() => replace.mutate()}>
          Replace authenticator
        </Button>
      </Card>
      <Card title="Recovery codes">
        <p className="mb-3 text-sm">
          {left === 1 ? '1 code left.' : `${left} codes left.`}
          {left <= 2 && ' Make new ones soon.'}
        </p>
        <Button variant="secondary" onClick={() => setConfirm('codes')}>
          New recovery codes
        </Button>
      </Card>
      {status.canDisable && (
        <Card title="Turn off">
          <Button variant="danger" onClick={() => setConfirm('disable')}>
            Turn off two-step sign-in
          </Button>
        </Card>
      )}
      <ConfirmDialog
        open={confirm === 'codes'}
        onClose={() => setConfirm(null)}
        onConfirm={() => regenerate.mutate()}
        title="Make new recovery codes?"
        description="The codes you saved earlier stop working at once."
        confirmLabel="Make new codes"
        pending={regenerate.isPending}
      />
      <ConfirmDialog
        open={confirm === 'disable'}
        onClose={() => setConfirm(null)}
        onConfirm={() => disable.mutate()}
        title="Turn off two-step sign-in?"
        description="Your password alone will sign you in. The app and the recovery codes stop working."
        confirmLabel="Turn off"
        pending={disable.isPending}
      />
    </>
  );
}
