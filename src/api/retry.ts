// Retrying transient network failures. Thousands of small requests per session (tiles, elevation) meet
// the occasional dropped connection or 429 / 5xx from a CDN; one hiccup must not leave a hole in the map.
// A request can also stall without failing (a mobile connection that stops answering): without a time limit it
// would wait forever, keep its tile "loading" and hold one of the few request slots, so every request here
// gives up after a while without data and is tried again.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** no data for this long (connecting, waiting for the response, or between two body chunks): give up, retry */
export const STALL_MS = 15_000;

/** a request that received no data for too long */
export class StallError extends Error {}

/** a non-2xx answer (the status is checked as a number: tile URLs are full of numbers) */
export class HttpError extends Error {
  constructor(
    url: string,
    readonly status: number,
  ) {
    super(`${url}: HTTP ${status}`);
  }
}

const LATER = (s: number) => s === 408 || s === 425 || s === 429 || s >= 500;

/** worth another try: the network failed (fetch TypeError), stalled, or the server said "later" (408, 425, 429, 5xx) */
export function isTransient(err: unknown): boolean {
  if (err instanceof TypeError || err instanceof StallError) return true; // connection reset, offline, DNS, stall…
  if (err instanceof HttpError) return LATER(err.status);
  const m = err instanceof Error ? err.message : String(err); // e.g. pmtiles: "Bad response code: 503"
  return /\b(408|425|429|5\d\d)\b/.test(m);
}

/** run `fn` up to `tries` times, waiting 0.4 s, 1.2 s, … (with jitter) between transient failures */
export async function withRetry<T>(fn: () => Promise<T>, retryable: (err: unknown) => boolean = isTransient, tries = 4): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= tries || !retryable(err)) throw err;
      await sleep(400 * 3 ** (attempt - 1) * (0.75 + Math.random() * 0.5));
    }
  }
}

/**
 * GET a whole body as bytes, retrying transient failures. The time limit is on silence, not on the total:
 * a large tile on a slow connection keeps going as long as bytes arrive. 404 gives null with `allow404`;
 * any other non-2xx status is an error.
 */
export function fetchBytes(url: string, opts: { allow404?: boolean; init?: RequestInit; stallMs?: number } = {}): Promise<ArrayBuffer | null> {
  const stallMs = opts.stallMs ?? STALL_MS;
  return withRetry(async () => {
    const ctrl = new AbortController();
    let timer = setTimeout(() => ctrl.abort(), stallMs);
    const kick = () => {
      clearTimeout(timer);
      timer = setTimeout(() => ctrl.abort(), stallMs);
    };
    try {
      const res = await fetch(url, { ...opts.init, signal: ctrl.signal });
      if (res.status === 404 && opts.allow404) {
        res.body?.cancel().catch(() => {});
        return null;
      }
      if (!res.ok) {
        res.body?.cancel().catch(() => {});
        throw new HttpError(url, res.status);
      }
      kick();
      if (!res.body) return await res.arrayBuffer();
      const reader = res.body.getReader();
      const parts: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
        size += value.byteLength;
        kick();
      }
      const out = new Uint8Array(size);
      let o = 0;
      for (const p of parts) {
        out.set(p, o);
        o += p.byteLength;
      }
      return out.buffer;
    } catch (err) {
      if (ctrl.signal.aborted) throw new StallError(`${url}: no data for ${stallMs / 1000} s`);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  });
}
