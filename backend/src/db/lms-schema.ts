import { customType, pgSchema, timestamp } from 'drizzle-orm/pg-core';

// Drizzle describes the schema for typed queries. The SQL migrations are the source of truth
// (RLS, grants, roles); backend/test/schema-drift.test.ts fails if the two disagree.
// Each module owns its tables in <module>.model.ts, all inside this namespace.
export const lms = pgSchema('lms');

/** bytea <-> Buffer (token hashes). */
export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

/** inet <-> string (client IP). */
export const inet = customType<{ data: string; driverData: string }>({
  dataType: () => 'inet',
});

export const createdAt = () =>
  timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
export const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();
