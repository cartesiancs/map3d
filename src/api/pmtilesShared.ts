// Every R2 read is a billed Class B operation, so this module keeps reads of the same bytes from repeating:
//
// - Workers do not fetch manifest.json, PMTiles headers or directories themselves. They ask the main thread,
//   which holds one SharedPromiseCache for the whole page (`RemoteCache` here, `serveArchiveRpc` in osmSource).
//   Without this each worker (up to 3) and the main thread read the same header / directories again.
// - `CachingSource` keeps the raw (still compressed) tile bytes it has read, so a tile dropped from the mesh
//   cache is rebuilt from memory when the camera comes back, instead of being downloaded again.

import { Cache, EtagMismatch, Entry, Header, RangeResponse, Source } from "pmtiles";

export const IN_WORKER =
  typeof (globalThis as any).WorkerGlobalScope !== "undefined" && self instanceof (globalThis as any).WorkerGlobalScope;

/** raw tile bytes kept per thread (compressed, so a few hundred tiles) */
export const TILE_BYTES_BUDGET = 12 * 1024 * 1024;

/** Range reads keyed by offset/length. The archive only changes behind a URL with a new ETag, which surfaces as
 *  EtagMismatch: the whole cache is dropped then. The header read (offset 0) is never cached, so a refresh
 *  after a mismatch really goes to the network. */
export class CachingSource implements Source {
  private reads = new Map<string, Promise<RangeResponse>>(); // insertion order = LRU order
  private sizes = new Map<string, number>(); // resolved entries only
  private total = 0;

  constructor(
    readonly inner: Source,
    private budget = TILE_BYTES_BUDGET,
  ) {}

  getKey() {
    return this.inner.getKey();
  }

  getBytes(offset: number, length: number, signal?: AbortSignal, etag?: string): Promise<RangeResponse> {
    if (offset === 0 || length > this.budget / 4) return this.read(offset, length, signal, etag);
    const key = `${offset}|${length}`;
    const hit = this.reads.get(key);
    if (hit) {
      this.reads.delete(key);
      this.reads.set(key, hit);
      return hit;
    }
    const p = this.read(offset, length, signal, etag);
    this.reads.set(key, p);
    p.then(
      (resp) => {
        if (this.reads.get(key) !== p) return; // cleared meanwhile
        this.sizes.set(key, resp.data.byteLength);
        this.total += resp.data.byteLength;
        this.prune();
      },
      () => {
        if (this.reads.get(key) === p) this.reads.delete(key);
      },
    );
    return p;
  }

  private async read(offset: number, length: number, signal?: AbortSignal, etag?: string) {
    try {
      return await this.inner.getBytes(offset, length, signal, etag);
    } catch (err) {
      if (err instanceof EtagMismatch) this.clear();
      throw err;
    }
  }

  private prune() {
    for (const key of this.reads.keys()) {
      if (this.total <= this.budget) break;
      const size = this.sizes.get(key);
      if (size === undefined) continue; // still loading
      this.reads.delete(key);
      this.sizes.delete(key);
      this.total -= size;
    }
  }

  private clear() {
    this.reads.clear();
    this.sizes.clear();
    this.total = 0;
  }
}

// ---- worker <-> main thread requests ----

export type ArchiveRpc =
  | { op: "manifest" }
  | { op: "header"; url: string }
  | { op: "dir"; url: string; offset: number; length: number; etag?: string }
  | { op: "invalidate"; url: string };

/** worker -> main */
export type RpcRequest = { rpc: number; req: ArchiveRpc };
/** main -> worker */
export type RpcReply = { rpcReply: number; value?: unknown; error?: string; etagMismatch?: boolean };

const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let seq = 0;

/** Worker side: ask the main thread (answered by `serveArchiveRpc` through tileClient). */
export function callMain<T>(req: ArchiveRpc): Promise<T> {
  const id = ++seq;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    (self as unknown as Worker).postMessage({ rpc: id, req } satisfies RpcRequest);
  });
}

/** Worker side: returns true when the message was a reply to `callMain`. */
export function acceptReply(data: unknown): boolean {
  if (!data || typeof data !== "object" || !("rpcReply" in data)) return false;
  const r = data as RpcReply;
  const p = pending.get(r.rpcReply);
  if (!p) return true;
  pending.delete(r.rpcReply);
  if (r.error === undefined) p.resolve(r.value);
  else p.reject(r.etagMismatch ? new EtagMismatch(r.error) : new Error(r.error));
  return true;
}

const MEMO_ENTRIES = 300;

/** Worker side PMTiles cache: headers and directories come from the main thread, each once per worker. */
export class RemoteCache implements Cache {
  private memo = new Map<string, Promise<Header | Entry[]>>();

  private remember<T extends Header | Entry[]>(key: string, load: () => Promise<T>): Promise<T> {
    let p = this.memo.get(key) as Promise<T> | undefined;
    if (p) {
      this.memo.delete(key);
      this.memo.set(key, p);
      return p;
    }
    p = load();
    p.catch(() => {
      if (this.memo.get(key) === p) this.memo.delete(key);
    });
    this.memo.set(key, p);
    if (this.memo.size > MEMO_ENTRIES) this.memo.delete(this.memo.keys().next().value!);
    return p;
  }

  getHeader(source: Source): Promise<Header> {
    const url = source.getKey();
    return this.remember(`h|${url}`, () => callMain<Header>({ op: "header", url }));
  }

  getDirectory(source: Source, offset: number, length: number, header: Header): Promise<Entry[]> {
    const url = source.getKey();
    return this.remember(`d|${url}|${header.etag ?? ""}|${offset}|${length}`, () =>
      callMain<Entry[]>({ op: "dir", url, offset, length, etag: header.etag }),
    );
  }

  async invalidate(source: Source) {
    const url = source.getKey();
    for (const key of [...this.memo.keys()]) if (key === `h|${url}` || key.startsWith(`d|${url}|`)) this.memo.delete(key);
    await callMain({ op: "invalidate", url });
  }
}
