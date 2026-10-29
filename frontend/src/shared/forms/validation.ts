import { FormatRegistry, type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type { FieldValues, Resolver } from 'react-hook-form';

// Validation with the SAME TypeBox schemas the backend uses (from @lms/backend/contracts), so a value
// the form accepts is a value the API accepts and vice versa. This module pulls in TypeBox's value
// checker and the contracts, so it must only ever be loaded lazily (dynamic import on the first form
// interaction, or from a lazy route chunk): see the bundle budget in scripts/check-bundle-size.mjs.

type Issue = { path: string; message: string };

// TypeBox treats a `format` it does not know as INVALID. The contracts use these (ids, dates), the
// backend registers them through Ajv; register the same here so a form accepts what the API accepts.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
FormatRegistry.Set('uuid', (v) => UUID.test(v));
FormatRegistry.Set('date', (v) => {
  if (!DATE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(v);
});
FormatRegistry.Set('date-time', (v) => !Number.isNaN(Date.parse(v)) && /T/.test(v));
FormatRegistry.Set('email', (v) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v));

const LABELS: Record<string, string> = {
  email: 'Email',
  password: 'Password',
  newPassword: 'New password',
  currentPassword: 'Current password',
  displayName: 'Name',
  token: 'Link',
};

function label(field: string, labels: Record<string, string> = {}): string {
  return (
    labels[field] ??
    LABELS[field] ??
    field.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase())
  );
}

/** Turns a TypeBox error into a sentence a person understands. */
function sentence(
  field: string,
  schema: Record<string, unknown>,
  value: unknown,
  labels: Record<string, string>,
): string {
  const name = label(field, labels);
  if (value === undefined || value === null || value === '') return `${name} is required.`;
  if (typeof value === 'string') {
    const min = schema.minLength;
    const max = schema.maxLength;
    if (typeof min === 'number' && value.length < min) {
      return min === 1 ? `${name} is required.` : `${name} must be at least ${min} characters.`;
    }
    if (typeof max === 'number' && value.length > max) {
      return `${name} must be at most ${max} characters.`;
    }
    if (schema.pattern !== undefined) return `${name} has an invalid format.`;
    if (schema.format === 'uuid') return `${name} is not valid.`;
  }
  return `${name} is not valid.`;
}

function getAt(values: unknown, path: string): unknown {
  let cur: unknown = values;
  for (const part of path.split('/').filter(Boolean)) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** Field name -> first message. Empty object = valid. */
/** `labels` names fields the way the form does ("Web address" rather than "Slug"). */
export function validate(
  schema: TSchema,
  values: unknown,
  labels: Record<string, string> = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of Value.Errors(schema, values)) {
    const issue: Issue = { path: e.path, message: e.message };
    const field = issue.path.replace(/^\//, '').replace(/\//g, '.');
    if (!field || out[field]) continue;
    out[field] = sentence(
      field,
      e.schema as Record<string, unknown>,
      getAt(values, issue.path),
      labels,
    );
  }
  return out;
}

/** react-hook-form resolver over a TypeBox schema (signed-in forms). */
export function typeboxResolver<T extends FieldValues>(
  schema: TSchema,
  labels: Record<string, string> = {},
): Resolver<T> {
  return async (values) => {
    const errors = validate(schema, values, labels);
    const keys = Object.keys(errors);
    if (keys.length === 0) return { values: values as T, errors: {} };
    const fieldErrors: Record<string, { type: string; message: string }> = {};
    for (const k of keys) fieldErrors[k] = { type: 'validation', message: errors[k] as string };
    return { values: {}, errors: fieldErrors } as ReturnType<Resolver<T>> extends Promise<infer R>
      ? R
      : never;
  };
}
