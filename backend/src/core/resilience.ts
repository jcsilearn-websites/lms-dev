import { counter } from './telemetry';

// RESILIENCE (step 14a, docs/adr/0024-resilience.md): a deadline on every external call, and a circuit breaker so a provider that is
// down cannot hold every worker slot (or every request) hostage while it times out one call after another.

export class OperationTimeoutError extends Error {
  constructor(
    readonly operation: string,
    readonly timeoutMs: number,
  ) {
    super(`${operation} timed out after ${timeoutMs} ms`);
    this.name = 'OperationTimeoutError';
  }
}

/**
 * Runs `fn` with a hard deadline. `fn` receives an AbortSignal that fires at the deadline (a fetch passes it on); the returned
 * promise rejects with OperationTimeoutError even when `fn` ignores the signal (the late result is dropped, never an unhandled
 * rejection). `timeoutMs <= 0` = no deadline.
 */
export async function withTimeout<T>(
  operation: string,
  timeoutMs: number,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (timeoutMs <= 0) return fn(new AbortController().signal);
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new OperationTimeoutError(operation, timeoutMs);
      controller.abort(err);
      reject(err);
    }, timeoutMs);
  });
  const work = fn(controller.signal);
  work.catch(() => {}); // a result that arrives after the deadline is dropped quietly
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** The breaker is open: the call was NOT made. `retryAfterMs` says when a trial call will be admitted. */
export class CircuitOpenError extends Error {
  constructor(
    readonly circuit: string,
    readonly retryAfterMs: number,
  ) {
    super(`circuit "${circuit}" is open`);
    this.name = 'CircuitOpenError';
  }
}

export type CircuitState = 'closed' | 'open' | 'half_open';

export interface CircuitBreaker {
  readonly name: string;
  state(): CircuitState;
  /**
   * Runs `fn` unless the circuit is open. `isFailure(err)` decides whether an error counts against the provider's health (a
   * rejected recipient does not: the provider answered). Closed: consecutive failures open it. Open: calls are refused until the
   * cooldown has passed; then ONE trial call is admitted (half open): success closes it, failure opens it again for twice as long.
   */
  exec<T>(fn: () => Promise<T>, isFailure?: (err: unknown) => boolean): Promise<T>;
}

export function createCircuitBreaker(opts: {
  name: string;
  /** consecutive failures that open the circuit */
  failureThreshold?: number;
  cooldownMs?: number;
  maxCooldownMs?: number;
  now?: () => number;
  onStateChange?: (to: CircuitState, from: CircuitState) => void;
}): CircuitBreaker {
  const threshold = opts.failureThreshold ?? 5;
  const baseCooldown = opts.cooldownMs ?? 30_000;
  const maxCooldown = opts.maxCooldownMs ?? 300_000;
  const now = opts.now ?? Date.now;
  let state: CircuitState = 'closed';
  let failures = 0;
  let openedAt = 0;
  let cooldown = baseCooldown;
  let trialInFlight = false;

  const set = (to: CircuitState) => {
    if (to === state) return;
    const from = state;
    state = to;
    counter('lms_circuit_breaker_transitions_total', 'circuit breaker state changes').add(1, {
      circuit: opts.name,
      to,
    });
    opts.onStateChange?.(to, from);
  };
  const open = () => {
    openedAt = now();
    set('open');
  };

  return {
    name: opts.name,
    state: () => state,
    async exec(fn, isFailure = () => true) {
      if (state === 'open') {
        const waited = now() - openedAt;
        if (waited < cooldown) {
          counter('lms_circuit_breaker_rejections_total', 'calls refused by an open circuit').add(
            1,
            {
              circuit: opts.name,
            },
          );
          throw new CircuitOpenError(opts.name, cooldown - waited);
        }
        set('half_open');
      }
      if (state === 'half_open') {
        if (trialInFlight) throw new CircuitOpenError(opts.name, 1000);
        trialInFlight = true;
      }
      const trial = state === 'half_open';
      try {
        const result = await fn();
        failures = 0;
        if (trial) cooldown = baseCooldown;
        set('closed');
        return result;
      } catch (err) {
        if (isFailure(err)) {
          failures += 1;
          if (trial) {
            cooldown = Math.min(cooldown * 2, maxCooldown);
            open();
          } else if (failures >= threshold) {
            open();
          }
        } else {
          // the provider answered (a rejected recipient): it is healthy
          failures = 0;
          if (trial) set('closed');
        }
        throw err;
      } finally {
        if (trial) trialInFlight = false;
      }
    },
  };
}
