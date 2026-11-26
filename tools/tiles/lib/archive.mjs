// Sequential reading of a PMTiles archive (a local file or a URL) for publishing it tile by tile.

import { open, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { PMTiles, ResolvedValueCache } from "pmtiles";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Byte ranges of a local file or of a URL (HTTP Range, retried). Also a pmtiles `Source`. */
export class ByteSource {
  /** @param {string} src path or http(s) URL */
  static async open(src) {
    if (/^https?:\/\//.test(src)) {
      const res = await fetch(src, { method: "HEAD" });
      if (!res.ok) throw new Error(`${src}: HTTP ${res.status}`);
      const size = Number(res.headers.get("content-length"));
      if (!Number.isFinite(size) || size <= 0) throw new Error(`${src}: no content-length`);
      return new ByteSource(src, size, null);
    }
    const handle = await open(src, "r");
    return new ByteSource(src, (await stat(src)).size, handle);
  }

  constructor(key, size, handle) {
    this.key = key;
    this.size = size;
    this.handle = handle;
    this.region = null;
    this.reads = 0;
    this.bytesRead = 0;
  }

  getKey() {
    return this.key;
  }

  async read(offset, length) {
    if (offset < 0 || length < 0 || offset + length > this.size) throw new Error(`read ${offset}+${length} outside ${this.size}`);
    this.reads++;
    this.bytesRead += length;
    if (this.handle) {
      const buf = Buffer.allocUnsafe(length);
      let done = 0;
      while (done < length) {
        const { bytesRead } = await this.handle.read(buf, done, length - done, offset + done);
        if (bytesRead === 0) throw new Error(`unexpected end of ${this.key} at ${offset + done}`);
        done += bytesRead;
      }
      return buf;
    }
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await fetch(this.key, {
          headers: { range: `bytes=${offset}-${offset + length - 1}` },
          signal: AbortSignal.timeout(Math.ceil(Math.max(60_000, length / 50))), // >= 50 KB/s
        });
        if (res.status !== 206) throw new Error(`HTTP ${res.status} (expected 206)`);
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length !== length) throw new Error(`got ${buf.length} bytes, expected ${length}`);
        return buf;
      } catch (err) {
        if (attempt >= 6) throw new Error(`${this.key} bytes ${offset}+${length}: ${err.message ?? err}`);
        await sleep(1000 * 2 ** attempt);
      }
    }
  }

  /** keep [offset, offset + length) in memory: the leaf directories, read once instead of one by one */
  async preload(offset, length) {
    this.region = { offset, data: await this.read(offset, length) };
  }

  /** pmtiles Source: headers and directories */
  async getBytes(offset, length) {
    length = Math.min(length, this.size - offset); // the 16 KB header read of a smaller archive
    const r = this.region;
    const buf =
      r && offset >= r.offset && offset + length <= r.offset + r.data.length
        ? r.data.subarray(offset - r.offset, offset - r.offset + length)
        : await this.read(offset, length);
    return { data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
  }

  async close() {
    await this.handle?.close();
  }
}

/** Header, a fingerprint of the archive (header + root directory bytes) and a walk over all tile entries. */
export async function openArchive(src) {
  const source = await ByteSource.open(src);
  const pm = new PMTiles(source, new ResolvedValueCache(64));
  const header = await pm.getHeader();
  const first = await source.read(0, Math.min(16384, source.size));
  const fingerprint = createHash("sha256").update(first).digest("hex");
  if (header.leafDirectoryLength > 0 && header.leafDirectoryLength <= 1024 * 1024 * 1024)
    await source.preload(header.leafDirectoryOffset, header.leafDirectoryLength);

  /** tile entries in tile-id order (leaf directories expanded); runLength >= 1 */
  async function* entries() {
    async function* walk(offset, length, depth) {
      if (depth > 4) throw new Error("directory nesting too deep");
      const dir = await pm.cache.getDirectory(source, offset, length, header);
      for (const e of dir) {
        if (e.runLength === 0) yield* walk(header.leafDirectoryOffset + e.offset, e.length, depth + 1);
        else yield e;
      }
    }
    yield* walk(header.rootDirectoryOffset, header.rootDirectoryLength, 0);
  }

  return { source, header, fingerprint, entries };
}
