import { describe, expect, it } from 'vitest';
import { assertTestDatabases, projectKey, TestGuardError } from '../../../test/guards';
import {
  apiEnvSchema,
  assertSslPolicy,
  assertVideoPolicy,
  cookieSettings,
  EnvError,
  migrateEnvSchema,
  parseApiEnv,
  parseEnv,
  parseWorkerEnv,
  resolvePoolMax,
} from '../env';
import { redactSecrets } from '../secrets';
import { sslWarning } from '../ssl';

const dev = 'postgresql://postgres.devref:pw@pooler.example.com:5432/lms_dev';
const devApp = 'postgresql://lms_app.devref:pw@pooler.example.com:5432/lms_dev';
const test = 'postgresql://postgres.testref:pw@pooler.example.com:5432/lms_test';
const testApp = 'postgresql://lms_app.testref:pw@pooler.example.com:5432/lms_test';
const tls = { DB_SSL: 'verify-full' } as const; // a remote host needs real TLS
const local = {
  dev: 'postgresql://postgres:pw@localhost:5432/lms_dev',
  devApp: 'postgresql://lms_app:pw@localhost:5432/lms_dev',
  test: 'postgresql://postgres:pw@localhost:5432/lms_test',
  testApp: 'postgresql://lms_app:pw@localhost:5432/lms_test',
};

describe('parseEnv', () => {
  it('applies defaults and converts types', () => {
    const env = parseEnv(apiEnvSchema, {
      DATABASE_APP_URL: devApp,
      PORT: '4000',
      TRUST_PROXY: 'true',
    });
    expect(env.PORT).toBe(4000);
    expect(env.TRUST_PROXY).toBe(true);
    expect(env.NODE_ENV).toBe('development');
    expect(env.RATE_LIMIT_MAX).toBe(300);
  });

  it('fails fast with a clear message when a required var is missing', () => {
    expect(() => parseEnv(apiEnvSchema, {})).toThrow(EnvError);
    expect(() => parseEnv(apiEnvSchema, {})).toThrow(/DATABASE_APP_URL/);
  });

  it('rejects invalid values without echoing them', () => {
    const secret = 'super-secret-value';
    try {
      parseEnv(apiEnvSchema, { DATABASE_APP_URL: secret, PORT: 'abc' });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(EnvError);
      expect((err as Error).message).toMatch(/DATABASE_APP_URL/);
      expect((err as Error).message).toMatch(/PORT/);
      expect((err as Error).message).not.toContain(secret);
    }
  });

  it('rejects an out-of-range pool size and weak/unsafe lms_app passwords', () => {
    expect(() => parseEnv(apiEnvSchema, { DATABASE_APP_URL: devApp, DB_POOL_MAX: '0' })).toThrow(
      /DB_POOL_MAX/,
    );
    expect(() =>
      parseEnv(migrateEnvSchema, {
        DATABASE_URL: dev,
        DATABASE_APP_URL: devApp,
        LMS_APP_PASSWORD: 'short',
      }),
    ).toThrow(/LMS_APP_PASSWORD/);
  });

  it('treats empty strings as unset', () => {
    expect(parseEnv(apiEnvSchema, { DATABASE_APP_URL: devApp, PORT: '' }).PORT).toBe(3000);
  });
});

describe('resolvePoolMax', () => {
  it('defaults to 5 outside production, 10 in production, and honours overrides', () => {
    expect(resolvePoolMax({ NODE_ENV: 'development' })).toBe(5);
    expect(resolvePoolMax({ NODE_ENV: 'test' })).toBe(5);
    expect(resolvePoolMax({ NODE_ENV: 'production' })).toBe(10);
    expect(resolvePoolMax({ NODE_ENV: 'production', DB_POOL_MAX: 3 })).toBe(3);
  });
});

