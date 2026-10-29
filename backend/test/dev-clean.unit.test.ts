import { describe, expect, it } from 'vitest';
import { assertDevDatabase } from '../src/cli/dev-clean';

const dev = 'postgresql://postgres.devref:pw@aws-0-eu-west-1.pooler.supabase.com:5432/postgres';
const test = 'postgresql://postgres.testref:pw@aws-1-eu-west-3.pooler.supabase.com:5432/postgres';
const ok = { yes: true, typedRef: 'devref', testUrl: test };

describe('db:dev:clean guard', () => {
  it('allows the dev project when --yes and the matching --project-ref are given', () => {
    expect(() =>
      assertDevDatabase({ NODE_ENV: 'development', DATABASE_URL: dev }, ok),
    ).not.toThrow();
  });

  it('refuses in production', () => {
    expect(() => assertDevDatabase({ NODE_ENV: 'production', DATABASE_URL: dev }, ok)).toThrow(
      /NODE_ENV is production/,
    );
  });

  it('refuses on Cloud Run', () => {
    expect(() =>
      assertDevDatabase({ NODE_ENV: 'development', DATABASE_URL: dev }, { ...ok, cloudRun: 'api' }),
    ).toThrow(/Cloud Run/);
  });

  it('refuses anything that is not a Supabase pooler or localhost (e.g. a Cloud SQL address)', () => {
    for (const url of [
      'postgresql://postgres:pw@10.20.30.40:5432/lms',
      'postgresql://postgres:pw@lms-prod.europe-west1.example.com:5432/lms',
    ]) {
      expect(() => assertDevDatabase({ NODE_ENV: 'development', DATABASE_URL: url }, ok)).toThrow(
        /not a Supabase pooler or localhost/,
      );
    }
    expect(() =>
      assertDevDatabase(
        { NODE_ENV: 'development', DATABASE_URL: 'postgresql://postgres:pw@localhost:5432/lms' },
        { yes: true, typedRef: 'local' },
      ),
    ).not.toThrow();
  });

  it('refuses the test project, a missing --yes and a missing or wrong --project-ref', () => {
    expect(() =>
      assertDevDatabase(
        { NODE_ENV: 'development', DATABASE_URL: test },
        { yes: true, typedRef: 'testref', testUrl: test },
      ),
    ).toThrow(/same project as TEST_DATABASE_URL/);
    expect(() =>
      assertDevDatabase({ NODE_ENV: 'development', DATABASE_URL: dev }, { ...ok, yes: false }),
    ).toThrow(/missing --yes/);
    expect(() =>
      assertDevDatabase(
        { NODE_ENV: 'development', DATABASE_URL: dev },
        { ...ok, typedRef: undefined },
      ),
    ).toThrow(/--project-ref/);
    expect(() =>
      assertDevDatabase(
        { NODE_ENV: 'development', DATABASE_URL: dev },
        { ...ok, typedRef: 'otherref' },
      ),
    ).toThrow(/--project-ref/);
  });

  it('reports every problem at once', () => {
    expect(() =>
      assertDevDatabase(
        { NODE_ENV: 'production', DATABASE_URL: 'postgresql://postgres:pw@10.0.0.1:5432/lms' },
        { yes: false },
      ),
    ).toThrow(/production.*not a Supabase pooler.*missing --yes/s);
  });
});

describe('db:dev:clean guard on local PostgreSQL (no project refs: database names decide)', () => {
  const localDev = 'postgresql://postgres:pw@localhost:5432/lms_dev';
  const localTest = 'postgresql://postgres:pw@localhost:5432/lms_test';
  const ok = { yes: true, typedRef: 'local', testUrl: localTest };

  it('allows the local dev database with the word "local"', () => {
    expect(() =>
      assertDevDatabase({ NODE_ENV: 'development', DATABASE_URL: localDev }, ok),
    ).not.toThrow();
  });

  it('refuses the test base database and every per-worker test database', () => {
    for (const name of ['lms_test', 'lms_test_1', 'lms_test_12']) {
      expect(() =>
        assertDevDatabase(
          { NODE_ENV: 'development', DATABASE_URL: localDev.replace('lms_dev', name) },
          ok,
        ),
      ).toThrow(/names a test database/);
    }
  });

  it('a dev database whose name merely starts like the test name is not refused', () => {
    expect(() =>
      assertDevDatabase(
        { NODE_ENV: 'development', DATABASE_URL: localDev.replace('lms_dev', 'lms_testing') },
        ok,
      ),
    ).not.toThrow();
  });
});
