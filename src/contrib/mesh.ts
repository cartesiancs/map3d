// Building meshes (free 3D shapes), shared by the app and the API: wire format, checks, prism <-> mesh.
// Pure functions only (no three.js): imported by worker/src as well.
//
// A mesh is stored in meters around an anchor point: x = east, y = up (0 = the building's lowest ground),
// z = south. Faces are polygons without holes, counter-clockwise seen from outside (three.js front faces),
// and the whole mesh is a closed solid. Wire format (overlay tiles, API):
//   { a: [lng·1e7, lat·1e7], q: 1, v: [x, y, z in mm, each the difference to the previous vertex], f: [n, i0 … in−1, n, …] }
// A mesh that is just an extruded footprint is stored as footprint + height instead (classifyPrism), the
// OpenStreetMap way.

import { GROUND_EPS, M_PER_DEG } from "../three/tiles/geo";
import { LIMITS, LngLat, areaM2, selfIntersects } from "./validate";

export type MeshData = {
  /** [lng, lat] the local meters are measured from */
  anchor: LngLat;
  /** x, y, z per vertex (m) */
  verts: number[];
  /**
   * vertex index loops. While editing, a 2-vertex entry is a loose (wire) edge, as in Blender: building
   * material on the way to faces. A submitted mesh has none (normalizeMesh leaves them out).
   */
  faces: number[][];
};

/** a loose (wire) edge: not part of any face (edit-time only) */
export const isWire = (f: number[]) => f.length === 2;

export type EncodedMesh = { a: [number, number]; q: number; v: number[]; f: number[] };

export const MESH_LIMITS = {
  maxVertices: 5000,
  maxTriangles: 10000,
  /** JSON of one encoded mesh */
  maxBytes: 300_000,
  /** every vertex this close to the anchor (horizontally) */
  maxExtentM: 1000,
  /** a face's corners this close to its plane */
  planarityM: 0.02,
};

const E7 = 1e7;
/** wire quantum: millimeters */
const Q = 1000;

// ---------------------------------------------------------------------------------------------------------
// coordinates

/** local meters [x east, z south] of a point around the anchor (equirectangular: exact for the scene) */
export function toLocal(anchor: LngLat, [lng, lat]: LngLat): [number, number] {
  const k = M_PER_DEG * Math.cos((anchor[1] * Math.PI) / 180);
  return [(lng - anchor[0]) * k, -(lat - anchor[1]) * M_PER_DEG];
}

export function toLngLat(anchor: LngLat, x: number, z: number): LngLat {
  const k = M_PER_DEG * Math.cos((anchor[1] * Math.PI) / 180);
  return [anchor[0] + x / k, anchor[1] - z / M_PER_DEG];
}

const roundE7 = (v: number) => Math.round(v * E7) / E7;

// ---------------------------------------------------------------------------------------------------------
// wire format

export function encodeMesh(m: MeshData): EncodedMesh {
  const v: number[] = [];
  let px = 0, py = 0, pz = 0;
  for (let i = 0; i < m.verts.length; i += 3) {
    const x = Math.round(m.verts[i] * Q);
    const y = Math.round(m.verts[i + 1] * Q);
    const z = Math.round(m.verts[i + 2] * Q);
    v.push(x - px, y - py, z - pz);
    px = x;
    py = y;
    pz = z;
  }
  const f: number[] = [];
  for (const face of m.faces) f.push(face.length, ...face);
  return { a: [Math.round(m.anchor[0] * E7), Math.round(m.anchor[1] * E7)], q: 1, v, f };
}

const isInt = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n);

