// Land / sea ground map from OSM sea polygons (water.pmtiles, z10 vector tiles; see tiler/water.mjs).
//
// For each z13 ground tile the worker rasterizes the polygons and turns them into a signed distance field
// (SDF): every texel stores its distance to the coastline (sea > 0, land < 0). The shader draws the coastline
// where the interpolated distance crosses 0 and anti-aliases it with fwidth, so the edge stays sharp at any
// zoom instead of turning into blurry or blocky pixels.

import { getArchives } from "@/api/osmSource";
import { TERRAIN_Z } from "./terrain";

export const WATER_Z = 10;
/**
 * SDF texels per z13 tile side (≈ 7 m at New York). Texel i is centered at i / (SIZE − 1) across the tile, so
 * the first and last texels sit exactly on the tile edges: neighbouring tiles store the same distances along
 * their shared edge and the coastline continues across tile seams without a jog. The shader samples
 * uv × (SIZE − 1) / SIZE + 0.5 / SIZE accordingly.
 */
export const SDF_SIZE = 512;
/** distances are stored for ± this many texels around the coast */
export const SDF_SPREAD = 8;
const PAD = SDF_SPREAD + 2;

type WaterTile = { full: true; e: number } | { full: false; e: number; rings: Float64Array[] } | null; // null: land
export type WaterResult = { kind: "land" | "sea" } | { kind: "mixed"; sdf: Uint8Array; size: number };

const decoder = new TextDecoder();
const tiles = new Map<string, Promise<WaterTile>>();

function getWaterTile(x: number, y: number): Promise<WaterTile> {
  const key = `${x}/${y}`;
  let t = tiles.get(key);
  if (!t) {
    t = (async () => {
      const { water } = await getArchives();
      if (!water) throw new Error("no water layer in the data manifest");
      const tile = await water.getZxy(WATER_Z, x, y);
      if (!tile) return null; // no sea in this tile
      const j = JSON.parse(decoder.decode(tile.data));
      if (j.full) return { full: true, e: j.e };
      const rings = (j.r as number[][]).map((d) => {
        const r = new Float64Array(d.length);
        let px = 0;
        let py = 0;
        for (let k = 0; k < d.length; k += 2) {
          px += d[k];
          py += d[k + 1];
          r[k] = px;
          r[k + 1] = py;
        }
        return r;
      });
      return { full: false, e: j.e, rings };
    })();
    t.catch(() => tiles.delete(key));
    tiles.set(key, t);
    if (tiles.size > 24) tiles.delete(tiles.keys().next().value!);
  }
  return t;
}

// Felzenszwalb & Huttenlocher squared Euclidean distance transform, one dimension
function edt1d(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array) {
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s: number;
    do {
      const r = v[k];
      s = (f[q] + q * q - f[r] - r * r) / (2 * q - 2 * r);
    } while (s <= z[k] && --k >= 0);
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const r = v[k];
    d[q] = (q - r) * (q - r) + f[r];
  }
}

/** large but finite: with Infinity the envelope intersections become Infinity − Infinity = NaN */
const FAR = 1e20;

/** grid: 0 at feature texels, FAR elsewhere -> Euclidean distance to the nearest feature texel */
function edt(grid: Float64Array, n: number) {
  const f = new Float64Array(n);
  const d = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  for (let x = 0; x < n; x++) {
    for (let y = 0; y < n; y++) f[y] = grid[y * n + x];
    edt1d(f, n, d, v, z);
    for (let y = 0; y < n; y++) grid[y * n + x] = d[y];
  }
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) f[x] = grid[y * n + x];
    edt1d(f, n, d, v, z);
    for (let x = 0; x < n; x++) grid[y * n + x] = Math.sqrt(d[x]);
  }
}

export async function loadWaterSdf(x: number, y: number): Promise<WaterResult> {
  const shift = TERRAIN_Z - WATER_Z;
  const wx = x >> shift;
  const wy = y >> shift;
  const t = await getWaterTile(wx, wy);
  if (!t) return { kind: "land" };
  if (t.full) return { kind: "sea" };

  // the z13 tile inside its z10 parent, in z10 tile units
  const sub = t.e / 2 ** shift;
  const ox = (x - (wx << shift)) * sub;
  const oy = (y - (wy << shift)) * sub;
  const S = SDF_SIZE;
  const k = (S - 1) / sub; // texel centers at i / (S − 1) of the tile
  const N = S + 2 * PAD;
  const canvas = new OffscreenCanvas(N, N);
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.fillStyle = "#fff";
  ctx.beginPath();
  for (const r of (t as { rings: Float64Array[] }).rings) {
    ctx.moveTo((r[0] - ox) * k + PAD + 0.5, (r[1] - oy) * k + PAD + 0.5);
    for (let i = 2; i < r.length; i += 2) ctx.lineTo((r[i] - ox) * k + PAD + 0.5, (r[i + 1] - oy) * k + PAD + 0.5);
    ctx.closePath();
  }
  // nonzero: the source pieces overlap slightly at their grid seams (overlaps stay sea), and islands are
  // holes wound the other way (shapefile rule: outer rings clockwise, holes counter-clockwise)
  ctx.fill("nonzero");
  const px = ctx.getImageData(0, 0, N, N).data;

  const cov = new Float32Array(N * N); // sea coverage of each texel (anti-aliased fill)
  let seaCount = 0;
  for (let i = 0; i < N * N; i++) {
    cov[i] = px[4 * i + 3] / 255;
    if (cov[i] >= 0.5) seaCount++;
  }
  if (seaCount === 0) return { kind: "land" };
  if (seaCount === N * N) return { kind: "sea" };

  const toLand = new Float64Array(N * N); // for sea texels: distance to the nearest land texel
  const toSea = new Float64Array(N * N);
  for (let i = 0; i < N * N; i++) {
    const sea = cov[i] >= 0.5;
    toLand[i] = sea ? FAR : 0;
    toSea[i] = sea ? 0 : FAR;
  }
  edt(toLand, N);
  edt(toSea, N);

  const sdf = new Uint8Array(S * S);
  const scale = 127.5 / SDF_SPREAD;
  for (let yy = 0; yy < S; yy++) {
    for (let xx = 0; xx < S; xx++) {
      const i = (yy + PAD) * N + (xx + PAD);
      const sea = cov[i] >= 0.5;
      let d = sea ? toLand[i] - 0.5 : -(toSea[i] - 0.5);
      // texels the coastline passes through: the anti-aliased coverage locates it inside the texel
      const c = cov[i];
      if (c > 0 && c < 1) {
        const border =
          (cov[i - 1] >= 0.5) !== sea || (cov[i + 1] >= 0.5) !== sea || (cov[i - N] >= 0.5) !== sea || (cov[i + N] >= 0.5) !== sea;
        if (border) d = c - 0.5;
      }
      sdf[yy * S + xx] = Math.max(0, Math.min(255, Math.round(127.5 + d * scale)));
    }
  }
  return { kind: "mixed", sdf, size: S };
}
