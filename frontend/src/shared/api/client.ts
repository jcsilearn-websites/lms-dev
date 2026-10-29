// Empty base = same origin (Vite dev proxy / reverse proxy). Set VITE_API_BASE_URL otherwise.
const BASE = import.meta.env.VITE_API_BASE_URL ?? '';

export interface ApiResult<T> {
  ok: boolean;
  status: number;
  /** Parsed JSON body typed with a backend contract (success shape on 2xx, error shape otherwise). */
  body: T | null;
}

/** GET a JSON endpoint. `T` is a type from `@lms/backend/contracts`. Network errors reject. */
export async function apiGet<T>(path: string): Promise<ApiResult<T>> {
  const res = await fetch(`${BASE}${path}`, { headers: { accept: 'application/json' } });
  const body = (await res.json().catch(() => null)) as T | null;
  return { ok: res.ok, status: res.status, body };
}