/** structural problems of untrusted wire data (null: decodable) */
export function encodedMeshError(e: unknown): string | null {
  if (!e || typeof e !== "object") return "mesh must be an object";
  const m = e as EncodedMesh;
  if (!Array.isArray(m.a) || m.a.length !== 2 || !m.a.every(isInt) || Math.abs(m.a[0]) > 180 * E7 || Math.abs(m.a[1]) > 85 * E7) return "mesh anchor is invalid";
  if (m.q !== 1) return "mesh quantum must be 1 (mm)";
  if (!Array.isArray(m.v) || m.v.length % 3 !== 0 || !m.v.every(isInt)) return "mesh vertices are invalid";
  const count = m.v.length / 3;
  if (count > MESH_LIMITS.maxVertices) return `a mesh has at most ${MESH_LIMITS.maxVertices} vertices`;
  if (!Array.isArray(m.f) || !m.f.every(isInt)) return "mesh faces are invalid";
  for (let i = 0; i < m.f.length; ) {
    const n = m.f[i];
    if (n < 3 || i + 1 + n > m.f.length) return "mesh faces are invalid";
    for (let k = 1; k <= n; k++) if (m.f[i + k] < 0 || m.f[i + k] >= count) return "mesh faces point at missing vertices";
    i += 1 + n;
  }
  return null;
}

/** wire data -> mesh (check it with encodedMeshError first when it comes from outside) */
export function decodeMesh(e: EncodedMesh): MeshData {
  const verts = new Array<number>(e.v.length);
  let x = 0, y = 0, z = 0;
  for (let i = 0; i < e.v.length; i += 3) {
    x += e.v[i];
    y += e.v[i + 1];
    z += e.v[i + 2];
    verts[i] = x / Q;
    verts[i + 1] = y / Q;
    verts[i + 2] = z / Q;
  }
  const faces: number[][] = [];
  for (let i = 0; i < e.f.length; ) {
    const n = e.f[i];
    faces.push(e.f.slice(i + 1, i + 1 + n));
    i += 1 + n;
  }
  return { anchor: [e.a[0] / E7, e.a[1] / E7], verts, faces };
}

/** bytes of the JSON a mesh is sent and stored as */
export const encodedBytes = (e: EncodedMesh) => JSON.stringify(e).length;

/**
 * Clean a mesh for submission: vertices rounded to the wire's millimeters, coincident ones merged, repeated
 * corners and faces that collapse dropped, unused vertices removed, and faces that are not flat split into
 * triangles (a quad along its shorter diagonal). Faces keep their winding.
 */
export function normalizeMesh(m: MeshData): MeshData {
  const key = new Map<string, number>();
  const remap = new Array<number>(m.verts.length / 3);
  const verts: number[] = [];
  // only vertices of faces stay (loose edges and their ends are left out)
  const used = new Set<number>();
  for (const f of m.faces) if (f.length >= 3) for (const v of f) used.add(v);
  for (let i = 0; i < remap.length; i++) {
    if (!used.has(i)) continue;
    const x = Math.round(m.verts[3 * i] * Q);
    const y = Math.round(m.verts[3 * i + 1] * Q);
    const z = Math.round(m.verts[3 * i + 2] * Q);
    const k = `${x},${y},${z}`;
    let j = key.get(k);
    if (j === undefined) {
      j = verts.length / 3;
      key.set(k, j);
      verts.push(x / Q, y / Q, z / Q);
    }
    remap[i] = j;
  }
  const faces: number[][] = [];
  for (const f of m.faces) {
    const loop: number[] = [];
    for (const v of f) {
      const j = remap[v];
      if (loop[loop.length - 1] !== j) loop.push(j);
    }
    while (loop.length > 1 && loop[0] === loop[loop.length - 1]) loop.pop();
    if (loop.length >= 3 && new Set(loop).size === loop.length) faces.push(loop);
  }
  const out: MeshData = { anchor: [roundE7(m.anchor[0]), roundE7(m.anchor[1])], verts, faces };
  const bent = new Set(nonPlanarFaces(out));
  if (!bent.size) return out;
  const split: number[][] = [];
  const d2 = (a: number, b: number) => (verts[3 * a] - verts[3 * b]) ** 2 + (verts[3 * a + 1] - verts[3 * b + 1]) ** 2 + (verts[3 * a + 2] - verts[3 * b + 2]) ** 2;
  faces.forEach((f, i) => {
    if (!bent.has(i)) return split.push(f);
    if (f.length === 4) {
      const [a, b, c, d] = f;
      if (d2(a, c) <= d2(b, d)) split.push([a, b, c], [a, c, d]);
      else split.push([b, c, d], [b, d, a]);
    } else for (let k = 1; k + 1 < f.length; k++) split.push([f[0], f[k], f[k + 1]]);
  });
  return { ...out, faces: split };
}

