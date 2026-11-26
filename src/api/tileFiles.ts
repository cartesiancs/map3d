// Tiles published as one object each (tools/tiles): plain GETs the CDN caches (at the edge and in the browser),
// instead of range requests into one large PMTiles archive, which the CDN cannot cache.
//
// Layout, written by tools/tiles/lib/layout.mjs (keep both in step):
//   <base>/<z>/<x>/<y>.json           the archive's gzip JSON tile, stored with Content-Encoding: gzip
//   <base>/index/<z-8>/<bx>/<by>.bin  1 bit per tile of a 256 x 256 block: does the tile exist (gzip, 8192 bytes)
// Every block of the world has an index file (empty ones too), so an empty tile costs no request, and a
// missing index is an error (retried) rather than an empty map.

import { fetchBytes } from "./retry";

export type TileSetRef = { source: string; base: string; zoom: number; indexZoom: number };

/** what the tile readers need from an archive (PMTiles has the same method) */
export interface TileSource {
  getZxy(z: number, x: number, y: number): Promise<{ data: ArrayBuffer } | undefined>;
}

const SHIFT = 8;
const SIDE = 1 << SHIFT;
const INDEX_BYTES = (SIDE * SIDE) / 8;
const INDEX_CACHE = 64;

/** The manifest's `tiles` entry of a layer, when this app can use it: it must describe this very archive. */
export function usableTileSet(ref: unknown, archivePath: string, zoom: number): TileSetRef | null {
  const r = ref as Partial<TileSetRef> | null;
  if (!r || typeof r !== "object") return null;
  const base = archivePath.replace(/\.pmtiles$/, "");
  const safe = typeof r.base === "string" && /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(r.base) && !r.base.split("/").includes("..");
  return r.source === archivePath && safe && r.base === base && r.zoom === zoom && r.indexZoom === zoom - SHIFT ? (r as TileSetRef) : null;
}

/** a body that is still gzip (if something on the way dropped Content-Encoding) */
async function plain(buf: ArrayBuffer): Promise<ArrayBuffer> {
  const b = new Uint8Array(buf);
  if (b.length < 2 || b[0] !== 0x1f || b[1] !== 0x8b) return buf;
  return new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
}

export class FileTileSource implements TileSource {
  private index = new Map<string, Promise<Uint8Array>>();

  /** `root`: the data URL (manifest.json's folder) */
  constructor(
    private root: string,
    readonly set: TileSetRef,
  ) {}

  private bits(bx: number, by: number): Promise<Uint8Array> {
    const key = `${bx}/${by}`;
    let p = this.index.get(key);
    if (p) {
      this.index.delete(key); // most recently used last
      this.index.set(key, p);
      return p;
    }
    p = fetchBytes(`${this.root}/${this.set.base}/index/${this.set.indexZoom}/${bx}/${by}.bin`)
      .then((buf) => plain(buf!))
      .then((buf) => {
        if (buf.byteLength !== INDEX_BYTES) throw new Error(`tile index ${this.set.base} ${key}: ${buf.byteLength} bytes`);
        return new Uint8Array(buf);
      });
    const mine = p;
    mine.catch(() => {
      if (this.index.get(key) === mine) this.index.delete(key); // try again next time
    });
    this.index.set(key, mine);
    if (this.index.size > INDEX_CACHE) this.index.delete(this.index.keys().next().value!);
    return mine;
  }

  async getZxy(z: number, x: number, y: number) {
    const n = 2 ** z;
    if (z !== this.set.zoom || x < 0 || y < 0 || x >= n || y >= n) return undefined;
    const bits = await this.bits(x >> SHIFT, y >> SHIFT);
    const b = (y & (SIDE - 1)) * SIDE + (x & (SIDE - 1));
    if (!(bits[b >> 3] & (1 << (b & 7)))) return undefined; // no such tile: no request
    const buf = await fetchBytes(`${this.root}/${this.set.base}/${z}/${x}/${y}.json`);
    return { data: await plain(buf!) };
  }
}