describe('assertTestDatabases', () => {
  it('refuses when TEST_ URLs are missing', () => {
    expect(() => assertTestDatabases({ DATABASE_URL: dev, ...tls })).toThrow(TestGuardError);
  });
  it('refuses when TEST_ URLs point at the dev database (same project and name)', () => {
    expect(() =>
      assertTestDatabases({
        ...tls,
        TEST_DATABASE_URL: dev,
        TEST_DATABASE_APP_URL: devApp,
        DATABASE_URL: dev,
        DATABASE_APP_URL: devApp,
      }),
    ).toThrow(/dev database/);
  });
  it('refuses the same project ref even when the pooler host differs', () => {
    const otherHost = (u: string) =>
      u.replace('pooler.example.com', 'other-region.example.com').replace('lms_dev', 'lms_other');
    expect(() =>
      assertTestDatabases({
        ...tls,
        TEST_DATABASE_URL: otherHost(dev),
        TEST_DATABASE_APP_URL: otherHost(devApp),
        DATABASE_URL: dev,
        DATABASE_APP_URL: devApp,
      }),
    ).toThrow(/same project as the dev database/);
  });
  it('refuses when owner and app TEST_ URLs are different projects', () => {
    expect(() =>
      assertTestDatabases({ ...tls, TEST_DATABASE_URL: test, TEST_DATABASE_APP_URL: devApp }),
    ).toThrow(/different projects/);
  });
  it('refuses in production', () => {
    expect(() =>
      assertTestDatabases({
        NODE_ENV: 'production',
        TEST_DATABASE_URL: test,
        TEST_DATABASE_APP_URL: testApp,
      }),
    ).toThrow(/production/);
  });
  it('accepts a separate test project (with or without dev URLs)', () => {
    const base = { ...tls, TEST_DATABASE_URL: test, TEST_DATABASE_APP_URL: testApp };
    expect(assertTestDatabases(base).ownerUrl).toBe(test);
    expect(
      assertTestDatabases({ ...base, DATABASE_URL: dev, DATABASE_APP_URL: devApp }).appUrl,
    ).toBe(testApp);
  });

  describe('local PostgreSQL', () => {
    const src = {
      DB_SSL: 'off',
      TEST_DATABASE_URL: local.test,
      TEST_DATABASE_APP_URL: local.testApp,
      DATABASE_URL: local.dev,
      DATABASE_APP_URL: local.devApp,
    };

    it('accepts localhost with DB_SSL=off when the test database has another NAME than dev', () => {
      const dbs = assertTestDatabases(src);
      expect(dbs).toMatchObject({ ownerUrl: local.test, appUrl: local.testApp, ssl: 'off' });
      expect(dbs.name).toBe('lms_test');
      expect(dbs.baseName).toBe('lms_test');
      expect(
        assertTestDatabases({
          ...src,
          TEST_DATABASE_URL: local.test.replace('localhost', '127.0.0.1'),
          TEST_DATABASE_APP_URL: local.testApp.replace('localhost', '127.0.0.1'),
        }).ssl,
      ).toBe('off');
    });

    it('refuses a test database with the SAME NAME as the dev database, on any host', () => {
      expect(() =>
        assertTestDatabases({
          ...src,
          TEST_DATABASE_URL: local.dev,
          TEST_DATABASE_APP_URL: local.devApp,
        }),
      ).toThrow(/dev database name/);
      // a different host does not make it different: the name is what is compared
      const remoteTest = 'postgresql://postgres:pw@db.other-host.example:5432/lms_dev';
      const remoteTestApp = 'postgresql://lms_app:pw@db.other-host.example:5432/lms_dev';
      expect(() =>
        assertTestDatabases({
          ...src,
          ...tls,
          TEST_DATABASE_URL: remoteTest,
          TEST_DATABASE_APP_URL: remoteTestApp,
        }),
      ).toThrow(/dev database name/);
    });

    it('derives the database of each worker from the TEST_ base name and checks THAT name too', () => {
      const w3 = assertTestDatabases({ ...src, VITEST_POOL_ID: '3' });
      expect(w3.name).toBe('lms_test_3');
      expect(w3.ownerUrl).toBe('postgresql://postgres:pw@localhost:5432/lms_test_3');
      expect(w3.appUrl).toBe('postgresql://lms_app:pw@localhost:5432/lms_test_3');
      expect(assertTestDatabases({ ...src, VITEST_POOL_ID: 'not-a-number' }).name).toBe('lms_test');
      // a dev database that happens to be called like a worker database is refused
      expect(() =>
        assertTestDatabases({
          ...src,
          VITEST_POOL_ID: '2',
          DATABASE_URL: local.dev.replace('lms_dev', 'lms_test_2'),
          DATABASE_APP_URL: local.devApp.replace('lms_dev', 'lms_test_2'),
        }),
      ).toThrow(/dev database name/);
    });

    it('refuses unsafe or system database names', () => {
      for (const name of ['postgres', 'template1', 'Lms-Test', 'lms test']) {
        expect(() =>
          assertTestDatabases({
            ...src,
            TEST_DATABASE_URL: local.test.replace('lms_test', encodeURIComponent(name)),
            TEST_DATABASE_APP_URL: local.testApp.replace('lms_test', encodeURIComponent(name)),
          }),
        ).toThrow(TestGuardError);
      }
    });

    it('keeps the production refusals (also for localhost) and refuses DB_SSL=off for a remote test host', () => {
      expect(() => assertTestDatabases({ ...src, NODE_ENV: 'production' })).toThrow(/production/);
      expect(() =>
        assertTestDatabases({ ...src, TEST_DATABASE_URL: test, TEST_DATABASE_APP_URL: testApp }),
      ).toThrow(/only allowed for a database on localhost/);
    });
  });
});

