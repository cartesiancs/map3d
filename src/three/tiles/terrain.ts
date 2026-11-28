// Terrain, after hjunhuh/earth-shader (src/scene/Terrain.ts, src/app/defaults.ts):
// - elevation: Terrain Tiles on AWS, Terrarium encoding  h = R·256 + G + B/256 − 32768 (meters)
// (the ground map drawn on it is the land / sea SDF of water.ts)
// - heights are clamped to sea level, so the sea is flat and land below sea level stays dry
// - drawn at true scale: meters are converted to horizontal scene units (÷ H_UNIT_M ≈ 2.18), unlike buildings,
//   which keep the map's vertical exaggeration (1 unit = 1 m, see geo.ts)
// Unlike earth-shader (a globe in ECEF via 3d-tiles-renderer), map3d draws a local flat scene, so the meshes are
// built here, in scene coordinates, one per z13 tile. Runs in the tile worker.
//
// The same function (sampleGrid) gives the height of the rendered mesh anywhere: it interpolates on exactly
// the triangles the mesh uses. Buildings, roads and the camera use it, so nothing floats or sinks.

import { H_UNIT_M, Origin, fromScene, latToTileYf, lngToTileXf, tileXfToLng, tileYfToLat, toScene } from "./geo";
import { fetchBytes } from "@/api/retry";
import { decodePng } from "./png";

export const TERRAIN_Z = 13;
/** grid segments per terrain tile side (z13 ≈ 3.7 km at New York → ≈ 58 m spacing) */
export const GRID = 64;
const FLAT_GRID = 4;
/** vertical curtain under tile edges, hides cracks between neighbouring tiles (scene units) */
const SKIRT = 40;
const PX = 256;

