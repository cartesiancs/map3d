// Retrying transient network failures. Thousands of small range requests per session (tiles, elevation) meet
// the occasional dropped connection or 429 / 5xx from a CDN; one hiccup must not leave a hole in the map.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** worth another try: the network failed (fetch TypeError) or the server said "later" (408, 425, 429, 5xx) */
export function isTransient(err: unknown): boolean {
  if (err instanceof TypeError) return true; // fetch: connection reset, offline, DNS…
  const m = err instanceof Error ? err.message : String(err);
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

/** fetch that retries transient failures; other responses (404 …) are returned as they are */
export function fetchRetry(input: string, init?: RequestInit): Promise<Response> {
  return withRetry(async () => {
    const res = await fetch(input, init);
    if (res.status === 408 || res.status === 425 || res.status === 429 || res.status >= 500) throw new Error(`${input}: HTTP ${res.status}`);
    return res;
  });
}
