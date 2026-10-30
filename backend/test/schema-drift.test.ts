import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  academicYears,
  batches,
  departments,
  programs,
  sections,
  terms,
} from '../src/modules/academics/academics.model';
import { auditLog, platformAuditLog } from '../src/modules/audit/audit.model';
import { authTokenPurpose, authTokens, userCredentials } from '../src/modules/auth/auth.model';
import { contentItems, contentModules } from '../src/modules/content/content.model';
import {
  courseOfferings,
  courseParticipants,
  courseSyncPending,
  courses,
  offeringSections,
  offeringStatus,
  participantSource,
  participantStatus,
  participationType,
} from '../src/modules/courses/courses.model';
import { files } from '../src/modules/files/files.model';
import {
  importJobs,
  importKind,
  importRowStatus,
  importRows,
  importStatus,
} from '../src/modules/imports/imports.model';
import { jobStatus, jobs } from '../src/modules/jobs/jobs.model';
import {
  membershipRole,
  membershipStatus,
  tenantMemberships,
} from '../src/modules/memberships/memberships.model';
import { memberProfiles, profileType } from '../src/modules/profiles/profiles.model';
import { sessions } from '../src/modules/sessions/sessions.model';
import { tenantSettings, tenantStatus, tenants } from '../src/modules/tenants/tenants.model';
import { users } from '../src/modules/users/users.model';

const schema = {
  tenants,
  tenantSettings,
  users,
  tenantMemberships,
  auditLog,
  platformAuditLog,
  userCredentials,
  authTokens,
  sessions,
  membershipRole,
  membershipStatus,
  tenantStatus,
  authTokenPurpose,
  jobs,
  jobStatus,
  academicYears,
  terms,
  departments,
  programs,
  batches,
  sections,
  memberProfiles,
  profileType,
  importJobs,
  importRows,
  importKind,
  importStatus,
  importRowStatus,
  courses,
  courseOfferings,
  offeringSections,
  courseParticipants,
  courseSyncPending,
  offeringStatus,
  participationType,
  participantSource,
  participantStatus,
  files,
  contentModules,
  contentItems,
};

import { testOwnerPool } from './support';

let owner: pg.Pool;
beforeAll(() => {
  owner = testOwnerPool();
});
afterAll(async () => {
  await owner.end();
});

const norm = (t: string) =>
  t
    .replaceAll('"', '')
    .replace(/^lms\./, '')
    .replaceAll(', ', ',');

interface Col {
  type: string;
  notNull: boolean;
}

function drizzleSide(): Map<string, Map<string, Col>> {
  const out = new Map<string, Map<string, Col>>();
  for (const value of Object.values(schema)) {
    if (!(value instanceof PgTable)) continue;
    const cfg = getTableConfig(value);
    out.set(
      cfg.name,
      new Map(cfg.columns.map((c) => [c.name, { type: norm(c.getSQLType()), notNull: c.notNull }])),
    );
  }
  return out;
}

describe('Drizzle schema vs live lms schema', () => {
  it('tables, columns, types and nullability match', async () => {
    const { rows } = await owner.query<{
      tbl: string;
      col: string;
      type: string;
      notnull: boolean;
    }>(
      `SELECT c.relname AS tbl, a.attname AS col, format_type(a.atttypid, a.atttypmod) AS type,
              a.attnotnull AS notnull
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'lms' AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
         AND c.relname NOT IN ('schema_migrations', 'role_password_state')`,
    );
    const live = new Map<string, Map<string, Col>>();
    for (const r of rows) {
      const cols = live.get(r.tbl) ?? new Map<string, Col>();
      cols.set(r.col, { type: norm(r.type), notNull: r.notnull });
      live.set(r.tbl, cols);
    }
    const mine = drizzleSide();

    expect([...live.keys()].sort()).toEqual([...mine.keys()].sort());
    for (const [table, cols] of mine) {
      const liveCols = live.get(table);
      expect([...(liveCols?.keys() ?? [])].sort(), `columns of ${table}`).toEqual(
        [...cols.keys()].sort(),
      );
      for (const [name, def] of cols) {
        expect(liveCols?.get(name), `${table}.${name}`).toEqual(def);
      }
    }
  });

  it('enum values match', async () => {
    const enums = {
      membership_role: schema.membershipRole,
      membership_status: schema.membershipStatus,
      tenant_status: schema.tenantStatus,
      auth_token_purpose: schema.authTokenPurpose,
    };
    for (const [name, def] of Object.entries(enums)) {
      const { rows } = await owner.query<{ enumlabel: string }>(
        `SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
         WHERE t.typname = $1 AND t.typnamespace = 'lms'::regnamespace ORDER BY e.enumsortorder`,
        [name],
      );
      expect(
        rows.map((r) => r.enumlabel),
        name,
      ).toEqual([...def.enumValues]);
    }
  });
});