// ---------------------------------------------------------------------------------------------------------
// prism <-> mesh

/** signed area of a ring in (east, north) = (x, −z): positive when counter-clockwise seen from above */
function ringArea(xz: [number, number][]) {
  let a = 0;
  for (let i = 0; i < xz.length; i++) {
    const [x1, z1] = xz[i];
    const [x2, z2] = xz[(i + 1) % xz.length];
    a += x1 * -z2 - x2 * -z1;
  }
  return a / 2;
}

/** an extruded footprint (open ring, WGS84) as a mesh: bottom, top, one wall quad per edge */
export function prismToMesh(footprint: LngLat[], height: number): MeshData {
  let lng = 0, lat = 0;
  for (const [x, y] of footprint) {
    lng += x;
    lat += y;
  }
  const anchor: LngLat = [roundE7(lng / footprint.length), roundE7(lat / footprint.length)];
  let ring = footprint.map((p) => toLocal(anchor, p));
  if (ringArea(ring) < 0) ring = ring.reverse(); // counter-clockwise seen from above
  const n = ring.length;
  const verts: number[] = [];
  for (const [x, z] of ring) verts.push(x, 0, z);
  for (const [x, z] of ring) verts.push(x, height, z);
  const faces: number[][] = [];
  faces.push([...Array(n).keys()].reverse()); // bottom, facing down
  faces.push([...Array(n).keys()].map((k) => n + k)); // top, facing up
  for (let k = 0; k < n; k++) {
    const j = (k + 1) % n;
    faces.push([k, j, n + j, n + k]);
  }
  return { anchor, verts, faces };
}

/**
 * The footprint + height a mesh is, when it is exactly an extruded footprint: every vertex on the ground or
 * at one roof height, one bottom and one top face over the same corners, a vertical quad per edge.
 */
export function classifyPrism(m: MeshData): { footprint: LngLat[]; height: number } | null {
  const count = m.verts.length / 3;
  if (count < 6 || count % 2) return null;
  let h = -Infinity;
  for (let i = 1; i < m.verts.length; i += 3) h = Math.max(h, m.verts[i]);
  if (!(h > GROUND_EPS)) return null;
  const level = (i: number) => (Math.abs(m.verts[3 * i + 1]) < 1e-3 ? 0 : Math.abs(m.verts[3 * i + 1] - h) < 1e-3 ? 1 : -1);
  for (let i = 0; i < count; i++) if (level(i) < 0) return null;
  const n = count / 2;
  if (m.faces.length !== n + 2) return null;
  const top = m.faces.find((f) => f.length === n && f.every((v) => level(v) === 1));
  const bottom = m.faces.find((f) => f.length === n && f.every((v) => level(v) === 0));
  if (!top || !bottom) return null;
  // every top corner straight above a bottom corner, and the walls joining them
  const below = new Map<number, number>();
  for (const t of top) {
    const b = bottom.find((v) => Math.abs(m.verts[3 * v] - m.verts[3 * t]) < 1e-3 && Math.abs(m.verts[3 * v + 2] - m.verts[3 * t + 2]) < 1e-3);
    if (b === undefined) return null;
    below.set(t, b);
  }
  const walls = new Set(m.faces.filter((f) => f !== top && f !== bottom && f.length === 4).map((f) => [...f].sort((a, b) => a - b).join(",")));
  for (let k = 0; k < n; k++) {
    const a = top[k];
    const b = top[(k + 1) % n];
    if (!walls.has([a, b, below.get(a)!, below.get(b)!].sort((x, y) => x - y).join(","))) return null;
  }
  const ring = top.map((v) => [m.verts[3 * v], m.verts[3 * v + 2]] as [number, number]);
  const footprint = ring.map(([x, z]) => toLngLat(m.anchor, x, z)).map(([lng, lat]) => [roundE7(lng), roundE7(lat)] as LngLat);
  return { footprint, height: Math.round(h * 1000) / 1000 };
}

