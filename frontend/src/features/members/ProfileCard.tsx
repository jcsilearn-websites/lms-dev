import { type Member, type ProfileDto, UpdateProfileRequestSchema } from '@lms/backend/contracts';
import { type UseQueryResult, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { ApiError } from '../../shared/api/client';
import { describeError } from '../../shared/api/errors';
import { typeboxResolver } from '../../shared/forms/validation';
import { Button } from '../../shared/ui/button';
import { Field } from '../../shared/ui/field';
import { Card } from '../../shared/ui/layout';
import { Select } from '../../shared/ui/select';
import { Skeleton } from '../../shared/ui/states';
import { toast } from '../../shared/ui/toast';
import { optionKeys, sectionOptions } from '../academics/academics.api';
import { useAcademicOptions } from '../academics/useOptions';
import { putMember } from './cache';
import { memberKeys, moveSection, saveProfile } from './members.api';

interface Values {
  profileType: string;
  phone?: string | undefined;
  designation?: string | undefined;
  registerNumber?: string | undefined;
  employeeId?: string | undefined;
  departmentId?: string | undefined;
  programId: string;
  batchId?: string | undefined;
  sectionId?: string | undefined;
}

const CHAIN = ['departmentId', 'programId', 'batchId', 'sectionId'] as const;
const blank = (v: string) => v.trim() || undefined;

function Row({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="contents">
      <dt className="text-muted-foreground">{label}</dt>
      <dd>{value || '-'}</dd>
    </div>
  );
}

export function ProfileCard({
  userId,
  member,
  profile,
}: {
  userId: string;
  member: Member;
  profile: UseQueryResult<ProfileDto>;
}) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const noProfile = profile.error instanceof ApiError && profile.error.status === 404;
  const p = profile.data;

  const form = useForm<Values>({
    values: {
      profileType: p?.profileType ?? '',
      phone: p?.phone ?? '',
      designation: p?.designation ?? '',
      registerNumber: p?.registerNumber ?? '',
      employeeId: p?.employeeId ?? '',
      // the whole chain is prefilled: department -> program -> batch -> section
      departmentId: p?.departmentId ?? '',
      programId: p?.programId ?? '',
      batchId: p?.batchId ?? '',
      sectionId: p?.sectionId ?? '',
    },
    resolver: async (values, ctx, opts) => {
      // only the fields that are filled in are sent: validate exactly that body, keep the form values
      const result = await typeboxResolver<Values>(UpdateProfileRequestSchema)(
        toBody(values, p) as never,
        ctx,
        opts,
      );
      return Object.keys(result.errors).length > 0 ? result : { values, errors: {} };
    },
  });
  const type = form.watch('profileType');
  const dept = form.watch('departmentId') || undefined;
  const program = form.watch('programId') || undefined;
  const batch = form.watch('batchId') || undefined;
  // the pickers load only while the form is open, and each level only once its parent is chosen
  const options = useAcademicOptions({
    departmentId: editing ? dept : undefined,
    programId: editing ? program : undefined,
    batchId: editing ? batch : undefined,
  });
  const { errors } = form.formState;
  // an error on a value the form does not show (a chain id) must still be visible
  const SHOWN = ['profileType', 'phone', 'designation', 'registerNumber', 'employeeId'];
  const hiddenError = Object.entries(errors).find(([name]) => !SHOWN.includes(name))?.[1]?.message;

  /**
   * The chain selects are CONTROLLED: their options arrive after the form is prefilled, and an uncontrolled
   * select cannot hold a value whose option does not exist yet. Choosing a step clears the steps below.
   */
  const pick = (
    name: 'departmentId' | 'programId' | 'batchId' | 'sectionId',
    below: (typeof CHAIN)[number][],
  ) => ({
    value: form.watch(name) ?? '',
    onChange: (e: React.ChangeEvent<HTMLSelectElement>) => {
      form.setValue(name, e.target.value, { shouldDirty: true });
      for (const lower of below) form.setValue(lower, '');
    },
  });

  const save = useMutation({
    mutationFn: (v: Values) => saveProfile(userId, toBody(v, p)),
    onSuccess: (saved) => {
      qc.setQueryData(memberKeys.profile(userId), saved);
      putMember(qc, {
        ...member,
        profileType: saved.profileType,
        registerNumber: saved.registerNumber,
        employeeId: saved.employeeId,
        departmentId: saved.departmentId,
        batchId: saved.batchId,
        sectionId: saved.sectionId,
      });
      toast.success('Profile saved.');
      setEditing(false);
    },
    onError: (err) => toast.error(describeError(err)),
  });

  return (
    <Card title="Profile">
      {profile.isPending ? (
        <Skeleton className="h-24 w-full" />
      ) : profile.isError && !noProfile ? (
        <p role="alert" className="text-sm text-danger">
          {describeError(profile.error)}{' '}
          <button type="button" className="underline" onClick={() => void profile.refetch()}>
            Try again
          </button>
        </p>
      ) : !editing ? (
        <div className="space-y-4">
          {p ? (
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              <Row label="Type" value={p.profileType} />
              <Row label="Phone" value={p.phone} />
              <Row label="Designation" value={p.designation} />
              {p.profileType === 'student' ? (
                <>
                  <Row label="Register number" value={p.registerNumber} />
                  <Row label="Department" value={p.departmentCode} />
                  <Row
                    label="Program"
                    value={p.programName ? `${p.programName} (${p.programCode})` : p.programCode}
                  />
                  <Row label="Batch" value={p.batchLabel} />
                  <Row label="Section" value={p.sectionCode} />
                </>
              ) : (
                <>
                  <Row label="Employee id" value={p.employeeId} />
                  <Row label="Department" value={p.departmentCode} />
                </>
              )}
            </dl>
          ) : (
            <p className="text-sm text-muted-foreground">This member has no profile yet.</p>
          )}
          <Button variant="secondary" onClick={() => setEditing(true)}>
            {p ? 'Edit profile' : 'Create profile'}
          </Button>
          {p?.profileType === 'student' && p.batchId && p.sectionId && (
            <SectionMove userId={userId} batchId={p.batchId} currentSectionId={p.sectionId} />
          )}
        </div>
      ) : (
        <form onSubmit={form.handleSubmit((v) => save.mutate(v))} noValidate className="space-y-4">
          <Select
            label="Profile type"
            error={errors.profileType?.message}
            {...form.register('profileType')}
          >
            <option value="">Choose...</option>
            <option value="student">Student</option>
            <option value="faculty">Faculty</option>
            <option value="staff">Staff</option>
          </Select>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Phone" error={errors.phone?.message} {...form.register('phone')} />
            <Field
              label="Designation"
              error={errors.designation?.message}
              {...form.register('designation')}
            />
            {type === 'student' && (
              <Field
                label="Register number"
                error={errors.registerNumber?.message}
                {...form.register('registerNumber')}
              />
            )}
            {(type === 'faculty' || type === 'staff') && (
              <Field
                label="Employee id"
                error={errors.employeeId?.message}
                {...form.register('employeeId')}
              />
            )}
          </div>
          {type && (
            <fieldset className="grid gap-4 sm:grid-cols-2">
              <legend className="mb-2 text-sm font-medium">
                {type === 'student' ? 'Department, program, batch and section' : 'Department'}
              </legend>
              <Select
                label="Department"
                {...pick('departmentId', ['programId', 'batchId', 'sectionId'])}
              >
                <option value="">Choose...</option>
                {options.departments.data?.items.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.code} - {d.name}
                  </option>
                ))}
              </Select>
              {type === 'student' && (
                <>
                  <Select
                    label="Program"
                    disabled={!dept}
                    {...pick('programId', ['batchId', 'sectionId'])}
                  >
                    <option value="">{dept ? 'Choose...' : 'Pick a department first'}</option>
                    {options.programs.data?.items.map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.code}
                      </option>
                    ))}
                  </Select>
                  <Select label="Batch" disabled={!program} {...pick('batchId', ['sectionId'])}>
                    <option value="">{program ? 'Choose...' : 'Pick a program first'}</option>
                    {options.batches.data?.items.map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.label}
                      </option>
                    ))}
                  </Select>
                  <Select label="Section" disabled={!batch} {...pick('sectionId', [])}>
                    <option value="">{batch ? 'Choose...' : 'Pick a batch first'}</option>
                    {options.sections.data?.items.map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.code}
                      </option>
                    ))}
                  </Select>
                </>
              )}
            </fieldset>
          )}
          {hiddenError && (
            <p role="alert" className="text-sm text-danger">
              {hiddenError}
            </p>
          )}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button variant="secondary" onClick={() => setEditing(false)} disabled={save.isPending}>
              Cancel
            </Button>
            <Button type="submit" loading={save.isPending}>
              Save profile
            </Button>
          </div>
        </form>
      )}
    </Card>
  );
}

