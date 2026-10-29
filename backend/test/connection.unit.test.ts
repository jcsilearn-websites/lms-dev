import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { connectionConfig } from '../src/db/connection';

const url = 'postgresql://u:p@db.example.com:5432/postgres?sslmode=require';

describe('connectionConfig TLS', () => {
  it('off disables TLS and strips libpq sslmode', () => {
    const c = connectionConfig(url, 'off');
    expect(c.ssl).toBe(false);
    expect(c.connectionString).not.toContain('sslmode');
  });
  it('no-verify encrypts without verifying', () => {
    expect(connectionConfig(url, 'no-verify').ssl).toEqual({ rejectUnauthorized: false });
  });
  it('verify-full verifies, using DB_SSL_CA when set', () => {
    expect(connectionConfig(url, 'verify-full').ssl).toEqual({ rejectUnauthorized: true });
    const dir = mkdtempSync(join(tmpdir(), 'lms-ca-'));
    const ca = join(dir, 'ca.crt');
    writeFileSync(ca, '-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----\n');
    expect(connectionConfig(url, 'verify-full', ca).ssl).toMatchObject({
      rejectUnauthorized: true,
      ca: expect.stringContaining('BEGIN CERTIFICATE'),
    });
  });
  it('verify-full fails clearly when the CA file is missing', () => {
    expect(() => connectionConfig(url, 'verify-full', '/nonexistent/ca.crt')).toThrow(/ENOENT/);
  });
});
