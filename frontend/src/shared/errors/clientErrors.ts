import { type ErrorReport, type ReportKind, scrubReport } from '@lms/backend/scrub';
import { ApiError } from '../api/client';

// Crash reports (step 14b-2 part D). What leaves the browser: the kind, a SCRUBBED message and stack (no e-mail address, id, token, host, query or long
// number: @lms/backend/scrub, the same function the API applies again), the route TEMPLATE, the build id. At most 5 a minute and 20 a page, each distinct
// error once; failures of the API itself (ApiError: offline, 4xx, 5xx) are expected and never reported from here (the server saw them). The report goes
// as a plain fetch with the two CSRF headers (it is a normal route), never through api(), so a 401 cannot trigger a redirect from a crash handler.

const PER_MINUTE = 5;
const PER_PAGE = 20;
const BENIGN = /ResizeObserver loop|Non-Error promise rejection captured/i;
const CHUNK =
  /dynamically imported module|Loading chunk|Importing a module script failed|error loading dynamically imported/i;

export const isChunkError = (error: unknown): boolean =>
  CHUNK.test(error instanceof Error ? error.message : String(error ?? ''));

export interface ReporterDeps {
  send: (report: ErrorReport) => void;
  now?: () => number;
  route?: () => string;
  build?: string;
}

export function createErrorReporter(deps: ReporterDeps) {
  const now = deps.now ?? (() => Date.now());
  const recent: number[] = [];
  const seen = new Set<string>();
  let total = 0;
  return {
    /** Returns true when a report was sent. */
    report(kind: ReportKind, error: unknown): boolean {
      if (error instanceof ApiError) return false;
      const message =
        error instanceof Error ? error.message : typeof error === 'string' ? error : '';
      const stack = error instanceof Error ? error.stack : undefined;
      if (!message || BENIGN.test(message)) return false;
      const report = scrubReport({
        kind: isChunkError(error) ? 'chunk' : kind,
        message,
        stack,
        route: deps.route?.() ?? '',
        build: deps.build ?? '',
      });
      const signature = `${report.kind}:${report.message.slice(0, 120)}`;
      if (seen.has(signature)) return false;
      const t = now();
      while (recent.length > 0 && t - (recent[0] as number) > 60_000) recent.shift();
      if (recent.length >= PER_MINUTE || total >= PER_PAGE) return false;
      seen.add(signature);
      recent.push(t);
      total++;
      try {
        deps.send(report);
      } catch {
        // reporting must never throw into the crash handler
      }
      return true;
    },
  };
}

function sendToApi(report: ErrorReport): void {
  void fetch('/api/client-errors', {
    method: 'POST',
    keepalive: true,
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-requested-with': 'lms' },
    body: JSON.stringify(report),
  }).catch(() => {
    // offline: a lost report is not worth a retry loop
  });
}

export const errorReporter = createErrorReporter({
  send: sendToApi,
  route: () => (typeof location === 'undefined' ? '' : location.pathname),
  build: typeof __APP_BUILD__ === 'string' ? __APP_BUILD__ : '',
});

/** window.onerror and unhandledrejection, reported through the shared reporter. Call once. */
export function installGlobalErrorHandlers(target: Window = window): void {
  target.addEventListener('error', (event) => {
    if (event.error) errorReporter.report('unhandled', event.error);
    else if (event.message) errorReporter.report('unhandled', new Error(event.message));
  });
  target.addEventListener('unhandledrejection', (event) => {
    errorReporter.report('rejection', event.reason);
  });
}
