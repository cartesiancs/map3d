// Turns one z14 data tile into GPU-ready arrays. Runs in a Web Worker (or on the main thread with ?worker=0).
//
// - Every feature is stored unclipped in each tile it touches, so a feature is only built by its "owner" tile:
//   the tile that holds its first vertex. Neighbouring tiles then never draw the same building twice.
// - All buildings of a tile go into ONE indexed geometry (one draw call). Vertices are shared between walls and
//   roof (2 per footprint point) and there is no normal buffer: the material uses flat shading, which derives
//   face normals in the fragment shader. That is 2n vertices per building instead of ~5n with normals.

import { ShapeUtils, Vector2 } from "three";
import { Origin, SCALE, buildingHeight, latToTileY, lngToTileX } from "./geo";
import { englishName, isEnglishText } from "@/utils/english";

const E7 = 1e7;

export type TileFeature = { t: "w" | "r"; id: number; tags: Record<string, string>; g: number[][][] };

export type BuildingTileData = {
  layer: "building";
  x: number;
  y: number;
  positions: Float32Array;
  index: Uint16Array | Uint32Array;
  /** per building: vertexStart, vertexCount, indexStart, indexCount */
  ranges: Uint32Array;
  /** per building: minX, minZ, maxX, maxZ, height (scene units) */
  bounds: Float32Array;
  ids: Float64Array;
  /** JSON array of tag objects, parsed lazily on the main thread (only when a building is picked) */
  tagsJson: string;
  /** searchable buildings: [building index, label, secondary text] */
  names: [number, string, string][];
  /** with terrain: ground [lowest, highest] per building and the per-vertex offsets (see terrain.ts) */
  terrain?: { bases: Float32Array; vertexBase: Float32Array; ms: number };
  stats: { buildings: number; triangles: number; fetchMs: number; buildMs: number; bytes: number };
};

export type RoadTileData = {
  layer: "road";
  x: number;
  y: number;
  /** line segment pairs */
  positions: Float32Array;
  /** with terrain: segments split to follow the ground (replace `positions`) and their ground heights */
  terrain?: { positions: Float32Array; heights: Float32Array; ms: number };
  stats: { roads: number; segments: number; fetchMs: number; buildMs: number; bytes: number };
};

export type TileData = BuildingTileData | RoadTileData;

function isOwner(ring: number[], x: number, y: number) {
  return lngToTileX(ring[0] / E7) === x && latToTileY(ring[1] / E7) === y;
}

/** decoded ring as flat [east, north, ...] in scene units (north = -z) */
function project(ring: number[], o: Origin) {
  const out = new Float64Array(ring.length);
  let lon = 0;
  let lat = 0;
  const kx = SCALE * o.cos;
  for (let i = 0; i < ring.length; i += 2) {
    lon += ring[i];
    lat += ring[i + 1];
    out[i] = (lon / E7 - o.lng) * kx;
    out[i + 1] = (lat / E7 - o.lat) * SCALE;
  }
  return out;
}

