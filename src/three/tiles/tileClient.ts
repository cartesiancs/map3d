import { handle, JobResult, TileRequest, WorkerJob } from "./tileLoader";
import type { TileData } from "./buildTile";
import { serveArchiveRpc } from "@/api/osmSource";
import type { RpcRequest } from "@/api/pmtilesShared";

// ?worker=0 runs everything on the main thread (only for comparing performance)
const params = typeof location !== "undefined" ? new URLSearchParams(location.search) : new URLSearchParams();
const USE_WORKER = params.get("worker") !== "0" && typeof Worker !== "undefined";
const POOL_SIZE = Math.max(1, Math.min(3, Math.floor((navigator.hardwareConcurrency || 4) / 2)));

type Pending = { resolve: (d: JobResult) => void; reject: (e: Error) => void };

class TileClient {
  private workers: Worker[] = [];
  private pending = new Map<number, Pending>();
  private seq = 0;
  readonly mode = USE_WORKER ? `worker×${POOL_SIZE}` : "main-thread";

  private pool() {
    if (!this.workers.length) {
      for (let i = 0; i < POOL_SIZE; i++) {
        const w = new Worker(new URL("./tile.worker.ts", import.meta.url), { type: "module" });
        w.onmessage = (e: MessageEvent<{ id: number; result?: JobResult; error?: string } | RpcRequest>) => {
          if ("rpc" in e.data) {
            // the worker needs manifest / PMTiles header / directory: served from the page-wide cache
            const { rpc, req } = e.data;
            serveArchiveRpc(rpc, req).then((reply) => w.postMessage(reply));
            return;
          }
          const p = this.pending.get(e.data.id);
          if (!p) return;
          this.pending.delete(e.data.id);
          if (e.data.error === undefined) p.resolve(e.data.result!);
          else p.reject(new Error(e.data.error));
        };
        this.workers.push(w);
      }
    }
    return this.workers;
  }

  /** `route` keeps jobs about the same area on the same worker (its PMTiles and elevation caches get reused). */
  run<T extends JobResult>(job: WorkerJob, route: number, transfer: Transferable[] = []): Promise<T> {
    if (!USE_WORKER) return handle(job) as Promise<T>;
    const workers = this.pool();
    const id = ++this.seq;
    const w = workers[Math.abs(route) % workers.length];
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (d: JobResult) => void, reject });
      w.postMessage({ id, job }, transfer);
    });
  }

  request(req: TileRequest): Promise<TileData> {
    return this.run<TileData>({ kind: "tile", req }, req.x * 31 + req.y);
  }
}

export const tileClient = new TileClient();
