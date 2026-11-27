// Transform math of Edit mode, in meters. Every draft has its own anchor; while several are transformed
// together they share one frame around a reference anchor (x east, y up, z south), each offset by the
// distance between the anchors (exact enough over a changeset's kilometer).
// UI axes follow Blender: X = east, Y = north, Z = up.

import type { MeshData } from "@/contrib/mesh";
import { toLocal } from "@/contrib/mesh";
import type { LngLat } from "@/contrib/validate";

export type Vec3 = [number, number, number];
/** a UI axis */
export type Axis = "x" | "y" | "z";

/** a UI axis as a direction of the mesh frame (x east, y up, z south) */
export const axisDir = (a: Axis): Vec3 => (a === "x" ? [1, 0, 0] : a === "y" ? [0, 0, -1] : [0, 1, 0]);

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
export const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);

/** where `anchor` lies in the frame of `ref` */
export function anchorOffset(ref: LngLat, anchor: LngLat): Vec3 {
  const [x, z] = toLocal(ref, anchor);
  return [x, 0, z];
}

/** the mean of some vertices of a mesh */
export function centroidOf(m: MeshData, verts: Iterable<number>): Vec3 | null {
  let x = 0, y = 0, z = 0, n = 0;
  for (const v of verts) {
    x += m.verts[3 * v];
    y += m.verts[3 * v + 1];
    z += m.verts[3 * v + 2];
    n++;
  }
  return n ? [x / n, y / n, z / n] : null;
}

/** a building's own origin: the middle of its bounding box on the ground */
export function originOf(m: MeshData): Vec3 {
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < m.verts.length; i += 3) {
    minX = Math.min(minX, m.verts[i]);
    maxX = Math.max(maxX, m.verts[i]);
    minZ = Math.min(minZ, m.verts[i + 2]);
    maxZ = Math.max(maxZ, m.verts[i + 2]);
  }
  return [(minX + maxX) / 2, 0, (minZ + maxZ) / 2];
}

/** a copy of the mesh with some vertices (all when `verts` is null) moved by f */
export function mapVerts(m: MeshData, verts: Iterable<number> | null, f: (p: Vec3) => Vec3): MeshData {
  const out = m.verts.slice();
  const each = (v: number) => {
    const [x, y, z] = f([m.verts[3 * v], m.verts[3 * v + 1], m.verts[3 * v + 2]]);
    out[3 * v] = x;
    out[3 * v + 1] = y;
    out[3 * v + 2] = z;
  };
  if (verts === null) for (let v = 0; v < m.verts.length / 3; v++) each(v);
  else for (const v of verts) each(v);
  return { ...m, verts: out };
}

/** rotation of p around the axis through `pivot` (right hand around the UI axis) */
export function rotateAbout(p: Vec3, pivot: Vec3, axis: Axis, angle: number): Vec3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const [x, y, z] = sub(p, pivot);
  let r: Vec3;
  // in the frame x east, y up, z south: UI Z = +y, UI X = +x, UI Y = −z
  if (axis === "z") r = [x * c + z * s, y, -x * s + z * c]; // counter-clockwise seen from above
  else if (axis === "x") r = [x, y * c - z * s, y * s + z * c]; // (north, up) turn: north goes up
  else r = [x * c + y * s, -x * s + y * c, z]; // (up, east) turn: up goes east
  return add(r, pivot);
}

/** scale of p from `pivot`: along one axis, all but one (`plane`), or all */
export function scaleAbout(p: Vec3, pivot: Vec3, k: number, axis: Axis | null, plane: boolean): Vec3 {
  const d = sub(p, pivot);
  const f: Vec3 = [k, k, k];
  if (axis) {
    const i = axis === "x" ? 0 : axis === "y" ? 2 : 1;
    if (plane) f[i] = 1;
    else {
      f[0] = f[1] = f[2] = 1;
      f[i] = k;
    }
  }
  return add(pivot, [d[0] * f[0], d[1] * f[1], d[2] * f[2]]);
}

/** a mesh scaled vertically from its ground to a new height */
export function withHeight(m: MeshData, height: number): MeshData {
  let h0 = 0;
  for (let i = 1; i < m.verts.length; i += 3) h0 = Math.max(h0, m.verts[i]);
  if (!(h0 > 0)) return m;
  return { ...m, verts: m.verts.map((v, i) => (i % 3 === 1 ? (v * height) / h0 : v)) };
}

/** a box standing on the ground at the anchor, w × d × h meters */
export function boxMesh(anchor: LngLat, w = 10, d = 10, h = 10): MeshData {
  const x = w / 2;
  const z = d / 2;
  return {
    anchor,
    verts: [-x, 0, z, x, 0, z, x, 0, -z, -x, 0, -z, -x, h, z, x, h, z, x, h, -z, -x, h, -z],
    faces: [
      [3, 2, 1, 0],
      [4, 5, 6, 7],
      [0, 1, 5, 4],
      [1, 2, 6, 5],
      [2, 3, 7, 6],
      [3, 0, 4, 7],
    ],
  };
}

/** a footprint drawn on the ground (local meters, counter-clockwise seen from above) extruded to h */
export function extrudeFootprint(anchor: LngLat, ring: [number, number][], h: number): MeshData {
  const n = ring.length;
  const verts: number[] = [];
  for (const [x, z] of ring) verts.push(x, 0, z);
  for (const [x, z] of ring) verts.push(x, h, z);
  const faces: number[][] = [[...Array(n).keys()].reverse(), [...Array(n).keys()].map((k) => n + k)];
  for (let k = 0; k < n; k++) faces.push([k, (k + 1) % n, n + ((k + 1) % n), n + k]);
  return { anchor, verts, faces };
}