describe('helpers', () => {
  it('projectKey ignores the role part of pooler usernames', () => {
    expect(projectKey(dev)).toBe(projectKey(devApp));
    expect(projectKey(dev)).not.toBe(projectKey(test));
  });
  it('redactSecrets masks secrets', () => {
    expect(redactSecrets('pw=abc123 and abc123', ['abc123'])).toBe('pw=*** and ***');
  });
});

describe('video provider policy', () => {
  const dev = {
    DATABASE_APP_URL: devApp,
    STORAGE_SIGNING_SECRET: 'x'.repeat(40),
    DB_SSL: 'no-verify',
  };
  const prod = {
    ...dev,
    NODE_ENV: 'production',
    APP_BASE_DOMAIN: 'example.com',
    MAILER: 'none',
    STORAGE_DRIVER: 'gcs',
    STORAGE_GCS_BUCKET: 'prod-files',
    DB_SSL: 'verify-full',
    DB_SSL_CA: '/certs/ca.crt',
  };
  it('the local provider (ffmpeg in the worker) is the default for development and test', () => {
    for (const NODE_ENV of ['development', 'test']) {
      expect(parseApiEnv({ ...dev, NODE_ENV }).VIDEO_PROVIDER).toBe('local');
      expect(parseWorkerEnv({ ...dev, NODE_ENV }).VIDEO_PROVIDER).toBe('local');
    }
  });
  it('refuses VIDEO_PROVIDER=local when NODE_ENV=production: ffmpeg is never shipped in a production image', () => {
    for (const parse of [parseApiEnv, parseWorkerEnv]) {
      expect(() => parse({ ...prod, VIDEO_PROVIDER: 'local' })).toThrow(
        /VIDEO_PROVIDER.*local.*production/,
      );
      // forgetting to choose a provider is the same mistake: the default is local
      expect(() => parse({ ...prod })).toThrow(/VIDEO_PROVIDER/);
    }
    expect(() =>
      assertVideoPolicy({ NODE_ENV: 'production', VIDEO_PROVIDER: 'local', STORAGE_DRIVER: 'gcs' }),
    ).toThrow(EnvError);
  });
  it('accepts a managed provider in production', () => {
    for (const VIDEO_PROVIDER of ['gcp', 'bunny']) {
      expect(parseApiEnv({ ...prod, VIDEO_PROVIDER }).VIDEO_PROVIDER).toBe(VIDEO_PROVIDER);
      expect(parseWorkerEnv({ ...prod, VIDEO_PROVIDER }).VIDEO_PROVIDER).toBe(VIDEO_PROVIDER);
    }
  });
  it('the local provider stores through the local storage driver', () => {
    expect(() =>
      parseApiEnv({
        ...dev,
        NODE_ENV: 'development',
        STORAGE_DRIVER: 'gcs',
        STORAGE_GCS_BUCKET: 'bucket',
      }),
    ).toThrow(/VIDEO_PROVIDER.*STORAGE_DRIVER=local/);
  });
  it('has defaults that match the documented limits', () => {
    const env = parseApiEnv({ ...dev, NODE_ENV: 'development' });
    expect(env).toMatchObject({
      VIDEO_MAX_BYTES: 2 * 1024 ** 3,
      VIDEO_MAX_DURATION_SECONDS: 3 * 3600,
      VIDEO_SOURCE_RETENTION_DAYS: 30,
      VIDEO_SESSION_CACHE_TTL_SECONDS: 60,
      VIDEO_PLAYBACK_TTL_SECONDS: 7200,
    });
  });
});

