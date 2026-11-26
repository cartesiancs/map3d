// Self-hosted replacement for the two Overpass queries (buildings, roads).
//
// Data: PMTiles archives on Cloudflare R2 built by the map3d-osm pipeline, and for the layers that are also
// published tile by tile (tools/tiles; manifest.json `tiles`), one CDN-cached object per tile (tileFiles.ts).
// Every z14 tile holds, unclipped,
// each OSM feature that touches it, as gzip JSON:
//   { v: 1, z, x, y, f: [{ t: "w" | "r", id, tags, g: parts -> rings -> [lon0, lat0, dlon1, dlat1, ...] }] }
// with coordinates in 1e-7 degree integers (first point absolute, then deltas).
// A query reads the tiles covering the bbox and keeps the features that have a vertex inside the bbox or a
// segment crossing it, which matches what Overpass returns for `way[...](bbox)` / `relation[...](bbox)`.

import { EtagMismatch, FetchSource, PMTiles, RangeResponse, SharedPromiseCache, Source } from "pmtiles";
import { StallError, fetchBytes, isTransient, withRetry } from "./retry";
import { FileTileSource, TileSource, usableTileSet } from "./tileFiles";
import { OverlayTile, fetchOverlayTile, overlayIndexCached } from "./overlay";
import { ArchiveRpc, CachingSource, IN_WORKER, RemoteCache, RpcReply, callMain } from "./pmtilesShared";

const DATA_URL = (import.meta.env.VITE_OSM_DATA_URL ?? "https://cdn.map3d.fleet.im").replace(/\/+$/, "");
const ZOOM = 14;
const MAX_TILES = 2500;
const CONCURRENCY = 8;
const E7 = 1e7;
const MAX_LAT = 85.0511287798066;

export type BBox = { south: number; west: number; north: number; east: number };
type Ring = [number, number][]; // [lon, lat]
export type OsmFeature = {
  type: "way" | "relation";
  id: number;
  tags: Record<string, string>;
  /** way: [[line]]; relation: polygons -> rings (ring 0 outer, then holes) */
  parts: Ring[][];
};
type Layer = "buildings" | "roads" | "water";
/** tile zoom of each layer (water: WATER_Z in three/tiles/water.ts) */
const LAYER_ZOOM: Record<Layer, number> = { buildings: ZOOM, roads: ZOOM, water: 10 };
/** `water`: sea polygons as z10 tiles (optional: older manifests have none).
 *  `tiles`: layers also published as one object per tile (tools/tiles), used when they match the archive. */
type Manifest = { version: string; buildings: string; roads: string; osmTimestamp: string; water?: string; tiles?: Partial<Record<Layer, unknown>> };
type TileFeature = { t: "w" | "r"; id: number; tags: Record<string, string>; g: number[][][] };

/** a range read is small (one tile or directory); past this it has stalled */
const RANGE_TIMEOUT_MS = 45_000;

/** PMTiles range reads with a time limit and retries of transient failures (an ETag change is left to PMTiles,
 *  which reloads) */
class RetrySource implements Source {
  private inner: FetchSource;
  constructor(url: string) {
    this.inner = new FetchSource(url);
  }
  getKey() {
    return this.inner.getKey();
  }
  getBytes(offset: number, length: number, signal?: AbortSignal, etag?: string): Promise<RangeResponse> {
    return withRetry(
      async () => {
        const ctrl = new AbortController();
        const forward = () => ctrl.abort();
        signal?.addEventListener("abort", forward);
        const timer = setTimeout(() => ctrl.abort(), RANGE_TIMEOUT_MS);
        try {
          return await this.inner.getBytes(offset, length, ctrl.signal, etag);
        } catch (err) {
          if (ctrl.signal.aborted && !signal?.aborted) throw new StallError(`${this.getKey()} bytes ${offset}+${length}: timed out`);
          throw err;
        } finally {
          clearTimeout(timer);
          signal?.removeEventListener("abort", forward);
        }
      },
      (err) => !(err instanceof EtagMismatch) && !signal?.aborted && isTransient(err),
    );
  }
}

type Archives = { buildings: TileSource; roads: TileSource; water: TileSource | null; manifest: Manifest };
let archives: Promise<Archives> | null = null;

// Main thread: the one place that reads manifest.json, headers and directories (workers ask it, see
// pmtilesShared.ts). Tile bytes are read where they are decoded, through a CachingSource.
const mainCache = IN_WORKER ? null : new SharedPromiseCache(512);
const mainSources = new Map<string, CachingSource>();
const remoteCache = IN_WORKER ? new RemoteCache() : null;

