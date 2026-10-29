import {
  CreateAcademicYearSchema,
  CreateProgramSchema,
  CreateTenantRequestSchema,
  LoginRequestSchema,
  UpdateBrandingRequestSchema,
} from '@lms/backend/contracts';
import { describe, expect, it } from 'vitest';
import { validate } from '../src/shared/forms/validation';

// The forms validate with the backend's TypeBox schemas. TypeBox treats a `format` it does not know
// as INVALID, so the formats the contracts use (uuid, date) must be registered: without that every
// form that sends an id (programs, batches, sections, terms) failed silently.

const ID = '01a183c6-b2f4-7bd0-a6ae-58be9db51f10';

describe('contract schemas in the browser', () => {
  it('accepts a body with a uuid and rejects a malformed one with a sentence', () => {
    const body = { departmentId: ID, code: 'BE', name: 'Bachelor', durationYears: 4 };
    expect(validate(CreateProgramSchema, body)).toEqual({});
    expect(validate(CreateProgramSchema, { ...body, departmentId: 'not-an-id' })).toEqual({
      departmentId: 'Department Id is not valid.',
    });
  });

  it('knows the date format (real calendar dates only)', () => {
    const year = { label: '2025-26', startDate: '2025-06-01', endDate: '2026-05-31' };
    expect(validate(CreateAcademicYearSchema, year)).toEqual({});
    expect(validate(CreateAcademicYearSchema, { ...year, endDate: '2026-02-31' })).toHaveProperty(
      'endDate',
    );
    expect(validate(CreateAcademicYearSchema, { ...year, startDate: 'yesterday' })).toHaveProperty(
      'startDate',
    );
  });

  it('names fields the way the form does, and says what is wrong', () => {
    const labels = { name: 'College name', slug: 'Web address' };
    const errors = validate(
      CreateTenantRequestSchema,
      { name: '', slug: 'ab', adminEmail: 'a@b.co', adminName: 'A' },
      labels,
    );
    expect(errors).toEqual({
      name: 'College name is required.',
      slug: 'Web address must be at least 3 characters.',
    });
  });

  it('reports a missing field as required and a wrong pattern as a format problem', () => {
    expect(validate(LoginRequestSchema, {})).toEqual({
      email: 'Email is required.',
      password: 'Password is required.',
    });
    expect(
      validate(UpdateBrandingRequestSchema, { displayName: 'X', primaryColor: '#12' }),
    ).toEqual({ primaryColor: 'Primary Color has an invalid format.' });
  });
});
