import { InviteRequestSchema } from '@lms/backend/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { describeError } from '../../shared/api/errors';
import { typeboxResolver } from '../../shared/forms/validation';
import { Button } from '../../shared/ui/button';
import { Dialog } from '../../shared/ui/dialog';
import { Field } from '../../shared/ui/field';
import { Select } from '../../shared/ui/select';
import { toast } from '../../shared/ui/toast';
import { inviteMember, memberKeys } from './members.api';

interface Values {
  email: string;
  displayName?: string | undefined;
  role: 'institution_admin' | 'member';
}

export function InviteMemberDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const form = useForm<Values>({
    defaultValues: { email: '', displayName: '', role: 'member' },
    resolver: typeboxResolver<Values>(InviteRequestSchema),
  });
  const invite = useMutation({
    mutationFn: (v: Values) =>
      inviteMember({ email: v.email, role: v.role, displayName: v.displayName || undefined }),
    onSuccess: (_ack, v) => {
      toast.success(`Invitation sent to ${v.email}.`);
      // a new row appears somewhere in the lists: refresh the lists on screen, not the whole cache
      void qc.invalidateQueries({ queryKey: [...memberKeys.all, 'list'] });
      onClose();
    },
    onError: (err) => toast.error(describeError(err)),
  });
  const { errors } = form.formState;

  return (
    <Dialog open={open} onClose={onClose} title="Invite a member">
      <form onSubmit={form.handleSubmit((v) => invite.mutate(v))} noValidate className="space-y-4">
        <Field
          label="Email"
          type="email"
          inputMode="email"
          autoComplete="off"
          error={errors.email?.message}
          {...form.register('email')}
        />
        <Field
          label="Name (optional)"
          autoComplete="off"
          error={errors.displayName?.message}
          {...form.register('displayName', { setValueAs: (v: string) => v.trim() || undefined })}
        />
        <Select label="Role" error={errors.role?.message} {...form.register('role')}>
          <option value="member">Member (student, faculty, staff)</option>
          <option value="institution_admin">Institution admin</option>
        </Select>
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="secondary" onClick={onClose} disabled={invite.isPending}>
            Cancel
          </Button>
          <Button type="submit" loading={invite.isPending}>
            Send invitation
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
