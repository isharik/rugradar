/** Shared fetch helpers: timeout + never-throw JSON. */

export interface FetchResult<T> {
  ok: boolean;
  data: T | null;
  error?: string;
}

/** GET JSON with an AbortController timeout. Never throws — returns {ok:false}. */
export async function getJson<T>(url: string, timeoutMs: number): Promise<FetchResult<T>> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      headers: { "User-Agent": "RugRadar/0.1 (+a2mcp-risk-oracle)", accept: "application/json" },
    });
    if (!res.ok) return { ok: false, data: null, error: `HTTP ${res.status}` };
    const data = (await res.json()) as T;
    return { ok: true, data };
  } catch (e) {
    return { ok: false, data: null, error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(t);
  }
}

/** POST JSON (used for JSON-RPC). Never throws. */
export async function postJson<T>(
  url: string,
  body: unknown,
  timeoutMs: number,
): Promise<FetchResult<T>> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      signal: ac.signal,
      headers: { "content-type": "application/json", "User-Agent": "RugRadar/0.1" },
      body: JSON.stringify(body),
    });
    if (!res.ok) return { ok: false, data: null, error: `HTTP ${res.status}` };
    const data = (await res.json()) as T;
    return { ok: true, data };
  } catch (e) {
    return { ok: false, data: null, error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(t);
  }
}
