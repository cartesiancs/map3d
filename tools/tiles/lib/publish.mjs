// Publishes one PMTiles archive as one object per tile plus per-block index files (layout.mjs).
//
// The main thread reads the directories once, in tile-id order. Tile ids follow a Hilbert curve, which visits
// every aligned 256 x 256 block of tiles in one stretch, so the tiles of a block arrive together (checked: a
// block that comes back is an error). Each block goes to a worker thread (worker.mjs, block.mjs) that reads its
// tile bytes and uploads them, then the block's index file. A block is recorded as done only after that, so an
// interrupted run resumes at block granularity, and the app never sees an index without its tiles.
// tileset.json, written last, marks a complete upload; the manifest step requires it.

import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Compression, tileIdToZxy } from "pmtiles";
import { BLOCK_SHIFT, FORMAT, FORMAT_VERSION, tilesetKey } from "./layout.mjs";
import { makeSink } from "./sinks.mjs";

const lonToX = (lon, z) => Math.floor(((lon + 180) / 360) * 2 ** z);
const latToY = (lat, z) => {
  const r = (Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
};
/** blocks (index tiles at zoom iz) touched by a lon/lat box */
export function blockRange([w, s, e, n], iz) {
  const max = 2 ** iz - 1;
  const c = (v) => Math.max(0, Math.min(max, v));
  return { x0: c(lonToX(w, iz)), x1: c(lonToX(e, iz)), y0: c(latToY(n, iz)), y1: c(latToY(s, iz)) };
}

/** done blocks of an interrupted run: { "bx/by": [tiles, bytes] } */
async function loadProgress(file, identity, restart) {
  let saved = null;
  if (!restart) {
    try {
      saved = JSON.parse(await readFile(file, "utf8"));
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
  }
  if (saved && (saved.base !== identity.base || saved.fingerprint !== identity.fingerprint || saved.size !== identity.size))
    throw new Error(`${file} belongs to another archive; use --restart to start over`);
  const done = new Map(Object.entries(saved?.done ?? {}));
  let timer = null;
  const save = async () => {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file + ".tmp", JSON.stringify({ ...identity, done: Object.fromEntries(done) }));
    await rename(file + ".tmp", file);
  };
  return {
    done,
    resumed: done.size,
    markDone(k, tiles, bytes) {
      done.set(k, [tiles, bytes]);
      timer ??= setTimeout(() => {
        timer = null;
        save().catch((err) => console.error("progress file:", err));
      }, 2000);
    },
    async flush() {
      clearTimeout(timer);
      timer = null;
      await save();
    },
  };
}

function memoryProgress() {
  const done = new Map();
  return { done, resumed: 0, markDone: (k, tiles, bytes) => done.set(k, [tiles, bytes]), flush: async () => {} };
}

/** worker threads, each with up to `perWorker` blocks in flight */
class Pool {
  constructor(n, workerData, perWorker, onTick) {
    this.perWorker = perWorker;
    this.seq = 0;
    this.calls = new Map();
    this.waiters = [];
    this.workers = Array.from({ length: n }, () => {
      const w = new Worker(new URL("./worker.mjs", import.meta.url), { workerData });
      const slot = { w, inflight: 0 };
      slot.ready = new Promise((r) => (slot.onReady = r));
      w.on("message", (m) => {
        if (m.ready) return slot.onReady();
        if (m.tick) return onTick(m.tick, m.bytes);
        if (m.closed) return slot.onClosed?.();
        const call = this.calls.get(m.id);
        if (!call) return;
        this.calls.delete(m.id);
        slot.inflight--;
        this.waiters.splice(0).forEach((f) => f());
        if (m.error) call.reject(new Error(m.error));
        else call.resolve(m);
      });
      w.on("error", (err) => {
        for (const c of this.calls.values()) c.reject(err);
        this.calls.clear();
      });
      return slot;
    });
  }
  /** resolves with the job's result; waits for a free slot first */
  async run(msg, transfer) {
    await Promise.all(this.workers.map((s) => s.ready));
    for (;;) {
      const slot = this.workers.reduce((a, b) => (b.inflight < a.inflight ? b : a));
      if (slot.inflight < this.perWorker) {
        slot.inflight++;
        const id = ++this.seq;
        const done = new Promise((resolve, reject) => this.calls.set(id, { resolve, reject }));
        slot.w.postMessage({ ...msg, id }, transfer);
        return { done };
      }
      await new Promise((r) => this.waiters.push(r));
    }
  }
  async close() {
    await Promise.all(
      this.workers.map(
        (s) =>
          new Promise((r) => {
            s.onClosed = r;
            s.w.postMessage({ close: true });
            setTimeout(r, 10_000);
          }),
      ),
    );
    await Promise.all(this.workers.map((s) => s.w.terminate()));
  }
}

/**
 * @param o.src          the archive (path or URL) the workers read tile bytes from
 * @param o.archive      openArchive(src) result (directories, header)
 * @param o.archivePath  path of the archive in the bucket (v20261116/buildings.pmtiles)
 * @param o.base         object prefix (layout.baseOf(archivePath))
 * @param o.sinkConfig   { kind: "r2", bucket, concurrency } | { kind: "dir", root } | { kind: "null" }
 * @param o.bbox         [w, s, e, n]: only the blocks it touches (tests; no tileset.json, no progress file)
 * @param o.progressFile resume state (null: none)
 */
export async function publish({ src, archive, archivePath, base, sinkConfig, threads = Math.max(1, Math.min(8, availableParallelism() - 1)), concurrency = 64, readers = 4, chunkBytes = 32 << 20, maxBuffered = 384 << 20, bbox = null, progressFile = null, restart = false, log = console.log }) {
  const { source, header, fingerprint, entries } = archive;
  const z = header.maxZoom;
  if (header.minZoom !== z) throw new Error(`the archive has zooms ${header.minZoom}-${z}; one zoom is expected`);
  const iz = z - BLOCK_SHIFT;
  if (iz < 0) throw new Error(`zoom ${z} is below ${BLOCK_SHIFT}`);
  const gzipped = header.tileCompression === Compression.Gzip;
  if (!gzipped && header.tileCompression !== Compression.None) throw new Error(`unsupported tile compression ${header.tileCompression}`);

  const range = bbox ? blockRange(bbox, iz) : null;
  const inRange = (bx, by) => !range || (bx >= range.x0 && bx <= range.x1 && by >= range.y0 && by <= range.y1);
  const progress = progressFile && !bbox ? await loadProgress(progressFile, { base, fingerprint, size: source.size }, restart) : memoryProgress();

  const stats = { tiles: 0, bytes: 0, indexFiles: 0, emptyIndexFiles: 0, skippedBlocks: progress.resumed, addressed: 0, t0: Date.now(), live: 0, liveBytes: 0 };
  const perThread = Math.max(4, Math.ceil(concurrency / threads));
  const pool = new Pool(
    threads,
    {
      src,
      sink: { ...sinkConfig, concurrency: perThread },
      store: { base, z, iz, gzipped, concurrency: perThread, readers, chunkBytes, maxBuffered: Math.max(64 << 20, Math.floor(maxBuffered / threads)) },
    },
    3,
    (n, b) => ((stats.live += n), (stats.liveBytes += b)),
  );

  let failure = null;
  const pending = new Set();
  const dispatch = async (msg, transfer, k) => {
    if (failure) throw failure;
    const { done } = await pool.run(msg, transfer);
    const p = done.then((r) => {
      progress.markDone(k, r.tiles, r.bytes);
      stats.tiles += r.tiles;
      stats.bytes += r.bytes;
      if (r.tiles) stats.indexFiles++;
      else stats.emptyIndexFiles++;
    });
    pending.add(p);
    p.catch((err) => (failure ??= err)).finally(() => pending.delete(p));
  };

  const total = Number(header.numAddressedTiles) || 0;
  const before = [...progress.done.values()].reduce((a, [n]) => a + n, 0); // stored by an earlier run
  const report = () => {
    const s = (Date.now() - stats.t0) / 1000;
    const rate = stats.live / Math.max(1, s);
    const left = total - before - stats.live;
    log(
      `${(s / 60).toFixed(1)} min: ${stats.live.toLocaleString()} tiles (${(stats.liveBytes / 1e9).toFixed(2)} GB) stored, ` +
        `${rate.toFixed(0)} tiles/s, scanned ${stats.addressed.toLocaleString()}${total ? ` / ${total.toLocaleString()}` : ""}` +
        (total && rate > 0 && !bbox ? `, ~${Math.max(0, left / rate / 60).toFixed(0)} min left` : ""),
    );
  };
  const ticker = setInterval(report, 10_000);
  // Ctrl+C: keep what is done (finished blocks), so the next run continues from there
  const interrupt = async () => {
    clearInterval(ticker);
    log("interrupted: saving progress…");
    await progress.flush();
    log(`${progress.done.size} blocks done are kept; run the same command again to continue`);
    process.exit(130);
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);

  try {
    const seen = new Set();
    let cur = null;
    let flat = [];
    const flush = async () => {
      const k = `${cur.bx}/${cur.by}`;
      if (inRange(cur.bx, cur.by) && !progress.done.has(k)) {
        const arr = new Float64Array(flat);
        await dispatch({ bx: cur.bx, by: cur.by, flat: arr }, [arr.buffer], k);
      }
      flat = [];
    };
    for await (const e of entries()) {
      if (failure) throw failure;
      for (let i = 0; i < e.runLength; i++) {
        const [tz, x, y] = tileIdToZxy(e.tileId + i);
        if (tz !== z) throw new Error(`tile ${tz}/${x}/${y} is outside the archive zoom ${z}`);
        stats.addressed++;
        const bx = x >> BLOCK_SHIFT;
        const by = y >> BLOCK_SHIFT;
        if (!cur || cur.bx !== bx || cur.by !== by) {
          if (cur) await flush();
          const k = `${bx}/${by}`;
          if (seen.has(k)) throw new Error(`block ${k} comes back: the tiles are not in tile-id (Hilbert) order`);
          seen.add(k);
          cur = { bx, by };
        }
        flat.push(x, y, header.tileDataOffset + e.offset, e.length);
      }
    }
    if (cur) await flush();
    if (total && stats.addressed !== total) throw new Error(`the directories list ${stats.addressed} tiles, the header ${total}`);

    // blocks without tiles get an empty index: the app can then treat a missing index as an error
    const side = 2 ** iz;
    for (let bx = 0; bx < side; bx++)
      for (let by = 0; by < side; by++) {
        const k = `${bx}/${by}`;
        if (!seen.has(k) && inRange(bx, by) && !progress.done.has(k)) await dispatch({ bx, by }, [], k);
      }
    while (pending.size) await Promise.all(pending).catch(() => {});
    if (failure) throw failure;
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    clearInterval(ticker);
    while (pending.size) await Promise.allSettled([...pending]);
    await progress.flush();
    await pool.close();
  }
  report();

  // complete: the marker the manifest step requires
  let tileset = null;
  if (!bbox) {
    let tiles = 0;
    let bytes = 0;
    const dataBlocks = [];
    for (const [k, [n, b]] of progress.done) {
      tiles += n;
      bytes += b;
      if (n > 0) dataBlocks.push(k);
    }
    if (total && tiles !== total) throw new Error(`stored ${tiles} tiles in total, the archive has ${total}`);
    if (progress.done.size !== 4 ** iz) throw new Error(`${progress.done.size} index files, expected ${4 ** iz}`);
    tileset = {
      format: FORMAT,
      formatVersion: FORMAT_VERSION,
      complete: true,
      source: archivePath,
      sourceSize: source.size,
      sourceFingerprint: fingerprint,
      zoom: z,
      indexZoom: iz,
      tiles,
      bytes,
      dataBlocks: dataBlocks.sort(),
      createdAt: new Date().toISOString(),
    };
    if (sinkConfig.kind !== "null")
      await makeSink({ ...sinkConfig, concurrency: 2 }).put(tilesetKey(base), Buffer.from(JSON.stringify(tileset)), { contentType: "application/json", cacheControl: "public, max-age=60" });
  }
  return { stats, tileset };
}