/**
 * The outline drawn in the tiles' `g` (owner tile, bounding box, apps without mesh support): the convex hull
 * of the vertices seen from above, counter-clockwise, open ring (WGS84).
 */
export function meshOutline(m: MeshData): LngLat[] {
  const pts: [number, number][] = [];
  for (let i = 0; i < m.verts.length; i += 3) pts.push([m.verts[i], -m.verts[i + 2]]); // (east, north)
  pts.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  const cross = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: [number, number][] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  const hull = [...lower.slice(0, -1), ...upper.slice(0, -1)];
  return hull.map(([x, north]) => toLngLat(m.anchor, x, -north)).map(([lng, lat]) => [roundE7(lng), roundE7(lat)] as LngLat);
}

export function meshHeight(m: MeshData) {
  let h = 0;
  for (let i = 1; i < m.verts.length; i += 3) h = Math.max(h, m.verts[i]);
  return h;
}

export const triangleCount = (m: MeshData) => m.faces.reduce((s, f) => s + f.length - 2, 0);

/** the middle of the vertices a building stands on (any vertex when none does), WGS84 */
export function groundCenter(m: MeshData): LngLat {
  let x = 0, z = 0, n = 0;
  for (const onlyGround of [true, false]) {
    for (let i = 0; i < m.verts.length; i += 3) {
      if (onlyGround && m.verts[i + 1] >= GROUND_EPS) continue;
      x += m.verts[i];
      z += m.verts[i + 2];
      n++;
    }
    if (n) break;
  }
  return n ? toLngLat(m.anchor, x / n, z / n) : m.anchor;
}

/** the area the building stands on (m²): its downward faces on the ground */
export function groundArea(m: MeshData): number {
  let a = 0;
  for (const f of m.faces) {
    if (!f.every((v) => m.verts[3 * v + 1] < GROUND_EPS)) continue;
    const [nx, ny, nz] = faceNormal(m, f);
    if (ny < 0) a += Math.hypot(nx, ny, nz) / 2;
  }
  return a;
}

// ---------------------------------------------------------------------------------------------------------
// topology and checks

export type MeshTopology = {
  /** loose edges (not part of a face) */
  wire: [number, number][];
  /** edges used by one face only (holes) */
  boundary: [number, number][];
  /** edges used by more than two faces */
  nonManifold: [number, number][];
  /** edges whose two faces run the same way (inconsistent winding: fixed by recalculating the normals) */
  flipped: [number, number][];
  /** vertices whose faces do not form a single fan (two solids touching at a corner) */
  pinched: number[];
  /** vertices no face uses */
  loose: number[];
};

/** half-edges a→b of every face, keyed by the undirected edge */
function edgeUses(m: MeshData) {
  const edges = new Map<number, { a: number; b: number; uses: { face: number; forward: boolean }[] }>();
  const count = m.verts.length / 3;
  m.faces.forEach((f, face) => {
    if (f.length < 3) return; // loose edges are reported on their own
    for (let i = 0; i < f.length; i++) {
      const p = f[i];
      const q = f[(i + 1) % f.length];
      const a = Math.min(p, q);
      const b = Math.max(p, q);
      const k = a * count + b;
      let e = edges.get(k);
      if (!e) edges.set(k, (e = { a, b, uses: [] }));
      e.uses.push({ face, forward: p === a });
    }
  });
  return edges;
}