function loadManifest(): Promise<Manifest> {
  if (IN_WORKER) return callMain<Manifest>({ op: "manifest" });
  return fetchBytes(`${DATA_URL}/manifest.json`).then((buf) => JSON.parse(new TextDecoder().decode(buf!)) as Manifest);
}

/** retries inside, cached tile bytes outside: a retried read is cached once it succeeds */
function openArchive(file: string) {
  const url = `${DATA_URL}/${file}`;
  const source = new CachingSource(new RetrySource(url));
  if (remoteCache) return new PMTiles(source, remoteCache);
  mainSources.set(url, source);
  return new PMTiles(source, mainCache!);
}

/** the layer's published tiles when the manifest lists them for this archive, else its PMTiles archive */
function openLayer(manifest: Manifest, layer: Layer): TileSource | null {
  const archivePath = manifest[layer];
  if (!archivePath) return null;
  const listed = manifest.tiles?.[layer];
  const set = listed ? usableTileSet(listed, archivePath, LAYER_ZOOM[layer]) : null;
  if (listed && !set) console.warn(`manifest tiles.${layer} does not match ${archivePath}: reading the archive`);
  return set ? new FileTileSource(DATA_URL, set) : openArchive(archivePath);
}

export function getArchives() {
  archives ??= loadManifest()
    .then((manifest) => ({
      manifest,
      buildings: openLayer(manifest, "buildings")!,
      roads: openLayer(manifest, "roads")!,
      water: openLayer(manifest, "water"),
    }))
    .catch((err) => {
      archives = null; // allow a retry on the next request
      throw err;
    });
  return archives;
}

/** Main thread: answer a worker's `callMain` from the page-wide manifest and PMTiles cache. */
export async function serveArchiveRpc(id: number, req: ArchiveRpc): Promise<RpcReply> {
  try {
    const { manifest } = await getArchives();
    if (req.op === "manifest") return { rpcReply: id, value: manifest };
    const source = mainSources.get(req.url);
    if (!source) throw new Error(`unknown archive ${req.url}`);
    const cache = mainCache!;
    switch (req.op) {
      case "header":
        return { rpcReply: id, value: await cache.getHeader(source) };
      case "dir": {
        const header = await cache.getHeader(source);
        // the worker's offsets come from its copy of the header: they only apply to the same archive version
        if ((req.etag ?? "") !== (header.etag ?? "")) throw new EtagMismatch("archive changed since the worker read its header");
        return { rpcReply: id, value: await cache.getDirectory(source, req.offset, req.length, header) };
      }
      case "invalidate":
        await cache.invalidate(source);
        return { rpcReply: id };
    }
  } catch (err) {
    return { rpcReply: id, error: err instanceof Error ? err.message : String(err), etagMismatch: err instanceof EtagMismatch };
  }
}

const lonToTileX = (lon: number) => ((lon + 180) / 360) * 2 ** ZOOM;
function latToTileY(lat: number) {
  const r = (Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)) * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** ZOOM;
}

function decodeRing(arr: number[]): Ring {
  const pts: Ring = new Array(arr.length / 2);
  let x = 0;
  let y = 0;
  for (let i = 0; i < arr.length; i += 2) {
    x += arr[i];
    y += arr[i + 1];
    pts[i / 2] = [x / E7, y / E7];
  }
  return pts;
}

// Liang–Barsky: does segment (x0,y0)-(x1,y1) touch the rectangle?
function segmentIntersectsRect(x0: number, y0: number, x1: number, y1: number, b: BBox) {
  let t0 = 0;
  let t1 = 1;
  const dx = x1 - x0;
  const dy = y1 - y0;
  const p = [-dx, dx, -dy, dy];
  const q = [x0 - b.west, b.east - x0, y0 - b.south, b.north - y0];
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i] < 0) return false;
    } else {
      const t = q[i] / p[i];
      if (p[i] < 0) {
        if (t > t1) return false;
        if (t > t0) t0 = t;
      } else {
        if (t < t0) return false;
        if (t < t1) t1 = t;
      }
    }
  }
  return true;
}

function partsIntersectBBox(parts: Ring[][], b: BBox) {
  for (const part of parts) {
    for (const ring of part) {
      if (ring.length === 1) {
        const [x, y] = ring[0];
        if (x >= b.west && x <= b.east && y >= b.south && y <= b.north) return true;
        continue;
      }
      for (let i = 0; i < ring.length - 1; i++) {
        if (segmentIntersectsRect(ring[i][0], ring[i][1], ring[i + 1][0], ring[i + 1][1], b)) return true;
      }
    }
  }
  return false;
}