/**
 * Only filled-in fields are sent, and the department / batch / section only when they CHANGED (the form is
 * prefilled with the current ones, and resending them would write a pointless audit entry). The department
 * of a student follows from the batch, so it is never sent for students.
 */
function toBody(v: Values, current?: ProfileDto): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (v.profileType) body.profileType = v.profileType;
  const phone = blank(v.phone ?? '');
  if (phone) body.phone = phone;
  const designation = blank(v.designation ?? '');
  if (designation) body.designation = designation;
  if (v.profileType === 'student') {
    const reg = blank(v.registerNumber ?? '');
    if (reg) body.registerNumber = reg;
    const changed =
      v.batchId !== (current?.batchId ?? '') || v.sectionId !== (current?.sectionId ?? '');
    if (changed) {
      if (v.batchId) body.batchId = v.batchId;
      if (v.sectionId) body.sectionId = v.sectionId;
    }
  } else if (v.profileType) {
    const emp = blank(v.employeeId ?? '');
    if (emp) body.employeeId = emp;
    if (v.departmentId && v.departmentId !== current?.departmentId)
      body.departmentId = v.departmentId;
  }
  return body;
}

/** Moves a student to another section of the SAME batch (sections of that batch only). */
function SectionMove({
  userId,
  batchId,
  currentSectionId,
}: {
  userId: string;
  batchId: string;
  currentSectionId: string;
}) {
  const qc = useQueryClient();
  const [target, setTarget] = useState('');
  const sections = useQuery({
    queryKey: optionKeys.sections(batchId),
    queryFn: ({ signal }) => sectionOptions(batchId, signal),
    staleTime: 5 * 60_000,
  });
  const move = useMutation({
    mutationFn: () => moveSection(userId, target),
    onSuccess: async () => {
      // the profile changed on the server (section code): refresh just the profile
      await qc.invalidateQueries({ queryKey: memberKeys.profile(userId) });
      toast.success('Section changed.');
      setTarget('');
    },
    onError: (err) => toast.error(describeError(err)),
  });
  const others = sections.data?.items.filter((s) => s.id !== currentSectionId) ?? [];
  if (sections.isSuccess && others.length === 0) return null;
  return (
    <div className="flex flex-wrap items-end gap-2 border-t border-border pt-4">
      <Select
        label="Move to another section of this batch"
        value={target}
        onChange={(e) => setTarget(e.target.value)}
        className="w-64"
      >
        <option value="">Choose a section...</option>
        {others.map((s) => (
          <option key={s.id} value={s.id}>
            {s.code}
          </option>
        ))}
      </Select>
      <Button
        variant="secondary"
        disabled={!target}
        loading={move.isPending}
        onClick={() => move.mutate()}
      >
        Move
      </Button>
    </div>
  );
}