export function buildBuildingTile(features: TileFeature[], x: number, y: number, o: Origin): BuildingTileData {
  const pos: number[] = [];
  const idx: number[] = [];
  const ranges: number[] = [];
  const bounds: number[] = [];
  const ids: number[] = [];
  const tags: Record<string, string>[] = [];
  const names: [number, string, string][] = [];

  for (const f of features) {
    if (f.t !== "w") continue; // the app never drew relation buildings (no way geometry)
    const ring = f.g[0]?.[0];
    if (!ring || ring.length < 8 || !isOwner(ring, x, y)) continue;
    const flat = project(ring, o);
    let n = flat.length / 2;
    if (flat[0] === flat[2 * n - 2] && flat[1] === flat[2 * n - 1]) n--;
    if (n < 3) continue;

    let area = 0;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      area += flat[2 * i] * flat[2 * j + 1] - flat[2 * j] * flat[2 * i + 1];
    }
    if (area === 0) continue;
    // counter-clockwise footprint (seen from above), so walls face outwards and the roof faces up
    const px = new Float64Array(n);
    const py = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      const i = area > 0 ? k : n - 1 - k;
      px[k] = flat[2 * i];
      py[k] = flat[2 * i + 1];
    }

    const h = buildingHeight(f.tags);
    const v0 = pos.length / 3;
    const i0 = idx.length;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let k = 0; k < n; k++) {
      pos.push(px[k], 0, -py[k]);
      if (px[k] < minX) minX = px[k];
      if (px[k] > maxX) maxX = px[k];
      if (py[k] < minY) minY = py[k];
      if (py[k] > maxY) maxY = py[k];
    }
    for (let k = 0; k < n; k++) pos.push(px[k], h, -py[k]);
    for (let k = 0; k < n; k++) {
      const j = (k + 1) % n;
      idx.push(v0 + k, v0 + j, v0 + n + j, v0 + k, v0 + n + j, v0 + n + k);
    }
    const contour: Vector2[] = [];
    for (let k = 0; k < n; k++) contour.push(new Vector2(px[k], py[k]));
    for (const [a, b, c] of ShapeUtils.triangulateShape(contour, [])) {
      const cross = (px[b] - px[a]) * (py[c] - py[a]) - (py[b] - py[a]) * (px[c] - px[a]);
      if (cross >= 0) idx.push(v0 + n + a, v0 + n + b, v0 + n + c);
      else idx.push(v0 + n + a, v0 + n + c, v0 + n + b);
    }

    const bi = ids.length;
    ranges.push(v0, 2 * n, i0, idx.length - i0);
    bounds.push(minX, -maxY, maxX, -minY, h);
    ids.push(f.id);
    tags.push(f.tags);
    // search shows English only: buildings without an English (Latin-script) name are not listed
    const label = englishName(f.tags);
    if (label) {
      const street = [f.tags["addr:housenumber"], f.tags["addr:street"]].filter(isEnglishText).join(" ");
      names.push([bi, label, street || (f.tags.building && f.tags.building !== "yes" ? f.tags.building.replace(/_/g, " ") : "")]);
    }
  }

  const vertexCount = pos.length / 3;
  return {
    layer: "building",
    x,
    y,
    positions: new Float32Array(pos),
    index: vertexCount < 65536 ? new Uint16Array(idx) : new Uint32Array(idx),
    ranges: new Uint32Array(ranges),
    bounds: new Float32Array(bounds),
    ids: new Float64Array(ids),
    tagsJson: JSON.stringify(tags),
    names,
    stats: { buildings: ids.length, triangles: idx.length / 3, fetchMs: 0, buildMs: 0, bytes: 0 },
  };
}

export function buildRoadTile(features: TileFeature[], x: number, y: number, o: Origin): RoadTileData {
  const pos: number[] = [];
  let roads = 0;
  for (const f of features) {
    if (f.t !== "w") continue;
    const ring = f.g[0]?.[0];
    if (!ring || ring.length < 4 || !isOwner(ring, x, y)) continue;
    const flat = project(ring, o);
    for (let i = 0; i + 3 < flat.length; i += 2) pos.push(flat[i], 0.1, -flat[i + 1], flat[i + 2], 0.1, -flat[i + 3]);
    roads++;
  }
  return {
    layer: "road",
    x,
    y,
    positions: new Float32Array(pos),
    stats: { roads, segments: pos.length / 6, fetchMs: 0, buildMs: 0, bytes: 0 },
  };
}

export function transferables(d: TileData): Transferable[] {
  const extra: Transferable[] = d.terrain
    ? "bases" in d.terrain
      ? [d.terrain.bases.buffer, d.terrain.vertexBase.buffer]
      : [d.terrain.positions.buffer, d.terrain.heights.buffer]
    : [];
  return d.layer === "building"
    ? [d.positions.buffer, d.index.buffer, d.ranges.buffer, d.bounds.buffer, d.ids.buffer, ...extra]
    : [d.positions.buffer, ...extra];
}