/** Edits of the tiles around the bbox (one ring wider: buildings reach into neighbouring tiles). */
async function overlayFor(bbox: BBox): Promise<OverlayTile> {
  const index = await overlayIndexCached();
  const n = 2 ** ZOOM;
  const x0 = Math.floor(lonToTileX(bbox.west)) - 1, x1 = Math.floor(lonToTileX(bbox.east)) + 1;
  const y0 = Math.floor(latToTileY(bbox.north)) - 1, y1 = Math.floor(latToTileY(bbox.south)) + 1;
  const jobs: Promise<OverlayTile>[] = [];
  for (let x = Math.max(0, x0); x <= Math.min(n - 1, x1); x++) {
    for (let y = Math.max(0, y0); y <= Math.min(n - 1, y1); y++) {
      const rev = index.tiles[`${x}/${y}`];
      if (rev !== undefined) jobs.push(fetchOverlayTile(x, y, rev));
    }
  }
  const tiles = await Promise.all(jobs);
  return { hide: tiles.flatMap((t) => t.hide), add: tiles.flatMap((t) => t.add) };
}

async function queryArchive(archive: TileSource, bbox: BBox, overlay: OverlayTile | null = null): Promise<OsmFeature[]> {
  const hidden = new Set(overlay?.hide ?? []);
  const n = 2 ** ZOOM;
  const clamp = (v: number) => Math.max(0, Math.min(n - 1, v));
  const xMin = clamp(Math.floor(lonToTileX(bbox.west)));
  const xMax = clamp(Math.floor(lonToTileX(bbox.east)));
  const yMin = clamp(Math.floor(latToTileY(bbox.north)));
  const yMax = clamp(Math.floor(latToTileY(bbox.south)));
  const coords: [number, number][] = [];
  for (let x = xMin; x <= xMax; x++) for (let y = yMin; y <= yMax; y++) coords.push([x, y]);
  if (coords.length > MAX_TILES) throw new Error(`Area too large: needs ${coords.length} tiles (max ${MAX_TILES})`);

  const seen = new Map<string, OsmFeature | null>(); // null = present but outside the bbox
  const decoder = new TextDecoder();
  let next = 0;
  async function worker() {
    while (next < coords.length) {
      const [x, y] = coords[next++];
      const tile = await archive.getZxy(ZOOM, x, y); // plain JSON bytes from either source
      if (!tile) continue;
      const { f } = JSON.parse(decoder.decode(tile.data)) as { f: TileFeature[] };
      for (const feat of f) {
        if (feat.t === "w" && hidden.has(feat.id)) continue; // replaced by an approved edit
        const key = feat.t + feat.id;
        if (seen.has(key)) continue; // unclipped: the same copy is in every tile it touches
        const parts = feat.g.map((part) => part.map(decodeRing));
        seen.set(
          key,
          partsIntersectBBox(parts, bbox) ? { type: feat.t === "w" ? "way" : "relation", id: feat.id, tags: feat.tags, parts } : null,
        );
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, coords.length) }, worker));
  // approved edits and new buildings, same rule as the OSM features
  for (const feat of overlay?.add ?? []) {
    const key = feat.t + feat.id;
    if (seen.has(key)) continue;
    const parts = feat.g.map((part) => part.map(decodeRing));
    seen.set(key, partsIntersectBBox(parts, bbox) ? { type: feat.t === "w" ? "way" : "relation", id: feat.id, tags: feat.tags, parts } : null);
  }

  // Overpass order: ways before relations, each by ascending id
  return [...seen.values()]
    .filter((f): f is OsmFeature => f !== null)
    .sort((a, b) => (a.type === b.type ? a.id - b.id : a.type === "way" ? -1 : 1));
}

/** Same result as Overpass `(way["building"](bbox); relation["building"](bbox););`, with approved edits applied */
export async function fetchBuildings(bbox: BBox) {
  const [archives, overlay] = await Promise.all([getArchives(), overlayFor(bbox)]);
  return queryArchive(archives.buildings, bbox, overlay);
}

/** Same result as Overpass `way["highway"](bbox);` */
export async function fetchRoads(bbox: BBox) {
  return queryArchive((await getArchives()).roads, bbox);
}

/** Way geometry as Overpass `out geom` returns it (node list, closing node repeated for closed ways). */
export function wayGeometry(f: OsmFeature): { lat: number; lon: number }[] | undefined {
  if (f.type !== "way") return undefined; // Overpass puts relation geometry on members, not on the element
  return f.parts[0][0].map(([lon, lat]) => ({ lat, lon }));
}
