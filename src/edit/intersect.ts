// Faces of a mesh that cut through each other (a warning in Edit mode: the API does not check it). Every
// face is triangulated; triangles are bucketed in a grid and the pairs that share no corner are tested with
// Möller's interval method. Touching (a corner on a face, coplanar overlap) does not count as cutting.

import type { MeshData } from "@/contrib/mesh";
import { triangulateFace } from "@/three/meshGeometry";

type V = [number, number, number];
const EPS = 1e-6;

const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** where the triangle's edges cross the other plane, along the line both planes share (null: coplanar) */
function interval(p0: number, p1: number, p2: number, d0: number, d1: number, d2: number): [number, number] | null {
  const at = (a: number, b: number, c: number, da: number, db: number, dc: number): [number, number] => [a + ((b - a) * da) / (da - db), a + ((c - a) * da) / (da - dc)];
  if (d0 * d1 > 0) return at(p2, p0, p1, d2, d0, d1);
  if (d0 * d2 > 0) return at(p1, p0, p2, d1, d0, d2);
  if (d1 * d2 > 0 || d0 !== 0) return at(p0, p1, p2, d0, d1, d2);
  if (d1 !== 0) return at(p1, p0, p2, d1, d0, d2);
  if (d2 !== 0) return at(p2, p0, p1, d2, d0, d1);
  return null;
}

/** the two triangles cross (more than touching) */
export function trianglesCross(v0: V, v1: V, v2: V, u0: V, u1: V, u2: V): boolean {
  const n1 = cross(sub(v1, v0), sub(v2, v0));
  const scale1 = Math.sqrt(dot(n1, n1));
  if (scale1 < EPS) return false;
  const snap = (d: number, s: number) => (Math.abs(d) < EPS * s ? 0 : d);
  const du0 = snap(dot(n1, sub(u0, v0)), scale1), du1 = snap(dot(n1, sub(u1, v0)), scale1), du2 = snap(dot(n1, sub(u2, v0)), scale1);
  // a cut needs corners strictly on both sides of the other's plane, for both triangles (else they only touch)
  const across = (a: number, b: number, c: number) => (a > 0 || b > 0 || c > 0) && (a < 0 || b < 0 || c < 0);
  if (!across(du0, du1, du2)) return false;
  const n2 = cross(sub(u1, u0), sub(u2, u0));
  const scale2 = Math.sqrt(dot(n2, n2));
  if (scale2 < EPS) return false;
  const dv0 = snap(dot(n2, sub(v0, u0)), scale2), dv1 = snap(dot(n2, sub(v1, u0)), scale2), dv2 = snap(dot(n2, sub(v2, u0)), scale2);
  if (!across(dv0, dv1, dv2)) return false;
  const d = cross(n1, n2);
  const ax = Math.abs(d[0]) >= Math.abs(d[1]) && Math.abs(d[0]) >= Math.abs(d[2]) ? 0 : Math.abs(d[1]) >= Math.abs(d[2]) ? 1 : 2;
  const a = interval(v0[ax], v1[ax], v2[ax], dv0, dv1, dv2);
  const b = interval(u0[ax], u1[ax], u2[ax], du0, du1, du2);
  if (!a || !b) return false; // coplanar: touching, not cutting
  const [a0, a1] = a[0] <= a[1] ? a : [a[1], a[0]];
  const [b0, b1] = b[0] <= b[1] ? b : [b[1], b[0]];
  const tol = 1e-5 * Math.max(1, Math.abs(a1), Math.abs(b1));
  return a1 > b0 + tol && b1 > a0 + tol;
}

const memo = new WeakMap<MeshData, Set<number>>();

/** faces that cut through another face of the same mesh */
export function selfIntersections(m: MeshData): Set<number> {
  const known = memo.get(m);
  if (known) return known;
  const tris: number[] = [];
  const triFace: number[] = [];
  m.faces.forEach((f, i) => {
    const before = tris.length;
    triangulateFace(m.verts, f, tris);
    for (let k = before; k < tris.length; k += 3) triFace.push(i);
  });
  const count = triFace.length;
  const p = (v: number): V => [m.verts[3 * v], m.verts[3 * v + 1], m.verts[3 * v + 2]];
  const lo: V[] = [];
  const hi: V[] = [];
  const all: V = [Infinity, Infinity, Infinity];
  const allHi: V = [-Infinity, -Infinity, -Infinity];
  for (let t = 0; t < count; t++) {
    const [a, b, c] = [p(tris[3 * t]), p(tris[3 * t + 1]), p(tris[3 * t + 2])];
    lo.push([0, 1, 2].map((i) => Math.min(a[i], b[i], c[i])) as V);
    hi.push([0, 1, 2].map((i) => Math.max(a[i], b[i], c[i])) as V);
    for (let i = 0; i < 3; i++) {
      all[i] = Math.min(all[i], lo[t][i]);
      allHi[i] = Math.max(allHi[i], hi[t][i]);
    }
  }
  const out = new Set<number>();
  if (count < 2) return memo.set(m, out), out;
  const size = Math.max(0.5, Math.max(allHi[0] - all[0], allHi[1] - all[1], allHi[2] - all[2]) / Math.max(4, Math.cbrt(count) * 2));
  const grid = new Map<string, number[]>();
  for (let t = 0; t < count; t++) {
    const c0 = lo[t].map((v, i) => Math.floor((v - all[i]) / size));
    const c1 = hi[t].map((v, i) => Math.floor((v - all[i]) / size));
    for (let x = c0[0]; x <= c1[0]; x++)
      for (let y = c0[1]; y <= c1[1]; y++)
        for (let z = c0[2]; z <= c1[2]; z++) {
          const k = `${x},${y},${z}`;
          let list = grid.get(k);
          if (!list) grid.set(k, (list = []));
          list.push(t);
        }
  }
  const tested = new Set<number>();
  for (const list of grid.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const s = list[i];
        const t = list[j];
        if (triFace[s] === triFace[t]) continue;
        const key = s < t ? s * count + t : t * count + s;
        if (tested.has(key)) continue;
        tested.add(key);
        const A = [tris[3 * s], tris[3 * s + 1], tris[3 * s + 2]];
        const B = [tris[3 * t], tris[3 * t + 1], tris[3 * t + 2]];
        if (A.some((v) => B.includes(v))) continue; // neighbours
        if ([0, 1, 2].some((i) => lo[s][i] > hi[t][i] || lo[t][i] > hi[s][i])) continue;
        if (trianglesCross(p(A[0]), p(A[1]), p(A[2]), p(B[0]), p(B[1]), p(B[2]))) {
          out.add(triFace[s]);
          out.add(triFace[t]);
        }
      }
    }
  }
  memo.set(m, out);
  return out;
}
