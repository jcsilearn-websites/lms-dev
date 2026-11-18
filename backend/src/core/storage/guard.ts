import { OperationTimeoutError, withTimeout } from '../resilience';
import { StorageUnavailableError } from './storage';

// Storage behind a deadline and an error translation (step 14a). A storage failure (disk full, I/O error, permission, too many open
// files, a deadline) must reach the client as a clean 503 `storage_unavailable` with Retry-After, never as a 500 with a stack trace
// in the logs of an incident that is not a bug. Domain errors (a too-large body, a missing object answered with null) pass through.

const INFRASTRUCTURE_CODES = new Set([
  'ENOSPC',
  'EIO',
  'EACCES',
  'EPERM',
  'EMFILE',
  'ENFILE',
  'EROFS',
  'EBUSY',
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'EAI_AGAIN',
  'EDQUOT',
]);

/** True for an error that says "the storage is unwell", not "the request is wrong". */
export function isStorageInfrastructureError(err: unknown): boolean {
  if (err instanceof OperationTimeoutError || err instanceof StorageUnavailableError) return true;
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && INFRASTRUCTURE_CODES.has(code);
}

// methods that stream a caller-controlled body: only the error translation applies (a slow CLIENT is not a slow storage)
const STREAMING = new Set(['write', 'writeAt']);
// bulk operations over many objects: a long deadline
const BULK = new Set(['putFile', 'replacePrefix', 'removePrefix']);

/**
 * Wraps every async method of a storage object. `timeoutMs`: the deadline of one object operation; `bulkTimeoutMs`: of the bulk
 * operations. Synchronous methods (signing URLs) and non-functions pass through untouched.
 */
export function guardStorage<T extends object>(
  storage: T,
  opts: { timeoutMs: number; bulkTimeoutMs?: number },
): T {
  const bulk = opts.bulkTimeoutMs ?? opts.timeoutMs * 10;
  const translate = (name: string, err: unknown): never => {
    if (isStorageInfrastructureError(err)) {
      throw new StorageUnavailableError(
        err instanceof OperationTimeoutError
          ? `storage ${name} timed out`
          : `storage ${name} failed`,
      );
    }
    throw err;
  };
  return new Proxy(storage, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof value !== 'function' || typeof prop !== 'string') return value;
      return (...args: unknown[]) => {
        let result: unknown;
        try {
          result = (value as (...a: unknown[]) => unknown).apply(target, args);
        } catch (err) {
          return translate(prop, err);
        }
        if (!result || typeof (result as Promise<unknown>).then !== 'function') return result;
        const p = result as Promise<unknown>;
        const limited = STREAMING.has(prop)
          ? p
          : withTimeout(`storage ${prop}`, BULK.has(prop) ? bulk : opts.timeoutMs, () => p);
        return limited.catch((err: unknown) => translate(prop, err));
      };
    },
  });
}