export const ELEVATION_URL = (z: number, x: number, y: number) =>
  `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;

/**
 * Heights in scene units at the (GRID+1)² mesh vertices, rows from north. True scale: elevation meters ÷ H_UNIT_M,
 * the same unit as x and z (building heights are not: they stay in meters, exaggerated).
 */
export type TerrainGrid = { x: number; y: number; heights: Float32Array };

export type GroundTileData = {
  layer: "ground";
  x: number;
  y: number;
  flat: boolean;
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  index: Uint16Array;
  /** grid heights (terrain only) for height lookups on the main thread */
  heights: Float32Array | null;
  stats: { minHeight: number; maxHeight: number; fetchMs: number; buildMs: number };
};

/**
 * Terrarium tile → elevation (meters) per pixel. The PNG is decoded from its bytes (png.ts), never through a
 * canvas: a canvas read may not return the stored values, and R carries 256 m per step.
 */
export async function fetchElevation(x: number, y: number) {
  const { data, width, height, channels } = await decodePng((await fetchBytes(ELEVATION_URL(TERRAIN_Z, x, y)))!);
  if (width !== PX || height !== PX) throw new Error(`terrarium ${x}/${y}: ${width}×${height}`);
  const elev = new Float32Array(PX * PX);
  for (let i = 0; i < elev.length; i++) {
    const p = channels * i;
    elev[i] = data[p] * 256 + data[p + 1] + data[p + 2] / 256 - 32768;
  }
  return elev;
}

/**
 * Mesh vertex heights: bilinear between pixel centers, clamped to sea level, in scene units (true scale).
 * `neighbours[dy+1][dx+1]` are the elevation tiles around (x, y) (null if missing). A vertex on a tile edge
 * sits between the last pixel of one tile and the first of the next; reading both makes neighbouring tiles
 * compute the very same edge heights, so the ground has no steps or cracks at tile seams.
 */
export function gridFromElevation(neighbours: (Float32Array | null)[][], x: number, y: number): TerrainGrid {
  const center = neighbours[1][1]!;
  const E = (px: number, py: number) => {
    const dx = px < 0 ? -1 : px >= PX ? 1 : 0;
    const dy = py < 0 ? -1 : py >= PX ? 1 : 0;
    const tile = neighbours[dy + 1][dx + 1];
    if (!tile) return center[Math.min(PX - 1, Math.max(0, py)) * PX + Math.min(PX - 1, Math.max(0, px))];
    return tile[(py - dy * PX) * PX + (px - dx * PX)];
  };
  const W = GRID + 1;
  const heights = new Float32Array(W * W);
  for (let j = 0; j < W; j++) {
    const sy = (j / GRID) * PX - 0.5;
    const y0 = Math.floor(sy);
    const fy = sy - y0;
    for (let i = 0; i < W; i++) {
      const sx = (i / GRID) * PX - 0.5;
      const x0 = Math.floor(sx);
      const fx = sx - x0;
      const top = E(x0, y0) * (1 - fx) + E(x0 + 1, y0) * fx;
      const bottom = E(x0, y0 + 1) * (1 - fx) + E(x0 + 1, y0 + 1) * fx;
      heights[j * W + i] = Math.max(0, top * (1 - fy) + bottom * fy) / H_UNIT_M;
    }
  }
  return { x, y, heights };
}

// worker-local caches: building bases, roads and meshes of the same area share one download + decode
const raw = new Map<string, Promise<Float32Array | null>>();
function getElevation(x: number, y: number, required: boolean): Promise<Float32Array | null> {
  const n = 2 ** TERRAIN_Z;
  const xx = ((x % n) + n) % n; // wrap around the antimeridian
  if (y < 0 || y >= n) return Promise.resolve(null);
  const key = `${xx}/${y}`;
  let e = raw.get(key);
  if (!e) {
    e = fetchElevation(xx, y).catch((err) => {
      raw.delete(key);
      if (required) throw err;
      return null;
    });
    raw.set(key, e);
    if (raw.size > 128) raw.delete(raw.keys().next().value!);
  }
  return required ? e : e.catch(() => null);
}

const grids = new Map<string, Promise<TerrainGrid>>();
export function getGrid(x: number, y: number): Promise<TerrainGrid> {
  const key = `${x}/${y}`;
  let g = grids.get(key);
  if (!g) {
    g = (async () => {
      const rows = await Promise.all(
        [-1, 0, 1].map((dy) => Promise.all([-1, 0, 1].map((dx) => getElevation(x + dx, y + dy, dx === 0 && dy === 0)))),
      );
      return gridFromElevation(rows, x, y);
    })();
    g.catch(() => grids.delete(key));
    grids.set(key, g);
    if (grids.size > 64) grids.delete(grids.keys().next().value!);
  }
  return g;
}

export function terrainTileOf(o: Origin, x: number, z: number) {
  const { lat, lng } = fromScene(o, x, z);
  return { tx: Math.floor(lngToTileXf(lng, TERRAIN_Z)), ty: Math.floor(latToTileYf(lat, TERRAIN_Z)) };
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/**
 * Height of the rendered terrain mesh at scene (x, z). Mesh cells are axis-aligned rectangles in scene space
 * (x depends on longitude only, z on latitude only), split along the NE–SW diagonal like the index buffer.
 */
export function sampleGrid(g: TerrainGrid, o: Origin, x: number, z: number): number {
  const { lat, lng } = fromScene(o, x, z);
  const fx = (lngToTileXf(lng, TERRAIN_Z) - g.x) * GRID;
  const fy = (latToTileYf(lat, TERRAIN_Z) - g.y) * GRID;
  const i = Math.min(GRID - 1, Math.max(0, Math.floor(fx)));
  const j = Math.min(GRID - 1, Math.max(0, Math.floor(fy)));
  const s = clamp01(fx - i);
  const zj = toScene(o, tileYfToLat(g.y + j / GRID, TERRAIN_Z), o.lng)[1];
  const zj1 = toScene(o, tileYfToLat(g.y + (j + 1) / GRID, TERRAIN_Z), o.lng)[1];
  const t = clamp01((z - zj) / (zj1 - zj));
  const W = GRID + 1;
  const h = g.heights;
  const ha = h[j * W + i];
  const hb = h[j * W + i + 1];
  const hc = h[(j + 1) * W + i];
  const hd = h[(j + 1) * W + i + 1];
  return s + t <= 1 ? ha + s * (hb - ha) + t * (hc - ha) : hd + (1 - s) * (hc - hd) + (1 - t) * (hb - hd);
}

/** Ground mesh for one z13 tile: relief from the grid, or flat (ground map only). Positions in scene units. */
export function buildGroundMesh(grid: TerrainGrid | null, x: number, y: number, o: Origin): GroundTileData {
  const flat = grid === null;
  const G = flat ? FLAT_GRID : GRID;
  const W = G + 1;
  const xs = new Float64Array(W);
  const zs = new Float64Array(W);
  for (let i = 0; i < W; i++) xs[i] = toScene(o, o.lat, tileXfToLng(x + i / G, TERRAIN_Z))[0];
  for (let j = 0; j < W; j++) zs[j] = toScene(o, tileYfToLat(y + j / G, TERRAIN_Z), o.lng)[1];
  const hAt = (i: number, j: number) => (flat ? 0 : grid!.heights[j * W + i]);

  const skirtVerts = flat ? 0 : 4 * W;
  const n = W * W + skirtVerts;
  const positions = new Float32Array(n * 3);
  const normals = new Float32Array(n * 3);
  const uvs = new Float32Array(n * 2);
  let minHeight = Infinity;
  let maxHeight = -Infinity;
  for (let j = 0; j < W; j++) {
    for (let i = 0; i < W; i++) {
      const v = j * W + i;
      const h = hAt(i, j);
      minHeight = Math.min(minHeight, h);
      maxHeight = Math.max(maxHeight, h);
      positions.set([xs[i], h, zs[j]], v * 3);
      uvs.set([i / G, j / G], v * 2); // v = 0 at the north edge = first image row (ImageBitmap, flipY off)
      const il = Math.max(0, i - 1);
      const ir = Math.min(G, i + 1);
      const jt = Math.max(0, j - 1);
      const jb = Math.min(G, j + 1);
      const dhdx = (hAt(ir, j) - hAt(il, j)) / (xs[ir] - xs[il]);
      const dhdz = (hAt(i, jb) - hAt(i, jt)) / (zs[jb] - zs[jt]);
      const len = Math.hypot(dhdx, 1, dhdz);
      normals.set([-dhdx / len, 1 / len, -dhdz / len], v * 3);
    }
  }

  const index: number[] = [];
  for (let j = 0; j < G; j++) {
    for (let i = 0; i < G; i++) {
      const a = j * W + i;
      const b = a + 1;
      const c = a + W;
      const d = c + 1;
      index.push(a, c, b, b, c, d); // counter-clockwise seen from above; diagonal b–c (see sampleGrid)
    }
  }

  if (!flat) {
    // skirts: each edge copied SKIRT units lower, joined to the edge (drawn double-sided)
    const edges = [
      Array.from({ length: W }, (_, i) => i), // north
      Array.from({ length: W }, (_, i) => G * W + i), // south
      Array.from({ length: W }, (_, j) => j * W), // west
      Array.from({ length: W }, (_, j) => j * W + G), // east
    ];
    let s = W * W;
    for (const edge of edges) {
      const first = s;
      for (const v of edge) {
        positions.set([positions[v * 3], positions[v * 3 + 1] - SKIRT, positions[v * 3 + 2]], s * 3);
        normals.set(normals.subarray(v * 3, v * 3 + 3), s * 3);
        uvs.set(uvs.subarray(v * 2, v * 2 + 2), s * 2);
        s++;
      }
      for (let k = 0; k < W - 1; k++) index.push(edge[k], first + k, edge[k + 1], edge[k + 1], first + k, first + k + 1);
    }
  }

  return {
    layer: "ground",
    x,
    y,
    flat,
    positions,
    normals,
    uvs,
    index: new Uint16Array(index),
    heights: flat ? null : grid!.heights.slice(),
    stats: { minHeight, maxHeight, fetchMs: 0, buildMs: 0 },
  };
}

/** Ground height of many scene points (async: fetches the grids they need). */
export async function sampler(o: Origin, xz: Float64Array | Float32Array | number[], stride: number) {
  const keys = new Map<string, [number, number]>();
  for (let k = 0; k < xz.length; k += stride) {
    const { tx, ty } = terrainTileOf(o, xz[k], xz[k + 2]);
    keys.set(`${tx}/${ty}`, [tx, ty]);
  }
  const loaded = new Map<string, TerrainGrid>();
  await Promise.all([...keys].map(async ([key, [tx, ty]]) => loaded.set(key, await getGrid(tx, ty))));
  return (x: number, z: number) => {
    const { tx, ty } = terrainTileOf(o, x, z);
    return sampleGrid(loaded.get(`${tx}/${ty}`)!, o, x, z);
  };
}

/**
 * Buildings on slopes: the walls start at the LOWEST ground under the building's ground vertices (no corner
 * floats) and everything above is lifted to the HIGHEST (no building disappears into a hillside); the
 * downhill walls are taller, like a foundation. Ground vertices are the bottom ring of an extruded footprint,
 * or the vertices of a mesh that stand on its ground (`vertexClass` 0, see geo.ts groundClass). Returned as
 * `bases` [low, high] per building and per vertex (class 0 = low, class 1 = high) for the aBase attribute.
 */
export async function computeBuildingBases(positions: Float32Array, ranges: Uint32Array, vertexClass: Uint8Array, o: Origin) {
  const at = await sampler(o, positions, 3);
  const count = ranges.length / 4;
  const bases = new Float32Array(count * 2);
  const vertexBase = new Float32Array(positions.length / 3);
  for (let b = 0; b < count; b++) {
    const v0 = ranges[4 * b];
    const v1 = v0 + ranges[4 * b + 1];
    let low = Infinity;
    let high = -Infinity;
    for (let v = v0; v < v1; v++) {
      if (vertexClass[v] !== 0) continue;
      const h = at(positions[v * 3], positions[v * 3 + 2]);
      low = Math.min(low, h);
      high = Math.max(high, h);
    }
    if (low === Infinity) {
      // nothing on the ground (should not happen): sample every vertex
      for (let v = v0; v < v1; v++) {
        const h = at(positions[v * 3], positions[v * 3 + 2]);
        low = Math.min(low, h);
        high = Math.max(high, h);
      }
    }
    bases[2 * b] = low;
    bases[2 * b + 1] = high;
    for (let v = v0; v < v1; v++) vertexBase[v] = vertexClass[v] === 0 ? low : high;
  }
  return { bases, vertexBase };
}

/**
 * Cell coordinates of a scene point in the global z13 grid: column u (continuous, in cells, linear in x),
 * row v (continuous, in cells, Web Mercator) and the in-cell t measured linearly in z (as the mesh does).
 */
function cellCoords(o: Origin, x: number, z: number) {
  const { lat, lng } = fromScene(o, x, z);
  const u = lngToTileXf(lng, TERRAIN_Z) * GRID;
  const v = latToTileYf(lat, TERRAIN_Z) * GRID;
  const j = Math.floor(v);
  const zj = toScene(o, tileYfToLat(j / GRID, TERRAIN_Z), o.lng)[1];
  const zj1 = toScene(o, tileYfToLat((j + 1) / GRID, TERRAIN_Z), o.lng)[1];
  return { u, v, i: Math.floor(u), j, s: u - Math.floor(u), t: (z - zj) / (zj1 - zj) };
}

/**
 * Roads on terrain. The ground is flat inside each mesh triangle, so a road segment is split exactly where
 * it crosses a grid column, a grid row or a cell diagonal; between those points the drawn line lies on
 * the ground. Every vertex then gets the ground height under it.
 */
export async function computeRoadHeights(positions: Float32Array, o: Origin) {
  const out: number[] = [];
  const zRow = (row: number) => toScene(o, tileYfToLat(row / GRID, TERRAIN_Z), o.lng)[1];
  for (let k = 0; k < positions.length; k += 6) {
    const ax = positions[k], ay = positions[k + 1], az = positions[k + 2];
    const bx = positions[k + 3], bz = positions[k + 5];
    const A = cellCoords(o, ax, az);
    const B = cellCoords(o, bx, bz);
    const params = [0, 1];
    // columns (u is linear along the segment)
    for (let c = Math.min(A.i, B.i) + 1; c <= Math.max(A.i, B.i); c++) params.push((c - A.u) / (B.u - A.u));
    // rows (a row line is a fixed z)
    for (let r = Math.min(A.j, B.j) + 1; r <= Math.max(A.j, B.j); r++) params.push((zRow(r) - az) / (bz - az));
    params.sort((p, q) => p - q);
    // diagonals: inside one cell s + t − 1 is linear along the segment, so it changes sign at most once
    const all = [...params];
    for (let n = 0; n + 1 < params.length; n++) {
      const p0 = params[n];
      const p1 = params[n + 1];
      if (p1 - p0 < 1e-9) continue;
      const pm = (p0 + p1) / 2;
      const m = cellCoords(o, ax + (bx - ax) * pm, az + (bz - az) * pm);
      const f = (p: number) => {
        const q = cellCoords(o, ax + (bx - ax) * p, az + (bz - az) * p);
        // local coordinates of p in the midpoint's cell
        return q.u - m.i + (az + (bz - az) * p - zRow(m.j)) / (zRow(m.j + 1) - zRow(m.j)) - 1;
      };
      const f0 = f(p0);
      const f1 = f(p1);
      if (f0 * f1 < 0) all.push(p0 + (p1 - p0) * (f0 / (f0 - f1)));
    }
    all.sort((p, q) => p - q);
    for (let n = 0; n + 1 < all.length; n++) {
      if (all[n + 1] - all[n] < 1e-9) continue;
      out.push(
        ax + (bx - ax) * all[n], ay, az + (bz - az) * all[n],
        ax + (bx - ax) * all[n + 1], ay, az + (bz - az) * all[n + 1],
      );
    }
  }
  const split = new Float32Array(out);
  const at = await sampler(o, split, 3);
  const heights = new Float32Array(split.length / 3);
  for (let v = 0; v < heights.length; v++) heights[v] = at(split[v * 3], split[v * 3 + 2]);
  return { positions: split, heights };
}

export async function loadGroundTile(x: number, y: number, o: Origin, flat: boolean): Promise<GroundTileData> {
  const t0 = performance.now();
  const grid = flat ? null : await getGrid(x, y);
  const t1 = performance.now();
  const data = buildGroundMesh(grid, x, y, o);
  data.stats.fetchMs = t1 - t0;
  data.stats.buildMs = performance.now() - t1;
  return data;
}
