import { describe, expect, it } from 'vitest';
import { assertE2eDatabase } from './e2e-database';
import { TestGuardError } from './guards';

const env = (over: Record<string, string | undefined> = {}) => ({
  NODE_ENV: 'test',
  DB_SSL: 'off',
  DATABASE_URL: 'postgresql://postgres:pw@localhost:5432/lms_dev',
  DATABASE_APP_URL: 'postgresql://lms_app:pw@localhost:5432/lms_dev',
  TEST_DATABASE_URL: 'postgresql://postgres:pw@localhost:5432/lms_test',
  TEST_DATABASE_APP_URL: 'postgresql://lms_app:pw@localhost:5432/lms_test',
  ...over,
});

describe('E2E database guard (it TRUNCATEs: it must never point at dev or test data)', () => {
  it('derives lms_e2e on the same local server and credentials as the TEST_ URLs', () => {
    const dbs = assertE2eDatabase(env());
    expect(dbs.name).toBe('lms_e2e');
    expect(dbs.ownerUrl).toBe('postgresql://postgres:pw@localhost:5432/lms_e2e');
    expect(dbs.appUrl).toBe('postgresql://lms_app:pw@localhost:5432/lms_e2e');
  });

  it('ignores the Vitest worker suffix: the E2E database is one fixed database', () => {
    expect(assertE2eDatabase(env({ VITEST_POOL_ID: '3' })).name).toBe('lms_e2e');
  });

  it('refuses when lms_e2e is the dev database (any host)', () => {
    expect(() =>
      assertE2eDatabase(env({ DATABASE_URL: 'postgresql://postgres:pw@localhost:5432/lms_e2e' })),
    ).toThrow(TestGuardError);
    expect(() =>
      assertE2eDatabase(
        env({ DATABASE_APP_URL: 'postgresql://lms_app:pw@localhost:5432/lms_e2e' }),
      ),
    ).toThrow(TestGuardError);
  });

  it('refuses when the TEST base database is called lms_e2e, or the test URLs are missing', () => {
    expect(() =>
      assertE2eDatabase(
        env({
          TEST_DATABASE_URL: 'postgresql://postgres:pw@localhost:5432/lms_e2e',
          TEST_DATABASE_APP_URL: 'postgresql://lms_app:pw@localhost:5432/lms_e2e',
        }),
      ),
    ).toThrow(/clashes|dev database name/);
    expect(() => assertE2eDatabase(env({ TEST_DATABASE_URL: undefined }))).toThrow(
      /TEST_DATABASE_URL/,
    );
  });

  it('refuses production and a remote server without TLS', () => {
    expect(() => assertE2eDatabase(env({ NODE_ENV: 'production' }))).toThrow(/production/);
    expect(() =>
      assertE2eDatabase(
        env({
          TEST_DATABASE_URL: 'postgresql://postgres:pw@db.example.com:5432/lms_test',
          TEST_DATABASE_APP_URL: 'postgresql://lms_app:pw@db.example.com:5432/lms_test',
        }),
      ),
    ).toThrow(TestGuardError);
  });
});
