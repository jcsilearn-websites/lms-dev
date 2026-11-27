import { Component, type ErrorInfo, type ReactNode, useEffect } from 'react';
import { errorReporter, isChunkError } from '../shared/errors/clientErrors';
import { Button } from '../shared/ui/button';

// The global error boundary (step 14b-2 part D). A render error anywhere below it shows this page instead of a white screen, reports ONE scrubbed
// crash report (shared/errors/clientErrors.ts) and offers a reload. A failed lazy chunk (a new release replaced the files an open tab was about to load)
// is the common case: the page says so, and a reload fetches the new shell (the service worker's shell is network-first, so the reload is current).

/** The fallback page: plain markup and a button, nothing that could itself fail (no query, no router, no data). */
export function CrashPage({ error, reset }: { error: unknown; reset?: () => void }) {
  const chunk = isChunkError(error);
  return (
    <main className="mx-auto max-w-lg p-6 sm:p-10">
      <div role="alert" className="rounded-md border border-danger p-6 text-center">
        <h1 className="text-xl font-semibold">
          {chunk ? 'A new version is available' : 'Something went wrong'}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {chunk
            ? 'This page could not load because the application was updated. Reload to get the new version. Your work in an exam is kept in this browser.'
            : 'The page stopped working. We have been told. Reload to carry on; if it happens again, tell your college.'}
        </p>
        <div className="mt-4 flex flex-wrap justify-center gap-2">
          <Button onClick={() => window.location.reload()}>Reload the page</Button>
          {reset && (
            <Button variant="secondary" onClick={reset}>
              Try again
            </Button>
          )}
          <a
            href="/"
            className="inline-flex min-h-11 items-center rounded-md px-4 text-sm underline sm:min-h-9"
          >
            Go to the home page
          </a>
        </div>
      </div>
    </main>
  );
}

interface State {
  error: unknown;
  failed: boolean;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { error: null, failed: false };

  static getDerivedStateFromError(error: unknown): State {
    return { error, failed: true };
  }

  override componentDidCatch(error: unknown, _info: ErrorInfo): void {
    errorReporter.report('render', error);
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return <CrashPage error={this.state.error} />;
  }
}

/** The router's default error component: a crash inside one route reports and shows the same page inside the layout. */
export function RouteCrash({ error, reset }: { error: unknown; reset: () => void }) {
  useEffect(() => {
    errorReporter.report('render', error);
  }, [error]);
  return <CrashPage error={error} reset={reset} />;
}
