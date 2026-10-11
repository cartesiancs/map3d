import type { OsmElement } from './layers';
export type RequestProgress = { phase: 'loading' | 'waiting'; retryAt?: number };
const urls = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];
class MapRequestError extends Error {
  retryable: boolean;
  constructor(message: string, retryable: boolean) { super(message); this.retryable = retryable; }
}
export function retryAfterMilliseconds(value: string | null | undefined, now: number) {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : 0;
}
function abortableWait(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const stop = () => { clearTimeout(timer); signal.removeEventListener('abort', stop); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve(); }, ms);
    signal.addEventListener('abort', stop, { once: true });
  });
}
type ClientOptions = {
  endpoints?: string[];
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  random?: () => number;
};
/** Separate instances allow deterministic tests without shortening real service cooldowns. */
export function createGeometryClient(options: ClientOptions = {}) {
  const fetchData = options.fetch || ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
  const now = options.now || Date.now, wait = options.wait || abortableWait, random = options.random || Math.random;
  const servers = (options.endpoints || urls).map(url => ({ url, notBefore: 0, rateLimits: 0 }));
  const cache = new Map<string, { saved: number; elements: OsmElement[] }>();
  let preferred = 0, nextRequestAt = 0;
  return async function requestGeometry(query: string, signal: AbortSignal, onProgress: (message: string, progress?: RequestProgress) => void): Promise<OsmElement[]> {
    signal.throwIfAborted();
    const cached = cache.get(query);
    if (cached && now() - cached.saved < 5 * 60 * 1000) {
      cache.delete(query); cache.set(query, cached);
      onProgress('Using recently loaded map data…', { phase: 'loading' });
      return cached.elements;
    }
    const deadline = now() + 180000;
    let attempts = 0, transientFailures = 0, networkFailures = 0, lastError: unknown;
    while (attempts < 6 && now() < deadline) {
      signal.throwIfAborted();
      const order = Array.from({ length: servers.length }, (_, offset) => (preferred + offset) % servers.length);
      const available = order.find(index => servers[index].notBefore <= now());
      if (available === undefined) {
        const retryAt = Math.min(...servers.map(s => s.notBefore));
        if (retryAt >= deadline) break; // Never ignore a server's longer Retry-After.
        onProgress(`Map service busy. Retrying automatically in ${Math.ceil((retryAt - now()) / 1000)} s…`, { phase: 'waiting', retryAt });
        await wait(Math.min(1000, Math.max(1, retryAt - now())), signal);
        continue;
      }
      if (now() < nextRequestAt) { await wait(nextRequestAt - now(), signal); continue; }
      const server = servers[available];
      nextRequestAt = now() + 750;
      onProgress(available === 1 ? 'Loading from backup map server…' : attempts ? 'Retrying map data automatically…' : 'Loading map data…', { phase: 'loading' });
      const controller = new AbortController();
      const cancel = () => controller.abort(signal.reason);
      signal.addEventListener('abort', cancel, { once: true });
      const timeout = setTimeout(() => controller.abort('timeout'), Math.min(server.url.startsWith('/') ? 75000 : 40000, deadline - now()));
      attempts++;
      try {
        const response = await fetchData(server.url, { method: 'POST', body: query, signal: controller.signal });
        const retryAfter = retryAfterMilliseconds(response.headers?.get('Retry-After'), now());
        if (response.status === 429 || response.status === 406) {
          preferred = (available + 1) % servers.length;
          server.rateLimits++;
          const backoff = Math.min(120000, 30000 * 2 ** (server.rateLimits - 1));
          server.notBefore = now() + Math.max(retryAfter, backoff) + Math.floor(random() * 1000);
          lastError = new MapRequestError('Map-data services are still busy after automatic retries. Loaded layers are kept.', true);
          continue;
        }
        if (!response.ok) {
          let detail = '';
          if (response.headers?.get('Content-Type')?.includes('application/json')) {
            try { const data = await response.json(); if (typeof data.error === 'string') detail = `${data.error} Loaded layers are kept.`; } catch { /* Fall back to the status code. */ }
          }
          if ([408, 500, 502, 503, 504].includes(response.status)) {
            server.notBefore = now() + Math.max(retryAfter, 2000);
            throw new MapRequestError(detail || `Map-data servers are busy or timed out (HTTP ${response.status}). Loaded layers are kept.`, true);
          }
          throw new MapRequestError(detail || `The map service could not process this layer (HTTP ${response.status}). Loaded layers are kept.`, false);
        }
        let data: { elements?: OsmElement[]; remark?: string };
        try { data = await response.json(); }
        catch { throw new MapRequestError('The map service returned an unreadable response. Loaded layers are kept.', true); }
        if (data.remark) throw new MapRequestError('The map service could not finish loading this area. Loaded layers are kept.', true);
        if (!Array.isArray(data.elements)) throw new MapRequestError('The map service returned an incomplete response. Loaded layers are kept.', true);
        signal.throwIfAborted();
        preferred = available; server.rateLimits = 0;
        // Small spacing prevents rapid successive batches from creating a burst.
        server.notBefore = 0;
        cache.delete(query); cache.set(query, { saved: now(), elements: data.elements });
        while (cache.size > 12) cache.delete(cache.keys().next().value!);
        return data.elements;
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof MapRequestError && !error.retryable) throw error;
        // Try the other service even if rendering delayed us past this server's cooldown.
        preferred = (available + 1) % servers.length;
        if (error instanceof MapRequestError) transientFailures++; else networkFailures++;
        server.notBefore = Math.max(server.notBefore, now() + Math.min(30000, 2000 * 2 ** Math.max(0, networkFailures - 1)));
        lastError = controller.signal.reason === 'timeout'
          ? new MapRequestError('Map-data servers took too long to respond. Loaded layers are kept.', true)
          : error;
        // Direct upstream errors stop early; gateway cooldowns get the full retry budget.
        if (transientFailures >= 2 && !server.url.startsWith('/')) break;
      } finally {
        clearTimeout(timeout); signal.removeEventListener('abort', cancel);
      }
    }
    if (lastError instanceof MapRequestError) throw lastError;
    throw new Error('Could not reach the map-data servers after automatic retries. Loaded layers are kept.');
  };
}
// Other static hosts can explicitly opt into direct requests; Cloudflare and
// Vite use the same-origin service, which can identify the app to Overpass.
export const requestGeometry = createGeometryClient(import.meta.env && import.meta.env.VITE_MAP_DATA_TRANSPORT !== 'direct' ? { endpoints: ['/api/interpreter'] } : {});
