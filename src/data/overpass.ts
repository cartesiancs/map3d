import type { OsmElement } from './layers';
export type RequestProgress = { phase: 'loading' | 'waiting'; retryAt?: number };
const urls = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];
export class GeometryRequestError extends Error {
  retryable:boolean; retryAt:number; attempted:boolean; canSplit:boolean; network:boolean;
  constructor(message:string,retryable=true,retryAt=0,attempted=true,canSplit=false,network=false) {
    super(message);
    this.retryable=retryable;this.retryAt=retryAt;this.attempted=attempted;this.canSplit=canSplit;this.network=network;
  }
}
export function retryAfterMilliseconds(value: string | null | undefined, now: number) {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : 0;
}
export function abortableWait(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const stop = () => { clearTimeout(timer); signal.removeEventListener('abort', stop); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve(); }, ms);
    signal.addEventListener('abort', stop, { once: true });
  });
}
type ClientOptions = {
  endpoints?: string[]; fetch?: typeof globalThis.fetch; now?: () => number;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>; random?: () => number;
};
/** Cooldowns belong to services; query failures and retry counts belong to each job. */
export function createGeometryClient(options: ClientOptions = {}) {
  const fetchData = options.fetch || ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
  const now = options.now || Date.now, wait = options.wait || abortableWait, random = options.random || Math.random;
  const servers = (options.endpoints || urls).map(url => ({ url, notBefore: 0, rateLimits: 0 }));
  const cache = new Map<string, { saved: number; elements: OsmElement[] }>();
  let preferred = 0, nextRequestAt = 0;
  async function attempt(query: string, signal: AbortSignal, onProgress: (message: string, progress?: RequestProgress) => void = () => {}) {
    signal.throwIfAborted();
    const cached = cache.get(query);
    if (cached && now() - cached.saved < 5 * 60 * 1000) {
      onProgress('Using recently loaded map data…', { phase: 'loading' });
      return cached.elements;
    }
    const available = Array.from({length:servers.length}, (_, offset) => (preferred + offset) % servers.length).find(i => servers[i].notBefore <= now());
    if (available === undefined) throw new GeometryRequestError('Map-data services are busy. Loaded layers are kept.', true, Math.min(...servers.map(s => s.notBefore)), false);
    if (now() < nextRequestAt) await wait(nextRequestAt - now(), signal);
    signal.throwIfAborted();
    nextRequestAt = now() + 750;
    const server = servers[available];
    onProgress(available === 1 ? 'Loading from backup map server…' : 'Downloading map data…', {phase:'loading'});
    const controller = new AbortController(), cancel = () => controller.abort(signal.reason);
    signal.addEventListener('abort', cancel, {once:true});
    const timeout = setTimeout(() => controller.abort('timeout'), server.url.startsWith('/') ? 75000 : 35000);
    try {
      const response = await fetchData(server.url, {method:'POST', body:query, signal:controller.signal});
      signal.throwIfAborted();
      const retryAfter = retryAfterMilliseconds(response.headers?.get('Retry-After'), now());
      if (!response.ok) {
        let detail = '', scope = '', split = false;
        if (response.headers?.get('Content-Type')?.includes('application/json')) {
          try { const body = await response.json(); detail = typeof body.error === 'string' ? body.error : ''; scope = body.retryScope; split = body.canSplit === true; } catch { /* Status remains usable. */ }
        }
        signal.throwIfAborted();
        const throttled = [429,406].includes(response.status), serviceWait = throttled || scope === 'service' || (response.status === 503 && !scope && retryAfter > 0);
        if (serviceWait) {
          if (throttled) server.rateLimits++;
          server.notBefore = now() + Math.max(retryAfter, throttled ? Math.min(120000,30000 * 2 ** (server.rateLimits-1)) : 2000) + Math.floor(random()*1000);
        }
        const retryable = throttled || [408,500,502,503,504].includes(response.status);
        const message = detail || (throttled ? 'Map-data services are still busy after automatic retries.' : retryable ? `Map-data servers are busy or timed out (HTTP ${response.status}).` : `The map service could not process this layer (HTTP ${response.status}).`);
        throw new GeometryRequestError(`${message} Loaded layers are kept.`, retryable, serviceWait ? server.notBefore : now()+Math.max(retryAfter,2000), true, !serviceWait && (split || [408,500,502,504].includes(response.status)));
      }
      let data: { elements?: OsmElement[]; remark?: string };
      try { data = await response.json(); } catch { throw new GeometryRequestError('The map service returned an unreadable response. Loaded layers are kept.', true, now()+2000, true, true); }
      signal.throwIfAborted();
      if (!data || data.remark || !Array.isArray(data.elements)) throw new GeometryRequestError('The map service returned incomplete data. Loaded layers are kept.',true,now()+2000,true,true);
      preferred = available; server.rateLimits = 0; server.notBefore = 0;
      cache.delete(query); cache.set(query,{saved:now(),elements:data.elements});
      while (cache.size > 12) cache.delete(cache.keys().next().value!);
      return data.elements;
    } catch (error) {
      // An obsolete boundary must never change service health, preference or cache.
      signal.throwIfAborted();
      preferred = (available+1)%servers.length;
      if (error instanceof GeometryRequestError) {
        if(servers.length>1) error.retryAt=Math.min(error.retryAt,Math.max(now(),Math.min(...servers.map(s=>s.notBefore))));
        throw error;
      }
      throw new GeometryRequestError(controller.signal.reason === 'timeout' ? 'Map-data servers took too long to respond. Loaded layers are kept.' : 'Could not reach the map-data servers after automatic retries. Loaded layers are kept.',true,now()+2000,true,controller.signal.reason === 'timeout',true);
    } finally { clearTimeout(timeout); signal.removeEventListener('abort',cancel); }
  }
  async function request(query: string, signal: AbortSignal, onProgress: (message: string, progress?: RequestProgress) => void) {
    const deadline = now()+180000;
    let attempts=0, transient=0, last: unknown;
    while(attempts<6 && now()<deadline) {
      try { return await attempt(query,signal,onProgress); }
      catch(error) {
        signal.throwIfAborted();
        if (!(error instanceof GeometryRequestError) || !error.retryable) throw error;
        last=error; if(error.attempted) attempts++;
        if(error.attempted && error.canSplit && !error.network && !servers[0].url.startsWith('/') && ++transient>=2) break;
        const retryAt=Math.max(error.retryAt,now()+(error.network?Math.min(30000,2000*2**Math.max(0,attempts-1)):0));
        if(retryAt>=deadline || attempts>=6) break;
        while(now()<retryAt) {
          onProgress(`Map service busy. Retrying automatically in ${Math.ceil((retryAt-now())/1000)} s…`,{phase:'waiting',retryAt});
          await wait(Math.min(1000,retryAt-now()),signal);
        }
      }
    }
    throw last || new Error('Map-data services are unavailable. Loaded layers are kept.');
  }
  return Object.assign(request,{attempt});
}
export const requestGeometry = createGeometryClient(import.meta.env && import.meta.env.VITE_MAP_DATA_TRANSPORT !== 'direct' ? { endpoints: ['/api/interpreter'] } : {});