describe('DB_SSL policy', () => {
  // storage: the API needs a driver (a signing key for the local one; the GCS driver is checked in files.test.ts)
  const base = { DATABASE_APP_URL: devApp, STORAGE_SIGNING_SECRET: 'x'.repeat(40) };
  it('accepts no-verify in development and test, with a startup warning', () => {
    for (const NODE_ENV of ['development', 'test']) {
      const env = parseApiEnv({ ...base, NODE_ENV, DB_SSL: 'no-verify' });
      expect(env.DB_SSL).toBe('no-verify');
      expect(sslWarning(env)).toMatch(/NOT verified/);
    }
  });
  it('rejects no-verify when NODE_ENV=production', () => {
    expect(() => parseApiEnv({ ...base, NODE_ENV: 'production', DB_SSL: 'no-verify' })).toThrow(
      /no-verify.*production/,
    );
    expect(() => assertSslPolicy({ NODE_ENV: 'production', DB_SSL: 'no-verify' })).toThrow(
      EnvError,
    );
  });
  it('accepts verify-full with a CA path in production, and has no warning for it', () => {
    const env = parseApiEnv({
      ...base,
      NODE_ENV: 'production',
      APP_BASE_DOMAIN: 'example.com',
      MAILER: 'none',
      STORAGE_DRIVER: 'gcs',
      STORAGE_GCS_BUCKET: 'prod-files',
      VIDEO_PROVIDER: 'gcp',
      DB_SSL: 'verify-full',
      DB_SSL_CA: '/certs/prod-ca.crt',
    });
    expect(env.DB_SSL_CA).toBe('/certs/prod-ca.crt');
    expect(sslWarning(env)).toBeUndefined();
  });
  it('rejects the old "verify" spelling and unknown modes', () => {
    expect(() => parseApiEnv({ ...base, DB_SSL: 'verify' })).toThrow(/DB_SSL/);
  });
  describe('DB_SSL=off is for this machine only, and never in production', () => {
    const off = { DB_SSL: 'off' };
    it('is accepted for localhost and 127.0.0.1 outside production', () => {
      for (const host of ['localhost', '127.0.0.1']) {
        const url = `postgresql://lms_app:pw@${host}:5432/lms_dev`;
        for (const NODE_ENV of ['development', 'test']) {
          expect(
            parseApiEnv({
              DATABASE_APP_URL: url,
              NODE_ENV,
              STORAGE_SIGNING_SECRET: 'x'.repeat(40),
              ...off,
            }).DB_SSL,
          ).toBe('off');
        }
      }
    });
    it('is rejected for any remote host, without echoing it', () => {
      expect(() =>
        parseApiEnv({
          DATABASE_APP_URL: 'postgresql://lms_app:pw@db.internal.example:5432/x',
          ...off,
        }),
      ).toThrow(/only allowed for a database on localhost/);
      let message = '';
      try {
        parseApiEnv({
          DATABASE_APP_URL: 'postgresql://lms_app:pw@db.internal.example:5432/x',
          ...off,
        });
      } catch (e) {
        message = String(e);
      }
      expect(message).not.toContain('db.internal.example');
    });
    it('is rejected in production, even for localhost', () => {
      const prod = {
        NODE_ENV: 'production',
        APP_BASE_DOMAIN: 'example.com',
        MAILER: 'none',
        ...off,
      };
      expect(() => parseApiEnv({ DATABASE_APP_URL: local.devApp, ...prod })).toThrow(
        /"off" is not allowed when NODE_ENV=production/,
      );
      expect(() =>
        assertSslPolicy({ NODE_ENV: 'production', DB_SSL: 'off' }, [local.devApp]),
      ).toThrow(EnvError);
    });
    it('applies to every database URL a process reads (owner and app)', () => {
      expect(() =>
        assertSslPolicy({ NODE_ENV: 'development', DB_SSL: 'off' }, [
          local.dev,
          'postgresql://x:y@remote.example/db',
        ]),
      ).toThrow(/localhost/);
      expect(() =>
        assertSslPolicy({ NODE_ENV: 'development', DB_SSL: 'off' }, [local.dev, local.devApp]),
      ).not.toThrow();
    });
    it('verify-full and (outside production) no-verify are unaffected by the host', () => {
      expect(() =>
        assertSslPolicy({ NODE_ENV: 'production', DB_SSL: 'verify-full' }, [
          'postgresql://x:y@remote.example/db',
        ]),
      ).not.toThrow();
      expect(() =>
        assertSslPolicy({ NODE_ENV: 'development', DB_SSL: 'no-verify' }, [
          'postgresql://x:y@remote.example/db',
        ]),
      ).not.toThrow();
    });
  });
  it('the test guard refuses no-verify under production', () => {
    expect(() =>
      assertTestDatabases({
        NODE_ENV: 'production',
        TEST_DATABASE_URL: test,
        TEST_DATABASE_APP_URL: testApp,
        DB_SSL: 'no-verify',
      }),
    ).toThrow();
  });
});