export function meshTopology(m: MeshData): MeshTopology {
  const count = m.verts.length / 3;
  const edges = edgeUses(m);
  const wire = m.faces.filter(isWire).map(([a, b]) => [a, b] as [number, number]);
  const boundary: [number, number][] = [];
  const nonManifold: [number, number][] = [];
  const flipped: [number, number][] = [];
  for (const e of edges.values()) {
    if (e.uses.length === 1) boundary.push([e.a, e.b]);
    else if (e.uses.length > 2) nonManifold.push([e.a, e.b]);
    else if (e.uses[0].forward === e.uses[1].forward) flipped.push([e.a, e.b]);
  }
  // fans: the faces around a vertex, joined across the edges at that vertex, must be one group
  const pair = new Map<number, number>(); // vertex·faces + face -> union-find node
  const parent: number[] = [];
  const solid = (f: number[]) => f.length >= 3;
  const node = (v: number, f: number) => {
    const k = v * m.faces.length + f;
    let n = pair.get(k);
    if (n === undefined) {
      n = parent.length;
      parent.push(n);
      pair.set(k, n);
    }
    return n;
  };
  const find = (n: number): number => (parent[n] === n ? n : (parent[n] = find(parent[n])));
  m.faces.forEach((f, face) => solid(f) && f.forEach((v) => node(v, face)));
  for (const e of edges.values()) {
    if (e.uses.length !== 2) continue;
    const [f1, f2] = [e.uses[0].face, e.uses[1].face];
    for (const v of [e.a, e.b]) parent[find(node(v, f1))] = find(node(v, f2));
  }
  const groups = new Map<number, Set<number>>();
  for (const [k, n] of pair) {
    const v = Math.floor(k / m.faces.length);
    let s = groups.get(v);
    if (!s) groups.set(v, (s = new Set()));
    s.add(find(n));
  }
  const pinched: number[] = [];
  const loose: number[] = [];
  const onWire = new Set(wire.flat());
  for (let v = 0; v < count; v++) {
    const s = groups.get(v);
    if (!s) {
      if (!onWire.has(v)) loose.push(v);
    } else if (s.size > 1) pinched.push(v);
  }
  return { wire, boundary, nonManifold, flipped, pinched, loose };
}

/** Newell normal of a face (length = twice its area) */
export function faceNormal(m: MeshData, f: number[]): [number, number, number] {
  let nx = 0, ny = 0, nz = 0;
  const p = m.verts;
  for (let i = 0; i < f.length; i++) {
    const a = 3 * f[i];
    const b = 3 * f[(i + 1) % f.length];
    nx += (p[a + 1] - p[b + 1]) * (p[a + 2] + p[b + 2]);
    ny += (p[a + 2] - p[b + 2]) * (p[a] + p[b]);
    nz += (p[a] - p[b]) * (p[a + 1] + p[b + 1]);
  }
  return [nx, ny, nz];
}

/** enclosed volume (m³): positive when the faces point outwards */
export function meshVolume(m: MeshData) {
  const p = m.verts;
  let v = 0;
  for (const f of m.faces) {
    const a = 3 * f[0];
    for (let i = 1; i + 1 < f.length; i++) {
      const b = 3 * f[i];
      const c = 3 * f[i + 1];
      v +=
        p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) -
        p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) +
        p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
    }
  }
  return v / 6;
}

