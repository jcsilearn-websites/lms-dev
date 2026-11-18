// The dependency-audit POLICY (step 14a, docs/dependency-policy.md): a pure function over the advisories `pnpm audit --json` reports and
// the reviewed-exceptions file (audit-allowlist.json). No imports: scripts/audit.mjs loads this file directly (Node strips the types).
//
//   - an advisory at or above the threshold (default: high) FAILS the build unless a reviewed exception names it;
//   - an exception needs a reason, a reviewer, a review date and an EXPIRY (at most MAX_EXCEPTION_DAYS from the review): an exception is
//     a decision to re-take, not a place to hide;
//   - an expired exception stops covering its advisory (the build fails again), and an exception that no longer matches any advisory is
//     reported as stale (so the file does not collect dead entries).

export type Severity = 'info' | 'low' | 'moderate' | 'high' | 'critical';
const ORDER: Severity[] = ['info', 'low', 'moderate', 'high', 'critical'];

export interface Advisory {
  /** GHSA id (github_advisory_id) */
  id: string;
  package: string;
  severity: Severity;
  title: string;
  vulnerableVersions: string;
  /** one example dependency path */
  path: string;
}

export interface AuditException {
  /** the advisory id, e.g. GHSA-xxxx-xxxx-xxxx */
  id: string;
  package: string;
  /** why it does not matter here / why it cannot be fixed yet */
  reason: string;
  reviewedBy: string;
  /** YYYY-MM-DD */
  reviewed: string;
  /** YYYY-MM-DD: when the decision must be taken again */
  expires: string;
}

export const MAX_EXCEPTION_DAYS = 90;

export interface AuditVerdict {
  ok: boolean;
  /** advisories at or above the threshold with no valid exception */
  failing: Advisory[];
  /** advisories covered by a valid exception */
  excepted: { advisory: Advisory; exception: AuditException }[];
  /** advisories below the threshold (reported, never failing) */
  belowThreshold: Advisory[];
  /** problems with the exceptions file itself */
  exceptionProblems: string[];
  /** exceptions that match no advisory any more */
  stale: AuditException[];
}

const DAY = 86_400_000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Reads the advisories of `pnpm audit --json` (the npm "bulk advisory" shape pnpm prints). */
export function advisoriesOf(report: unknown): Advisory[] {
  const advisories = (report as { advisories?: Record<string, unknown> } | null)?.advisories ?? {};
  const out: Advisory[] = [];
  for (const raw of Object.values(advisories)) {
    const a = raw as {
      github_advisory_id?: string;
      module_name?: string;
      severity?: string;
      title?: string;
      vulnerable_versions?: string;
      findings?: { paths?: string[] }[];
    };
    const severity = (ORDER as string[]).includes(a.severity ?? '')
      ? (a.severity as Severity)
      : 'high';
    out.push({
      id: a.github_advisory_id ?? 'unknown',
      package: a.module_name ?? 'unknown',
      severity,
      title: a.title ?? '',
      vulnerableVersions: a.vulnerable_versions ?? '',
      path: a.findings?.[0]?.paths?.[0] ?? '',
    });
  }
  return out;
}

export function evaluateAudit(opts: {
  advisories: Advisory[];
  exceptions: AuditException[];
  threshold?: Severity;
  now?: Date;
}): AuditVerdict {
  const threshold = opts.threshold ?? 'high';
  const now = (opts.now ?? new Date()).getTime();
  const problems: string[] = [];
  const valid = new Map<string, AuditException>();

  for (const e of opts.exceptions) {
    const where = `exception ${e.id || '(no id)'}`;
    if (!/^GHSA-[a-z0-9-]+$/i.test(e.id ?? '')) problems.push(`${where}: id must be a GHSA id`);
    if (!e.package) problems.push(`${where}: package is required`);
    if ((e.reason ?? '').trim().length < 30)
      problems.push(`${where}: a reason of at least 30 characters is required`);
    if (!e.reviewedBy) problems.push(`${where}: reviewedBy is required`);
    if (!DATE.test(e.reviewed ?? '') || !DATE.test(e.expires ?? '')) {
      problems.push(`${where}: reviewed and expires must be YYYY-MM-DD`);
      continue;
    }
    const reviewed = Date.parse(`${e.reviewed}T00:00:00Z`);
    const expires = Date.parse(`${e.expires}T23:59:59Z`);
    if (expires - reviewed > MAX_EXCEPTION_DAYS * DAY) {
      problems.push(`${where}: expires more than ${MAX_EXCEPTION_DAYS} days after the review`);
      continue;
    }
    if (expires < now) {
      problems.push(`${where}: EXPIRED on ${e.expires}: review it again or fix the dependency`);
      continue;
    }
    valid.set(`${e.id.toUpperCase()}|${e.package}`, e);
  }

  const failing: Advisory[] = [];
  const excepted: AuditVerdict['excepted'] = [];
  const belowThreshold: Advisory[] = [];
  const used = new Set<string>();
  for (const a of opts.advisories) {
    if (ORDER.indexOf(a.severity) < ORDER.indexOf(threshold)) {
      belowThreshold.push(a);
      continue;
    }
    const key = `${a.id.toUpperCase()}|${a.package}`;
    const e = valid.get(key);
    if (e) {
      excepted.push({ advisory: a, exception: e });
      used.add(key);
    } else failing.push(a);
  }
  const stale = opts.exceptions.filter(
    (e) =>
      !opts.advisories.some(
        (a) => a.id.toUpperCase() === (e.id ?? '').toUpperCase() && a.package === e.package,
      ),
  );
  return {
    ok: failing.length === 0 && problems.length === 0,
    failing,
    excepted,
    belowThreshold,
    exceptionProblems: problems,
    stale,
  };
}
