// Self-hosted replacement for the two Overpass queries (buildings, roads).
//
// Data: PMTiles archives on Cloudflare R2 built by the map3d-osm pipeline. Every z14 tile holds, unclipped,
// each OSM feature that touches it, as gzip JSON:
//   { v: 1, z, x, y, f: [{ t: "w" | "r", id, tags, g: parts -> rings -> [lon0, lat0, dlon1, dlat1, ...] }] }
// with coordinates in 1e-7 degree integers (first point absolute, then deltas).
// A query reads the tiles covering the bbox and keeps the features that have a vertex inside the bbox or a
// segment crossing it, which matches what Overpass returns for `way[...](bbox)` / `relation[...](bbox)`.

import { PMTiles } from "pmtiles";

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
/** `water`: sea polygons as z10 tiles (optional: older manifests have none) */
type Manifest = { version: string; buildings: string; roads: string; osmTimestamp: string; water?: string };
type TileFeature = { t: "w" | "r"; id: number; tags: Record<string, string>; g: number[][][] };

let archives: Promise<{ buildings: PMTiles; roads: PMTiles; water: PMTiles | null; manifest: Manifest }> | null = null;

export function getArchives() {
  archives ??= fetch(`${DATA_URL}/manifest.json`)
    .then((res) => {
      if (!res.ok) throw new Error(`OSM manifest: HTTP ${res.status}`);
      return res.json() as Promise<Manifest>;
    })
    .then((manifest) => ({
      manifest,
      buildings: new PMTiles(`${DATA_URL}/${manifest.buildings}`),
      roads: new PMTiles(`${DATA_URL}/${manifest.roads}`),
      water: manifest.water ? new PMTiles(`${DATA_URL}/${manifest.water}`) : null,
    }))
    .catch((err) => {
      archives = null; // allow a retry on the next request
      throw err;
    });
  return archives;
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

async function queryArchive(archive: PMTiles, bbox: BBox): Promise<OsmFeature[]> {
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
      const tile = await archive.getZxy(ZOOM, x, y); // pmtiles decompresses gzip tiles
      if (!tile) continue;
      const { f } = JSON.parse(decoder.decode(tile.data)) as { f: TileFeature[] };
      for (const feat of f) {
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

  // Overpass order: ways before relations, each by ascending id
  return [...seen.values()]
    .filter((f): f is OsmFeature => f !== null)
    .sort((a, b) => (a.type === b.type ? a.id - b.id : a.type === "way" ? -1 : 1));
}

/** Same result as Overpass `(way["building"](bbox); relation["building"](bbox););` */
export async function fetchBuildings(bbox: BBox) {
  return queryArchive((await getArchives()).buildings, bbox);
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