/** faces whose corners are not on one plane (within MESH_LIMITS.planarityM) */
export function nonPlanarFaces(m: MeshData): number[] {
  const out: number[] = [];
  const p = m.verts;
  m.faces.forEach((f, i) => {
    if (f.length <= 3) return;
    const [nx, ny, nz] = faceNormal(m, f);
    const len = Math.hypot(nx, ny, nz);
    if (len === 0) return;
    let cx = 0, cy = 0, cz = 0;
    for (const v of f) {
      cx += p[3 * v];
      cy += p[3 * v + 1];
      cz += p[3 * v + 2];
    }
    cx /= f.length;
    cy /= f.length;
    cz /= f.length;
    for (const v of f) {
      const d = Math.abs(((p[3 * v] - cx) * nx + (p[3 * v + 1] - cy) * ny + (p[3 * v + 2] - cz) * nz) / len);
      if (d > MESH_LIMITS.planarityM) {
        out.push(i);
        return;
      }
    }
  });
  return out;
}

/** Problems of a building mesh (empty when it can be submitted). */
export function validateMesh(m: MeshData): string[] {
  const errors: string[] = [];
  const count = m.verts.length / 3;
  if (count < 4 || m.faces.length < 4) return ["a building needs at least 4 vertices and 4 faces"];
  if (count > MESH_LIMITS.maxVertices) errors.push(`a building has at most ${MESH_LIMITS.maxVertices} vertices`);
  if (triangleCount(m) > MESH_LIMITS.maxTriangles) errors.push(`a building has at most ${MESH_LIMITS.maxTriangles} triangles`);
  if (errors.length) return errors;
  if (!m.verts.every(Number.isFinite)) return ["vertices must be numbers"];

  let minY = Infinity, maxY = -Infinity, far = 0;
  for (let i = 0; i < m.verts.length; i += 3) {
    minY = Math.min(minY, m.verts[i + 1]);
    maxY = Math.max(maxY, m.verts[i + 1]);
    far = Math.max(far, Math.hypot(m.verts[i], m.verts[i + 2]));
  }
  if (minY < -0.001 || minY >= GROUND_EPS) errors.push("the building must stand on the ground (its lowest point at 0 m)");
  if (maxY < LIMITS.minHeight || maxY > LIMITS.maxHeight) errors.push(`height must be between ${LIMITS.minHeight} and ${LIMITS.maxHeight} m`);
  if (far > MESH_LIMITS.maxExtentM) errors.push(`every vertex must be within ${MESH_LIMITS.maxExtentM} m of the anchor`);

  const wires = m.faces.filter(isWire).length;
  if (wires) errors.push(`${wires} loose edges are not part of any face`);
  for (const f of m.faces) {
    if (f.length < 2 || new Set(f).size !== f.length) {
      errors.push("a face repeats a vertex");
      break;
    }
  }
  if (m.faces.some((f) => f.length >= 3 && Math.hypot(...faceNormal(m, f)) < 1e-6)) errors.push("a face has no area");
  if (nonPlanarFaces(m).length) errors.push(`a face is not flat (corners more than ${MESH_LIMITS.planarityM * 100} cm off its plane)`);

  const t = meshTopology(m);
  if (t.loose.length) errors.push(`${t.loose.length} vertices are not part of any face`);
  if (t.boundary.length) errors.push(`the mesh is not closed (${t.boundary.length} open edges)`);
  if (t.nonManifold.length) errors.push(`${t.nonManifold.length} edges are shared by more than two faces`);
  if (t.pinched.length) errors.push(`${t.pinched.length} vertices join separate parts`);
  if (t.flipped.length) errors.push("some faces point inwards (recalculate the normals)");
  if (!errors.length && meshVolume(m) <= 0) errors.push("the faces point inwards (recalculate the normals)");

  const outline = meshOutline(m);
  if (outline.length < 3) errors.push("the building has no footprint");
  else {
    const area = areaM2(outline);
    if (area < LIMITS.minAreaM2) errors.push(`footprint is smaller than ${LIMITS.minAreaM2} m²`);
    if (area > LIMITS.maxAreaM2) errors.push(`footprint is larger than ${LIMITS.maxAreaM2.toLocaleString("en")} m²`);
    if (selfIntersects(outline)) errors.push("footprint outline is invalid");
  }
  return errors;
}
