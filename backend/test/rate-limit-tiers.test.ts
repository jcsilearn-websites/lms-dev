import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeApp, type TestApp } from './app';

// EVERY ROUTE HAS A DECLARED RATE-LIMIT TIER (docs/system-design-review.md). The tier is read from what the running app really
// does (the route's config and hooks) and compared with the committed table rate-limit-tiers.txt: a new route, or a changed limit,
// fails here until its tier is written down on purpose (`vitest -u` rewrites the table; the diff is the review).
//
//   none      not limited (health probes only)
//   default   the global limit: RATE_LIMIT_MAX per window, per session (per address when not signed in)
//   custom    the route's own number, same keys, replacing the default
//   strict    counted in the SHARED store on every request, per address and route (on top of default / custom)
//   auth      the credential limits per address (and per e-mail), shared (on top of default)
//   sign-in   RATE_LIMIT_LOGIN_PER_IP attempts and RATE_LIMIT_LOGIN_FAILURES_PER_IP failures per address, plus the e-mail limit

interface Seen {
  key: string;
  isPublic: boolean;
  tier: string;
}

let t: TestApp;
const routes: Seen[] = [];

beforeAll(async () => {
  t = makeApp({ env: { RATE_LIMIT_LOGIN_PER_IP: '10', RATE_LIMIT_LOGIN_PER_EMAIL: '5' } });
  t.app.addHook('onRoute', (route) => {
    for (const method of [route.method].flat().map(String)) {
      if (method === 'HEAD' || method === 'OPTIONS') continue;
      const c = (route.config ?? {}) as {
        public?: boolean;
        rateLimit?: false | { max: number; timeWindow: string };
        strictRateLimit?: { max: number; windowMs: number };
      };
      const hooks = [route.onRequest, route.preHandler]
        .flat()
        .map((f) => (f as { name?: string } | undefined)?.name);
      const parts: string[] = [];
      if (c.rateLimit === false) parts.push('none');
      else if (c.rateLimit) parts.push(`custom ${c.rateLimit.max} per ${c.rateLimit.timeWindow}`);
      else parts.push('default');
      if (c.strictRateLimit) {
        parts.push(
          `strict ${c.strictRateLimit.max} per ${c.strictRateLimit.windowMs / 1000}s per address`,
        );
      }
      if (hooks.includes('signInPerIp')) {
        parts.push('sign-in per address (attempts and failures) and e-mail');
      }
      if (hooks.includes('perIp')) {
        parts.push(hooks.includes('perEmail') ? 'auth per address and e-mail' : 'auth per address');
      }
      routes.push({
        key: `${method} ${route.url}`,
        isPublic: c.public === true,
        tier: parts.join(' + '),
      });
    }
  });
  await t.app.ready();
});
afterAll(async () => {
  await t.close();
});

describe('rate-limit tiers', () => {
  it('every route is in the committed table with the tier it really has', async () => {
    expect(routes.length).toBeGreaterThan(250);
    const table = routes
      .map((r) => `${r.key}  ->  ${r.tier}`)
      .sort()
      .join('\n');
    await expect(`${table}\n`).toMatchFileSnapshot('./rate-limit-tiers.txt');
  });

  it('only health probes are unlimited, and a public route has more than the default unless listed', () => {
    expect(routes.filter((r) => r.tier.startsWith('none') && !r.key.includes('/health/'))).toEqual(
      [],
    );
    // reasons: the sign-in page needs the college name before anything; it reads one row and writes nothing
    const publicOnDefault = ['GET /api/tenant/info'];
    expect(routes.filter((r) => r.isPublic && r.tier === 'default').map((r) => r.key)).toEqual(
      publicOnDefault,
    );
  });
});
