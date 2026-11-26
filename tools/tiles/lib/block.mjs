// Stores one block: reads its tiles from the archive (nearby ranges together, a few reads at a time), uploads
// every tile, then the block's index file. Runs inside a worker thread (worker.mjs).

import { gzipSync } from "node:zlib";
import { IMMUTABLE, INDEX_BYTES, indexKey, setBit, tileKey } from "./layout.mjs";

const TILE_META = { contentType: "application/json", contentEncoding: "gzip", cacheControl: IMMUTABLE };
const INDEX_META = { contentType: "application/octet-stream", contentEncoding: "gzip", cacheControl: IMMUTABLE };
/** ranges closer than this are read together (the gap is read and dropped) */
const GAP = 256 * 1024;

export class Limiter {
  constructor(n) {
    this.n = n;
    this.active = 0;
    this.queue = [];
  }
  run(fn) {
    return new Promise((resolve, reject) => {
      const go = () => {
        this.active++;
        fn()
          .then(resolve, reject)
          .finally(() => {
            this.active--;
            this.queue.shift()?.();
          });
      };
      if (this.active < this.n) go();
      else this.queue.push(go);
    });
  }
}

export function blockStore({ source, sink, base, z, iz, gzipped, concurrency, readers, chunkBytes, maxBuffered, onTiles }) {
  const limiter = new Limiter(concurrency);
  const readLimiter = new Limiter(readers);
  const put = (key, body, meta) => limiter.run(() => sink.put(key, body, meta));
  const emptyIndex = gzipSync(new Uint8Array(INDEX_BYTES));

  // memory: bytes reserved for reads whose tiles are not uploaded yet
  let buffered = 0;
  const waiters = new Set();
  const release = (n) => {
    buffered -= n;
    for (const w of waiters) w();
    waiters.clear();
  };
  const reserve = async (n) => {
    while (buffered > 0 && buffered + n > maxBuffered) await new Promise((r) => waiters.add(r));
    buffered += n;
  };

  /** @param flat [x, y, absolute offset, length] per tile */
  async function block(bx, by, flat) {
    const byRange = new Map(); // tiles sharing bytes (deduplicated archives) are read once
    for (let i = 0; i < flat.length; i += 4) {
      const [x, y, offset, length] = [flat[i], flat[i + 1], flat[i + 2], flat[i + 3]];
      const rk = `${offset}:${length}`;
      let r = byRange.get(rk);
      if (!r) byRange.set(rk, (r = { offset, length, tiles: [] }));
      r.tiles.push(x, y);
    }
    const ranges = [...byRange.values()].sort((a, c) => a.offset - c.offset);
    const runs = [];
    let run = null;
    for (const r of ranges) {
      if (run && r.offset - run.end <= GAP && Math.max(run.end, r.offset + r.length) - run.start <= chunkBytes) {
        run.items.push(r);
        run.end = Math.max(run.end, r.offset + r.length);
      } else runs.push((run = { start: r.offset, end: r.offset + r.length, items: [r] }));
    }

    const bits = new Uint8Array(INDEX_BYTES);
    let bytes = 0;
    const storeRun = async (rn) => {
      const len = rn.end - rn.start;
      await reserve(len);
      try {
        const buf = await readLimiter.run(() => source.read(rn.start, len));
        const uploads = [];
        for (const r of rn.items) {
          let data = buf.subarray(r.offset - rn.start, r.offset - rn.start + r.length);
          if (gzipped && (data.length < 18 || data[0] !== 0x1f || data[1] !== 0x8b)) throw new Error(`tile data at byte ${r.offset} is not gzip`);
          if (!gzipped) data = gzipSync(data);
          for (let i = 0; i < r.tiles.length; i += 2) {
            const x = r.tiles[i];
            const y = r.tiles[i + 1];
            setBit(bits, x, y);
            bytes += data.length;
            uploads.push(put(tileKey(base, z, x, y), data, TILE_META).then(() => onTiles(1, data.length)));
          }
        }
        await Promise.all(uploads);
      } finally {
        release(len);
      }
    };
    await Promise.all(runs.map(storeRun));
    await put(indexKey(base, iz, bx, by), gzipSync(bits), INDEX_META);
    return { tiles: flat.length / 4, bytes };
  }

  /** a block without tiles still gets its (empty) index */
  async function empty(bx, by) {
    await put(indexKey(base, iz, bx, by), emptyIndex, INDEX_META);
    return { tiles: 0, bytes: 0 };
  }

  return { block, empty };
}
