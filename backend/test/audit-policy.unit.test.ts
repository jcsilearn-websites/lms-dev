import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  type Advisory,
  type AuditException,
  advisoriesOf,
  evaluateAudit,
} from '../src/cli/audit-policy';

// Step 14a: the dependency-audit policy (scripts/audit.mjs runs it in CI).

const adv = (over: Partial<Advisory> = {}): Advisory => ({
  id: 'GHSA-aaaa-bbbb-cccc',
  package: 'left-pad',
  severity: 'high',
  title: 'ReDoS',
  vulnerableVersions: '<1.3.1',
  path: 'a>b>left-pad',
  ...over,
});
const exc = (over: Partial<AuditException> = {}): AuditException => ({
  id: 'GHSA-aaaa-bbbb-cccc',
  package: 'left-pad',
  reason: 'Only reachable through a dev-only benchmark tool that never sees untrusted input.',
  reviewedBy: 'owner',
  reviewed: '2026-11-01',
  expires: '2027-01-15',
  ...over,
});
const now = new Date('2026-11-17T00:00:00Z');

describe('dependency audit policy', () => {
  it('fails on a high or critical advisory with no exception, passes below the threshold', () => {
    const v = evaluateAudit({
      advisories: [
        adv(),
        adv({ id: 'GHSA-zzzz-zzzz-zzzz', severity: 'critical' }),
        adv({ id: 'GHSA-mmmm-mmmm-mmmm', severity: 'moderate' }),
      ],
      exceptions: [],
      now,
    });
    expect(v.ok).toBe(false);
    expect(v.failing.map((a) => a.severity)).toEqual(['high', 'critical']);
    expect(v.belowThreshold).toHaveLength(1);
    expect(
      evaluateAudit({ advisories: [adv({ severity: 'moderate' })], exceptions: [], now }).ok,
    ).toBe(true);
  });

  it('a reviewed, unexpired exception covers exactly its advisory in exactly its package', () => {
    const covered = evaluateAudit({ advisories: [adv()], exceptions: [exc()], now });
    expect(covered.ok).toBe(true);
    expect(covered.excepted).toHaveLength(1);
    expect(
      evaluateAudit({ advisories: [adv({ package: 'other' })], exceptions: [exc()], now }).ok,
    ).toBe(false);
    expect(
      evaluateAudit({ advisories: [adv({ id: 'GHSA-xxxx-yyyy-zzzz' })], exceptions: [exc()], now })
        .ok,
    ).toBe(false);
  });

  it('an expired exception stops covering and fails the build; so does an over-long or unexplained one', () => {
    const expired = evaluateAudit({
      advisories: [adv()],
      exceptions: [exc({ expires: '2026-11-10' })],
      now,
    });
    expect(expired.ok).toBe(false);
    expect(expired.exceptionProblems.join()).toMatch(/EXPIRED/);
    const long = evaluateAudit({
      advisories: [],
      exceptions: [exc({ expires: '2028-01-01' })],
      now,
    });
    expect(long.exceptionProblems.join()).toMatch(/more than 90 days/);
    expect(evaluateAudit({ advisories: [], exceptions: [exc({ reason: 'ok' })], now }).ok).toBe(
      false,
    );
    expect(evaluateAudit({ advisories: [], exceptions: [exc({ reviewedBy: '' })], now }).ok).toBe(
      false,
    );
    expect(evaluateAudit({ advisories: [], exceptions: [exc({ id: 'CVE-2020-1' })], now }).ok).toBe(
      false,
    );
  });

  it('reports an exception that matches no advisory any more as stale (it does not fail)', () => {
    const v = evaluateAudit({ advisories: [], exceptions: [exc()], now });
    expect(v.ok).toBe(true);
    expect(v.stale).toHaveLength(1);
  });

  it('reads pnpm audit --json', () => {
    const report = {
      advisories: {
        '1': {
          github_advisory_id: 'GHSA-93q8-gq69-wqmw',
          module_name: 'ansi-regex',
          severity: 'high',
          title: 'ReDoS',
          vulnerable_versions: '>=5.0.0 <5.0.1',
          findings: [{ paths: ['a>b>ansi-regex'] }],
        },
      },
    };
    expect(advisoriesOf(report)).toEqual([
      {
        id: 'GHSA-93q8-gq69-wqmw',
        package: 'ansi-regex',
        severity: 'high',
        title: 'ReDoS',
        vulnerableVersions: '>=5.0.0 <5.0.1',
        path: 'a>b>ansi-regex',
      },
    ]);
    expect(advisoriesOf({})).toEqual([]);
  });

  // The committed audit-allowlist.json: each entry is a time-boxed decision. This pins the picomatch one (GHSA-fc5q-39xc-vjpf):
  // valid and covering today, 30 days long, and the gate fails again the day after it expires.
  it('the committed picomatch exception is valid, short, and stops covering the day after it expires', () => {
    const file = JSON.parse(
      readFileSync(new URL('../../audit-allowlist.json', import.meta.url), 'utf8'),
    ) as { exceptions: AuditException[] };
    const entry = file.exceptions.find((e) => e.id === 'GHSA-fc5q-39xc-vjpf');
    expect(entry).toBeDefined();
    if (!entry) return;
    expect(entry.package).toBe('picomatch');
    const days = (Date.parse(entry.expires) - Date.parse(entry.reviewed)) / 86_400_000;
    expect(days).toBeLessThanOrEqual(30);

    const advisory = adv({ id: entry.id, package: 'picomatch', vulnerableVersions: '<=4.0.7' });
    const reviewDay = new Date(`${entry.reviewed}T12:00:00Z`);
    const lastDay = new Date(`${entry.expires}T12:00:00Z`);
    const dayAfter = new Date(`${entry.expires}T23:59:59Z`);
    dayAfter.setUTCSeconds(dayAfter.getUTCSeconds() + 1);

    for (const at of [reviewDay, lastDay]) {
      const v = evaluateAudit({ advisories: [advisory], exceptions: file.exceptions, now: at });
      expect(v.ok).toBe(true);
      expect(v.excepted).toHaveLength(1);
    }
    const after = evaluateAudit({
      advisories: [advisory],
      exceptions: file.exceptions,
      now: dayAfter,
    });
    expect(after.ok).toBe(false);
    expect(after.failing.map((a) => a.id)).toEqual([entry.id]);
    expect(after.exceptionProblems.join(' ')).toContain('EXPIRED');
  });
});