describe('auth configuration policy', () => {
  // a database on this machine: DB_SSL=off is fine
  const base = { DATABASE_APP_URL: local.devApp, STORAGE_SIGNING_SECRET: 'x'.repeat(40) };

  it('has safe defaults for development', () => {
    const env = parseApiEnv({ ...base, NODE_ENV: 'development' });
    expect(env).toMatchObject({
      APP_BASE_DOMAIN: 'localhost',
      SESSION_IDLE_DAYS: 7,
      SESSION_ABSOLUTE_DAYS: 30,
      LOGIN_MAX_ATTEMPTS: 10,
      LOCKOUT_BASE_SECONDS: 60,
      LOCKOUT_MAX_SECONDS: 900,
      PASSWORD_HASH_CONCURRENCY: 2,
      MAILER: 'console',
    });
  });

  it('production requires an explicit APP_BASE_DOMAIN and refuses the console (link-logging) mailer', () => {
    expect(() =>
      parseApiEnv({ ...base, NODE_ENV: 'production', DB_SSL: 'verify-full', MAILER: 'none' }),
    ).toThrow(/APP_BASE_DOMAIN/);
    expect(() =>
      parseApiEnv({
        ...base,
        NODE_ENV: 'production',
        DB_SSL: 'verify-full',
        APP_BASE_DOMAIN: 'example.com',
      }),
    ).toThrow(/MAILER/);
  });

  it('MAILER=file needs MAIL_FILE and is refused in production (it writes links to disk)', () => {
    expect(() => parseApiEnv({ ...base, MAILER: 'file' })).toThrow(/MAIL_FILE/);
    expect(parseApiEnv({ ...base, MAILER: 'file', MAIL_FILE: '.mail/outbox.jsonl' }).MAILER).toBe(
      'file',
    );
    expect(() =>
      parseApiEnv({
        ...base,
        NODE_ENV: 'production',
        DB_SSL: 'verify-full',
        APP_BASE_DOMAIN: 'example.com',
        MAILER: 'file',
        MAIL_FILE: '/tmp/outbox.jsonl',
      }),
    ).toThrow(/"file" writes links to disk/);
  });

  it('cookies are Secure (and __Host- prefixed) unless explicitly local', () => {
    expect(cookieSettings({ NODE_ENV: 'production', COOKIE_SECURE: undefined })).toEqual({
      secure: true,
      name: '__Host-sid',
    });
    expect(cookieSettings({ NODE_ENV: 'development', COOKIE_SECURE: undefined })).toEqual({
      secure: false,
      name: 'sid',
    });
    expect(cookieSettings({ NODE_ENV: 'development', COOKIE_SECURE: true }).name).toBe(
      '__Host-sid',
    );
  });

  it('rejects out-of-range auth settings', () => {
    expect(() => parseApiEnv({ ...base, PASSWORD_HASH_CONCURRENCY: '0' })).toThrow(
      /PASSWORD_HASH_CONCURRENCY/,
    );
    expect(() => parseApiEnv({ ...base, LOGIN_MAX_ATTEMPTS: '1' })).toThrow(/LOGIN_MAX_ATTEMPTS/);
  });
});
