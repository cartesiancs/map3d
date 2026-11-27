// Mesh operations of Edit mode's element modes, Blender style, on polygon meshes (src/contrib/mesh.ts):
// pure functions (mesh, selection) -> (mesh, selection). They keep a closed mesh closed and its faces wound
// consistently (each edge used once in each direction), so what they make can be submitted. Loose (wire)
// edges — 2-vertex entries — are building material on the way to faces (extruded vertices, F on two
// vertices); they never reach a submission.

import type { MeshData } from "@/contrib/mesh";
import { faceNormal, isWire, meshTopology, meshVolume } from "@/contrib/mesh";
import { ElemMode, ElemSel, edgeEnds, edgeKey, emptySelection, meshEdges, settle } from "./select";
import type { Vec3 } from "./transform";

export type OpIn = { mesh: MeshData; sel: ElemSel; mode: ElemMode };
export type OpOut = { mesh: MeshData; sel: ElemSel };
/** an operation that cannot run on this selection says why */
export class OpError extends Error {}

const P = (m: MeshData, i: number): Vec3 => [m.verts[3 * i], m.verts[3 * i + 1], m.verts[3 * i + 2]];
const vsub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const vadd = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const vmul = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const vdot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const vcross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const vlen = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const vnorm = (a: Vec3): Vec3 => {
  const l = vlen(a);
  return l > 0 ? vmul(a, 1 / l) : [0, 0, 0];
};
const lerp = (a: Vec3, b: Vec3, t: number): Vec3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

const solid = (f: number[]) => f.length >= 3;
const unitNormal = (m: MeshData, f: number[]) => vnorm(faceNormal(m, f));
/** the loop runs a -> b */
const runs = (f: number[], a: number, b: number) => f.some((v, i) => v === a && f[(i + 1) % f.length] === b);

/** faces (not loose edges) of every edge */
function edgeFaces(m: MeshData): Map<string, number[]> {
  const out = new Map<string, number[]>();
  m.faces.forEach((f, i) => {
    if (!solid(f)) return;
    for (let k = 0; k < f.length; k++) {
      const key = edgeKey(f[k], f[(k + 1) % f.length]);
      let list = out.get(key);
      if (!list) out.set(key, (list = []));
      list.push(i);
    }
  });
  return out;
}

/** loose edges by edge key -> their entry in `faces` */
function wireIndex(m: MeshData): Map<string, number> {
  const out = new Map<string, number>();
  m.faces.forEach((f, i) => isWire(f) && out.set(edgeKey(f[0], f[1]), i));
  return out;
}

/** a face loop with repeated corners collapsed; null when it no longer makes a face (or, for a loose edge, an edge) */
function cleanLoop(f: number[]): number[] | null {
  const loop: number[] = [];
  for (const v of f) if (loop[loop.length - 1] !== v) loop.push(v);
  while (loop.length > 1 && loop[0] === loop[loop.length - 1]) loop.pop();
  if (new Set(loop).size !== loop.length) return null;
  if (isWire(f)) return loop.length === 2 ? loop : null;
  return loop.length >= 3 ? loop : null;
}

/** faces cleaned of collapsed corners and duplicate loose edges */
function cleanFaces(faces: number[][]): number[][] {
  const out: number[][] = [];
  const wires = new Set<string>();
  for (const f of faces) {
    const loop = cleanLoop(f);
    if (!loop) continue;
    if (isWire(loop)) {
      const k = edgeKey(loop[0], loop[1]);
      if (wires.has(k)) continue;
      wires.add(k);
    }
    out.push(loop);
  }
  // a loose edge that is now an edge of a face is no longer loose
  const faceEdges = new Set<string>();
  for (const f of out) if (solid(f)) for (let k = 0; k < f.length; k++) faceEdges.add(edgeKey(f[k], f[(k + 1) % f.length]));
  return out.filter((f) => !isWire(f) || !faceEdges.has(edgeKey(f[0], f[1])));
}

/** unused vertices removed (and the selection's vertices renumbered) */
function compact(m: MeshData, sel?: ElemSel, mode: ElemMode = "vertex"): OpOut {
  const used = new Set<number>();
  for (const f of m.faces) for (const v of f) used.add(v);
  const remap = new Int32Array(m.verts.length / 3).fill(-1);
  const verts: number[] = [];
  for (let i = 0; i < remap.length; i++) {
    if (!used.has(i)) continue;
    remap[i] = verts.length / 3;
    verts.push(m.verts[3 * i], m.verts[3 * i + 1], m.verts[3 * i + 2]);
  }
  const faces = m.faces.map((f) => f.map((v) => remap[v]));
  const mesh = { anchor: m.anchor, verts, faces };
  if (!sel) return { mesh, sel: emptySelection() };
  const next: ElemSel = {
    verts: new Set([...sel.verts].map((v) => remap[v]).filter((v) => v >= 0)),
    edges: new Set(
      [...sel.edges].flatMap((k) => {
        const [a, b] = edgeEnds(k);
        return remap[a] >= 0 && remap[b] >= 0 ? [edgeKey(remap[a], remap[b])] : [];
      }),
    ),
    faces: sel.faces,
    active: sel.active !== undefined && remap[sel.active] >= 0 ? remap[sel.active] : undefined,
  };
  return { mesh, sel: settle(mesh, next, mode) };
}

/** the boundary of a set of faces as one loop (null when it is not a single simple loop) */
function unionLoop(m: MeshData, faces: Iterable<number>): number[] | null {
  const directed = new Map<string, [number, number]>();
  for (const fi of faces) {
    const f = m.faces[fi];
    for (let k = 0; k < f.length; k++) {
      const a = f[k];
      const b = f[(k + 1) % f.length];
      const back = `${b}>${a}`;
      if (directed.has(back)) directed.delete(back); // inner edge: both directions inside the set
      else directed.set(`${a}>${b}`, [a, b]);
    }
  }
  const next = new Map<number, number>();
  for (const [a, b] of directed.values()) {
    if (next.has(a)) return null; // the boundary touches itself
    next.set(a, b);
  }
  if (next.size < 3) return null;
  const start = next.keys().next().value as number;
  const loop = [start];
  for (let v = next.get(start)!; v !== start; v = next.get(v)!) {
    if (v === undefined || loop.length > next.size) return null;
    loop.push(v);
  }
  return loop.length === next.size ? loop : null;
}

/** the holes of a mesh as loops for new faces (each runs against the open edges around it) */
function holeLoops(faces: number[][]): number[][] | null {
  const half = new Set<string>();
  for (const f of faces) if (solid(f)) for (let k = 0; k < f.length; k++) half.add(`${f[k]}>${f[(k + 1) % f.length]}`);
  const next = new Map<number, number>();
  for (const f of faces) {
    if (!solid(f)) continue;
    for (let k = 0; k < f.length; k++) {
      const a = f[k];
      const b = f[(k + 1) % f.length];
      if (half.has(`${b}>${a}`)) continue;
      if (next.has(b)) return null; // two holes touch at a corner
      next.set(b, a);
    }
  }
  const loops: number[][] = [];
  const seen = new Set<number>();
  for (const start of next.keys()) {
    if (seen.has(start)) continue;
    const loop = [start];
    seen.add(start);
    for (let v = next.get(start)!; v !== start; v = next.get(v)!) {
      if (v === undefined || seen.has(v)) return null;
      loop.push(v);
      seen.add(v);
    }
    loops.push(loop);
  }
  return loops;
}

function planeOf(m: MeshData, f: number[]): { n: Vec3; d: number } {
  const n = unitNormal(m, f);
  return { n, d: vdot(n, P(m, f[0])) };
}

/** a face lies on the plane of another (facing either way) */
function coplanar(m: MeshData, f: number[], g: number[], tol = 0.01) {
  const pf = planeOf(m, f);
  const pg = planeOf(m, g);
  if (Math.abs(vdot(pf.n, pg.n)) < 0.9999) return false;
  return f.every((v) => Math.abs(vdot(pg.n, P(m, v)) - pg.d) < tol);
}

// ---------------------------------------------------------------------------------------------------------
// delete, dissolve, merge, fill, connect

export function deleteElements({ mesh, sel, mode }: OpIn, what: "vertices" | "edges" | "faces"): OpOut {
  const gone = (f: number[], i: number) => {
    if (what === "faces") return solid(f) && (sel.faces.has(i) || (mode !== "face" && f.every((v) => sel.verts.has(v))));
    if (what === "vertices") return f.some((v) => sel.verts.has(v));
    for (let k = 0; k < f.length; k++) {
      const a = f[k];
      const b = f[(k + 1) % f.length];
      if (mode === "edge" ? sel.edges.has(edgeKey(a, b)) : sel.verts.has(a) && sel.verts.has(b)) return true;
    }
    return false;
  };
  const faces = mesh.faces.filter((f, i) => !gone(f, i));
  if (faces.length === mesh.faces.length) throw new OpError("Nothing to delete in the selection");
  return compact({ ...mesh, faces });
}

/** merge groups of faces into one face each (their outline), keeping the rest */
function mergeFaceGroups(m: MeshData, groups: number[][]): { mesh: MeshData; merged: number[] } {
  const drop = new Set<number>();
  const add: number[][] = [];
  for (const g of groups) {
    if (g.length < 2) continue;
    const loop = unionLoop(m, g);
    if (!loop) continue;
    g.forEach((i) => drop.add(i));
    add.push(loop);
  }
  const faces = m.faces.filter((_, i) => !drop.has(i));
  const merged = add.map((_, k) => faces.length + k);
  return { mesh: { ...m, faces: [...faces, ...add] }, merged };
}

function groupsBy(n: number, join: (union: (a: number, b: number) => void) => void, members: Set<number>): number[][] {
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  join((a, b) => (parent[find(a)] = find(b)));
  const groups = new Map<number, number[]>();
  for (const i of members) {
    const r = find(i);
    let g = groups.get(r);
    if (!g) groups.set(r, (g = []));
    g.push(i);
  }
  return [...groups.values()];
}

/** Dissolve: vertices (their faces become one), edges (the faces on both sides join), faces (joined) */
export function dissolve({ mesh, sel, mode }: OpIn): OpOut {
  const ef = edgeFaces(mesh);
  let groups: number[][];
  if (mode === "vertex") {
    groups = [...sel.verts].map((v) => mesh.faces.flatMap((f, i) => (solid(f) && f.includes(v) ? [i] : [])));
    // vertices whose faces overlap are dissolved together
    const touched = new Set(groups.flat());
    groups = groupsBy(mesh.faces.length, (union) => groups.forEach((g) => g.forEach((f) => union(f, g[0]))), touched);
  } else if (mode === "edge") {
    const touched = new Set<number>();
    groups = groupsBy(
      mesh.faces.length,
      (union) => {
        for (const k of sel.edges) {
          const fs = ef.get(k) ?? [];
          if (fs.length !== 2) continue;
          union(fs[0], fs[1]);
          touched.add(fs[0]).add(fs[1]);
        }
      },
      touched,
    );
  } else {
    groups = groupsBy(
      mesh.faces.length,
      (union) => {
        for (const fs of ef.values()) if (fs.length === 2 && sel.faces.has(fs[0]) && sel.faces.has(fs[1])) union(fs[0], fs[1]);
      },
      sel.faces,
    );
  }
  const { mesh: out, merged } = mergeFaceGroups(mesh, groups);
  if (out.faces.length === mesh.faces.length) throw new OpError("These faces cannot be joined into one");
  const done = compact(out);
  return { mesh: done.mesh, sel: mode === "face" ? settle(done.mesh, { ...emptySelection(), faces: new Set(merged) }, "face") : emptySelection() };
}

/** vertices moved onto others (`into`: vertex -> the vertex it becomes), faces cleaned up */
function collapse(mesh: MeshData, verts: number[], into: Map<number, number>, keep: Set<number>, mode: ElemMode): OpOut {
  const faces = cleanFaces(mesh.faces.map((f) => f.map((v) => into.get(v) ?? v)));
  return compact({ ...mesh, verts, faces }, { verts: keep, edges: new Set(), faces: new Set() }, mode === "face" ? "vertex" : mode);
}

/**
 * Merge (M) the selected vertices into one: at their center, at the vertex picked last (`active`), or at a
 * point (the cursor: where the mouse points, in the mesh's meters).
 */
export function mergeAt({ mesh, sel }: OpIn, at: "center" | "active" | Vec3): OpOut {
  const vs = [...sel.verts];
  if (vs.length < 2) throw new OpError("Select at least two vertices to merge");
  let target: Vec3;
  let keep = vs[0];
  if (at === "center") {
    target = [0, 0, 0];
    for (const v of vs) target = vadd(target, P(mesh, v));
    target = vmul(target, 1 / vs.length);
  } else if (at === "active") {
    if (sel.active === undefined || !sel.verts.has(sel.active)) throw new OpError("Click the vertex to merge at last (vertex mode)");
    keep = sel.active;
    target = P(mesh, keep);
  } else target = at;
  const verts = mesh.verts.slice();
  verts.splice(3 * keep, 3, ...target);
  const into = new Map(vs.map((v) => [v, keep]));
  return collapse(mesh, verts, into, new Set([keep]), "vertex");
}

/** Merge by distance: selected vertices (all when none are) closer than `distance` m become one, at their middle */
export function mergeByDistance({ mesh, sel }: OpIn, distance: number): OpOut & { merged: number } {
  const n = mesh.verts.length / 3;
  const pool = sel.verts.size ? [...sel.verts] : Array.from({ length: n }, (_, i) => i);
  const cell = Math.max(distance, 1e-6);
  const grid = new Map<string, number[]>();
  const keyOf = (p: Vec3) => p.map((c) => Math.floor(c / cell));
  for (const v of pool) {
    const k = keyOf(P(mesh, v)).join(",");
    let list = grid.get(k);
    if (!list) grid.set(k, (list = []));
    list.push(v);
  }
  const parent = new Map(pool.map((v) => [v, v]));
  const find = (v: number): number => (parent.get(v) === v ? v : (parent.set(v, find(parent.get(v)!)), parent.get(v)!));
  for (const v of pool) {
    const p = P(mesh, v);
    const [cx, cy, cz] = keyOf(p);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++)
          for (const w of grid.get(`${cx + dx},${cy + dy},${cz + dz}`) ?? []) {
            if (w <= v || vlen(vsub(P(mesh, w), p)) > distance) continue;
            parent.set(find(w), find(v));
          }
  }
  const clusters = new Map<number, number[]>();
  for (const v of pool) {
    const r = find(v);
    let c = clusters.get(r);
    if (!c) clusters.set(r, (c = []));
    c.push(v);
  }
  const verts = mesh.verts.slice();
  const into = new Map<number, number>();
  let merged = 0;
  for (const [r, c] of clusters) {
    if (c.length < 2) continue;
    let m: Vec3 = [0, 0, 0];
    for (const v of c) m = vadd(m, P(mesh, v));
    verts.splice(3 * r, 3, ...vmul(m, 1 / c.length));
    for (const v of c) if (v !== r) into.set(v, r);
    merged += c.length - 1;
  }
  const keep = new Set([...pool].map((v) => into.get(v) ?? v));
  return { ...collapse(mesh, verts, into, sel.verts.size ? keep : new Set(), "vertex"), merged };
}

/** split one face along a chord from u to v (both on its outline, not neighbours) */
function splitFace(faces: number[][], fi: number, u: number, v: number, path: number[] = []) {
  const f = faces[fi];
  const i = f.indexOf(u);
  const rot = [...f.slice(i), ...f.slice(0, i)]; // starts at u
  const j = rot.indexOf(v);
  faces[fi] = [...rot.slice(0, j + 1), ...[...path].reverse()];
  faces.push([...rot.slice(j), u, ...path]);
}

/** Connect (J): each face with exactly two selected corners (not neighbours) is split between them */
export function connect({ mesh, sel }: OpIn): OpOut {
  const faces = mesh.faces.map((f) => f.slice());
  let split = 0;
  for (let fi = 0; fi < mesh.faces.length; fi++) {
    const f = faces[fi];
    if (!solid(f)) continue;
    const on = f.filter((v) => sel.verts.has(v));
    if (on.length !== 2) continue;
    const [u, v] = on;
    const d = Math.abs(f.indexOf(u) - f.indexOf(v));
    if (d === 1 || d === f.length - 1) continue; // already an edge
    splitFace(faces, fi, u, v);
    split++;
  }
  if (!split) throw new OpError("Select two corners of a face that are not joined by an edge");
  const out = { ...mesh, faces };
  return { mesh: out, sel: settle(out, { verts: new Set(sel.verts), edges: new Set(), faces: new Set() }, "vertex") };
}

/**
 * Fill (F): two vertices -> split the face they share (as J), else a loose edge between them; vertices
 * around a hole, or along a loop of loose edges -> a new face.
 */
export function fill({ mesh, sel, mode }: OpIn): OpOut {
  if (sel.verts.size === 2) {
    const [a, b] = [...sel.verts];
    const joined = meshEdges(mesh).some(([x, y]) => (x === a && y === b) || (x === b && y === a));
    if (joined) throw new OpError("These two vertices are already joined by an edge");
    const shared = mesh.faces.some((f) => solid(f) && f.includes(a) && f.includes(b));
    if (shared) return connect({ mesh, sel, mode });
    const faces = [...mesh.faces, [a, b]];
    const out = { ...mesh, faces };
    return { mesh: out, sel: settle(out, { verts: new Set([a, b]), edges: new Set([edgeKey(a, b)]), faces: new Set() }, mode === "face" ? "vertex" : mode) };
  }
  const ef = edgeFaces(mesh);
  const wires = wireIndex(mesh);
  // candidate edges between selected vertices: open edges of faces (their way is fixed) and loose edges
  const adj = new Map<number, number[]>();
  const fixed = new Map<string, boolean>(); // "a>b": the new face must run a -> b
  const link = (a: number, b: number) => {
    adj.set(a, [...(adj.get(a) ?? []), b]);
    adj.set(b, [...(adj.get(b) ?? []), a]);
  };
  mesh.faces.forEach((f) => {
    if (!solid(f)) return;
    for (let k = 0; k < f.length; k++) {
      const a = f[k];
      const b = f[(k + 1) % f.length];
      if (sel.verts.has(a) && sel.verts.has(b) && (ef.get(edgeKey(a, b))?.length ?? 0) === 1) {
        link(a, b);
        fixed.set(`${b}>${a}`, true);
      }
    }
  });
  for (const [k] of wires) {
    const [a, b] = edgeEnds(k);
    if (sel.verts.has(a) && sel.verts.has(b)) link(a, b);
  }
  if (adj.size < 3 || [...adj.values()].some((n) => n.length !== 2)) throw new OpError("Select the vertices around a hole, or along a closed loop of loose edges");
  const start = adj.keys().next().value as number;
  const loop = [start];
  for (let prev = start, v = adj.get(start)![0]; v !== start; ) {
    loop.push(v);
    const n = adj.get(v)!;
    const nx = n[0] === prev ? n[1] : n[0];
    prev = v;
    v = nx;
    if (loop.length > adj.size) break;
  }
  if (loop.length !== adj.size) throw new OpError("The selected vertices must go around one hole");
  // the way round: against the faces around a hole; for loose edges only, facing away from the mesh's middle
  let forward: boolean | null = null;
  for (let i = 0; i < loop.length && forward === null; i++) {
    const a = loop[i];
    const b = loop[(i + 1) % loop.length];
    if (fixed.has(`${a}>${b}`)) forward = true;
    else if (fixed.has(`${b}>${a}`)) forward = false;
  }
  if (forward === null) {
    let c: Vec3 = [0, 0, 0];
    for (let i = 0; i < mesh.verts.length; i += 3) c = vadd(c, [mesh.verts[i], mesh.verts[i + 1], mesh.verts[i + 2]]);
    c = vmul(c, 3 / mesh.verts.length);
    let mid: Vec3 = [0, 0, 0];
    for (const v of loop) mid = vadd(mid, P(mesh, v));
    mid = vmul(mid, 1 / loop.length);
    const n = faceNormal(mesh, loop);
    const away = vsub(mid, c);
    forward = vdot(n, vlen(away) > 1e-6 ? away : [0, 1, 0]) >= 0;
  }
  const face = forward ? loop : [...loop].reverse();
  const faces = cleanFaces([...mesh.faces, face]); // the loose edges it uses are no longer loose
  const out = { ...mesh, faces };
  const fi = faces.findIndex((f) => f === face || (f.length === face.length && f.every((v, i) => v === face[i])));
  return { mesh: out, sel: settle(out, { ...emptySelection(), faces: new Set([fi]) }, "face") };
}

// ---------------------------------------------------------------------------------------------------------
// extrude, inset

/**
 * Extrude (E), as Blender's "extrude region": selected faces move out as one region (side walls join its
 * outline to the copy); selected edges outside them grow a face each (a wall on an open edge, a fin on an
 * edge between two faces); selected vertices outside those grow a loose edge. Returns the region's normal
 * when there are faces (the direction to pull), else null (free).
 */
export function extrude({ mesh, sel, mode }: OpIn): OpOut & { normal: Vec3 | null } {
  const region = mode === "face" ? [...sel.faces] : mesh.faces.flatMap((f, i) => (solid(f) && f.every((v) => sel.verts.has(v)) ? [i] : []));
  const inRegion = new Set(region);
  const directed = new Set<string>();
  const regionEdges = new Set<string>();
  for (const fi of region) {
    const f = mesh.faces[fi];
    for (let k = 0; k < f.length; k++) {
      directed.add(`${f[k]}>${f[(k + 1) % f.length]}`);
      regionEdges.add(edgeKey(f[k], f[(k + 1) % f.length]));
    }
  }
  const selEdges = mode === "edge" ? [...sel.edges] : mode === "vertex" ? meshEdges(mesh).filter(([a, b]) => sel.verts.has(a) && sel.verts.has(b)).map(([a, b]) => edgeKey(a, b)) : [];
  const loneEdges = selEdges.filter((k) => !regionEdges.has(k));
  const touched = new Set<number>();
  for (const fi of region) for (const v of mesh.faces[fi]) touched.add(v);
  for (const k of loneEdges) for (const v of edgeEnds(k)) touched.add(v);
  const loneVerts = mode === "vertex" ? [...sel.verts].filter((v) => !touched.has(v)) : [];
  if (!region.length && !loneEdges.length && !loneVerts.length) throw new OpError("Select vertices, edges or faces to extrude");

  const verts = mesh.verts.slice();
  const copy = new Map<number, number>();
  const dup = (v: number) => {
    let c = copy.get(v);
    if (c === undefined) {
      c = verts.length / 3;
      verts.push(mesh.verts[3 * v], mesh.verts[3 * v + 1], mesh.verts[3 * v + 2]);
      copy.set(v, c);
    }
    return c;
  };
  const ef = edgeFaces(mesh);
  const wires = wireIndex(mesh);
  const dropWires = new Set<number>();
  const faces = mesh.faces.map((f, i) => (inRegion.has(i) ? f.map(dup) : f));
  let normal: Vec3 = [0, 0, 0];
  for (const fi of region) {
    const f = mesh.faces[fi];
    normal = vadd(normal, faceNormal(mesh, f));
    for (let k = 0; k < f.length; k++) {
      const a = f[k];
      const b = f[(k + 1) % f.length];
      if (directed.has(`${b}>${a}`)) continue; // inside the region
      faces.push([a, b, dup(b), dup(a)]);
    }
  }
  const newEdges = new Set<string>();
  for (const k of loneEdges) {
    const [a, b] = edgeEnds(k);
    const users = ef.get(k) ?? [];
    const w = wires.get(k);
    if (w !== undefined) dropWires.add(w); // the loose edge becomes the face's bottom
    // an open edge: the new face runs against the face that has it
    if (users.length === 1 && runs(mesh.faces[users[0]], a, b)) faces.push([b, a, dup(a), dup(b)]);
    else faces.push([a, b, dup(b), dup(a)]);
    newEdges.add(edgeKey(dup(a), dup(b)));
  }
  for (const v of loneVerts) faces.push([v, dup(v)]);
  const out = { ...mesh, verts, faces: faces.filter((_, i) => !dropWires.has(i)) };
  // the copies are selected, as in Blender
  const regionFaces = new Set(region.map((fi) => fi - [...dropWires].filter((w) => w < fi).length));
  const next: ElemSel = { verts: new Set(copy.values()), edges: newEdges, faces: regionFaces };
  const done = compact(out, mode === "face" ? settle(out, next, "face") : mode === "edge" ? settle(out, { ...next, edges: new Set([...newEdges, ...[...regionEdges].map((k) => edgeKey(...(edgeEnds(k).map(dup) as [number, number])))]) }, "edge") : next, mode);
  return { ...done, normal: region.length ? vnorm(normal) : null };
}

/** Inset (I): each selected face gets a smaller copy inside it, joined by a ring of faces */
export function insetFaces({ mesh, sel }: OpIn, thickness: number): OpOut {
  if (!sel.faces.size) throw new OpError("Select faces to inset");
  const verts = mesh.verts.slice();
  const faces = mesh.faces.slice();
  const inner: number[] = [];
  for (const fi of sel.faces) {
    const f = mesh.faces[fi];
    const n = f.length;
    const N = unitNormal(mesh, f);
    const pts = f.map((v) => P(mesh, v));
    // inward direction of each edge (left of the edge seen from outside)
    const inward = pts.map((p, k) => vnorm(vcross(N, vsub(pts[(k + 1) % n], p))));
    let shortest = Infinity;
    for (let k = 0; k < n; k++) shortest = Math.min(shortest, vlen(vsub(pts[(k + 1) % n], pts[k])));
    const t = Math.min(thickness, shortest * 0.45);
    const q = pts.map((p, k) => {
      const a = inward[(k - 1 + n) % n];
      const b = inward[k];
      const d = 1 + vdot(a, b);
      const miter = d > 0.2 ? vmul(vadd(a, b), t / d) : vmul(vnorm(vadd(a, b)), t * 3);
      const idx = verts.length / 3;
      verts.push(...vadd(p, miter));
      return idx;
    });
    faces[fi] = q; // the inner face keeps the face's place
    inner.push(fi);
    for (let k = 0; k < n; k++) faces.push([f[k], f[(k + 1) % n], q[(k + 1) % n], q[k]]);
  }
  const out = { ...mesh, verts, faces };
  return { mesh: out, sel: settle(out, { ...emptySelection(), faces: new Set(inner) }, "face") };
}

// ---------------------------------------------------------------------------------------------------------
// bevel

/**
 * Bevel (Ctrl+B) the selected edges: each edge between two faces becomes a strip of `segments` faces about
 * `offset` meters wide, rounded through the old edge. At each corner the faces around it get new points:
 * slid along an edge that is not beveled, or (two beveled edges of one face) where their offsets meet;
 * neighbouring strips share their profiles; whatever hole is left at a corner becomes a face (merged into
 * the face around it when it lies in that face's plane).
 */
export function bevelEdges({ mesh, sel }: OpIn, offset: number, segments: number): OpOut {
  const bevel = new Set(sel.edges);
  if (!bevel.size) throw new OpError("Select edges to bevel");
  const ef = edgeFaces(mesh);
  for (const k of bevel) if ((ef.get(k) ?? []).length !== 2) throw new OpError("Bevel works on edges between two faces");
  const k = Math.max(1, Math.min(4, Math.round(segments)));
  const isBevel = (a: number, b: number) => bevel.has(edgeKey(a, b));
  const corners = new Set<number>();
  for (const e of bevel) for (const v of edgeEnds(e)) corners.add(v);
  // the width can not pass half of any edge at a beveled corner
  let shortest = Infinity;
  for (const f of mesh.faces) {
    if (!solid(f)) continue;
    for (let i = 0; i < f.length; i++) {
      const a = f[i];
      const b = f[(i + 1) % f.length];
      if (corners.has(a) || corners.has(b)) shortest = Math.min(shortest, vlen(vsub(P(mesh, a), P(mesh, b))));
    }
  }
  const o = Math.min(offset, 0.45 * shortest);
  if (!(o > 1e-4)) return { mesh, sel }; // no width yet (the tool starts at 0): nothing changes

  const verts = mesh.verts.slice();
  const keyed = new Map<string, number>();
  const point = (key: string, at: () => Vec3) => {
    let i = keyed.get(key);
    if (i === undefined) {
      i = verts.length / 3;
      verts.push(...at());
      keyed.set(key, i);
    }
    return i;
  };
  const normals = new Map<number, Vec3>();
  const normalOf = (fi: number) => normals.get(fi) ?? (normals.set(fi, unitNormal(mesh, mesh.faces[fi])), normals.get(fi)!);
  /** the face's inward direction across its edge a-b (left of the edge as the face runs) */
  const inwardOf = (fi: number, a: number, b: number): Vec3 => {
    const f = mesh.faces[fi];
    const [x, y] = runs(f, a, b) ? [a, b] : [b, a];
    return vnorm(vcross(normalOf(fi), vsub(P(mesh, y), P(mesh, x))));
  };
  /** the new point of face fi at corner v for its beveled edge v-w */
  const side = (fi: number, v: number, w: number): number => {
    const f = mesh.faces[fi];
    const i = f.indexOf(v);
    const prev = f[(i - 1 + f.length) % f.length];
    const next = f[(i + 1) % f.length];
    const u = prev === w ? next : prev;
    const pv = P(mesh, v);
    if (isBevel(v, u)) {
      // two beveled edges of this face meet here: the point o inside both
      return point(`m:${fi}:${v}`, () => {
        const t1 = vnorm(vsub(P(mesh, w), pv));
        const t2 = vnorm(vsub(P(mesh, u), pv));
        const in1 = inwardOf(fi, v, w);
        const in2 = inwardOf(fi, v, u);
        const b = vdot(t2, in1);
        const a = vdot(t1, in2);
        if (Math.abs(a) < 1e-6 || Math.abs(b) < 1e-6) return vadd(pv, vmul(vnorm(vadd(in1, in2)), o));
        let d = vadd(vmul(t1, o / a), vmul(t2, o / b));
        const lim = 0.9 * Math.min(vlen(vsub(P(mesh, w), pv)), vlen(vsub(P(mesh, u), pv)));
        if (vlen(d) > lim) d = vmul(vnorm(d), lim);
        return vadd(pv, d);
      });
    }
    // slid along the face's other edge at v
    return point(`s:${edgeKey(v, u)}:${v}`, () => vadd(pv, vmul(vnorm(vsub(P(mesh, u), pv)), o)));
  };
  const at = (i: number): Vec3 => [verts[3 * i], verts[3 * i + 1], verts[3 * i + 2]];
  /**
   * the rounded profile between two side points around the old corner c (a quadratic curve through c's
   * pull); keyed by its ends, so the strips of two beveled edges that share them share it too
   */
  const profile = (from: number, to: number, c: number): number[] => {
    const [lo, hi] = from < to ? [from, to] : [to, from];
    const pts = [from];
    for (let j = 1; j < k; j++) {
      const step = from === lo ? j : k - j; // counted from lo
      pts.push(
        point(`p:${lo}:${hi}:${c}:${step}`, () => {
          const t = step / k;
          return vadd(vadd(vmul(at(lo), (1 - t) * (1 - t)), vmul(P(mesh, c), 2 * (1 - t) * t)), vmul(at(hi), t * t));
        }),
      );
    }
    pts.push(to);
    return pts;
  };

  // 1. strips (their side points and profiles)
  const strips: number[][] = [];
  for (const e of bevel) {
    const [p, q] = edgeEnds(e);
    const [f1, f2] = ef.get(e)!;
    const [fL, fR] = runs(mesh.faces[f1], p, q) ? [f1, f2] : [f2, f1]; // fL runs a -> b, fR runs b -> a
    const [a, b] = [p, q];
    const A = profile(side(fL, a, b), side(fR, a, b), a);
    const B = profile(side(fL, b, a), side(fR, b, a), b);
    for (let j = 0; j < k; j++) strips.push([A[j + 1], B[j + 1], B[j], A[j]]);
  }
  // 2. the faces, with their beveled corners replaced and the slid points put into their edges
  const faces: number[][] = mesh.faces.map((f, fi) => {
    if (!solid(f) || !f.some((v) => corners.has(v))) return f.slice();
    const loop: number[] = [];
    for (let i = 0; i < f.length; i++) {
      const w = f[i];
      const prev = f[(i - 1 + f.length) % f.length];
      const next = f[(i + 1) % f.length];
      const bp = isBevel(prev, w);
      const bn = isBevel(w, next);
      if (bp || bn) {
        loop.push(bn ? side(fi, w, next) : side(fi, w, prev));
        continue;
      }
      const into = keyed.get(`s:${edgeKey(prev, w)}:${w}`);
      const out = keyed.get(`s:${edgeKey(w, next)}:${w}`);
      if (into !== undefined) loop.push(into);
      loop.push(w);
      if (out !== undefined) loop.push(out);
    }
    return loop;
  });
  const stripStart = faces.length;
  faces.push(...strips);
  // 3. the holes left at corners become faces
  const holes = holeLoops(faces);
  if (!holes) throw new OpError("These edges can not be beveled together (their corners touch in a way bevel can not close)");
  let built: MeshData = { ...mesh, verts, faces: [...faces, ...holes] };
  // a hole in the plane of a face beside it: facing the same way it is part of that face; facing the other
  // way it is a corner the bevel cut off that face (where the face kept the old corner). Joining their
  // outlines (shared edges cancel) gives the right face in both cases.
  const merged: number[][] = [];
  const drop = new Set<number>();
  for (let h = faces.length; h < built.faces.length; h++) {
    const hf = built.faces[h];
    const hEdges = new Set(hf.map((v, i) => edgeKey(v, hf[(i + 1) % hf.length])));
    const nb = built.faces.findIndex((f, i) => i !== h && i < stripStart && !drop.has(i) && solid(f) && f.some((v, j) => hEdges.has(edgeKey(v, f[(j + 1) % f.length]))) && coplanar(built, hf, f));
    if (nb < 0) continue;
    const loop = unionLoop(built, [nb, h]);
    if (!loop) continue;
    drop.add(nb).add(h);
    merged.push(loop);
  }
  built = { ...built, faces: cleanFaces([...built.faces.filter((_, i) => !drop.has(i)), ...merged]) };
  const out = compact(built);
  // the strips end up selected (found by their corners' positions: cleaning renumbers the faces)
  const posKey = (m: MeshData, f: number[]) => f.map((v) => P(m, v).map((c) => c.toFixed(5)).join("/")).join(";");
  const wanted = new Set(strips.map((s) => posKey({ ...mesh, verts }, s)));
  const selected = new Set<number>();
  out.mesh.faces.forEach((f, i) => wanted.has(posKey(out.mesh, f)) && selected.add(i));
  return { mesh: out.mesh, sel: settle(out.mesh, { ...emptySelection(), faces: selected }, "face") };
}

// ---------------------------------------------------------------------------------------------------------
// loop cut, knife

/**
 * The ring of edges a loop cut through `start` crosses: across each quad to its opposite edge, both ways,
 * until a face is not a quad. Each edge comes with its direction (so one fraction means the same side).
 */
export function edgeRing(m: MeshData, start: [number, number]): { edges: [number, number][]; faces: number[]; closed: boolean } {
  const ef = edgeFaces(m);
  const edges: [number, number][] = [start];
  const faces: number[] = [];
  const seen = new Set([edgeKey(...start)]);
  const opposite = (f: number[], a: number, b: number): [number, number] | null => {
    if (f.length !== 4) return null;
    const i = f.indexOf(a);
    const j = f.indexOf(b);
    // quad p0 p1 p2 p3 with ring edge p0-p1: the opposite edge runs p3 -> p2 (same direction)
    if (f[(i + 1) % 4] === b) return [f[(i + 3) % 4], f[(i + 2) % 4]];
    if (f[(j + 1) % 4] === a) return [f[(i + 1) % 4], f[(i + 2) % 4]];
    return null;
  };
  let closed = false;
  for (const dir of [0, 1]) {
    let [a, b] = start;
    let from = (ef.get(edgeKey(a, b)) ?? [])[dir];
    while (from !== undefined) {
      const next = opposite(m.faces[from], a, b);
      if (!next) break;
      if (!faces.includes(from)) faces.push(from);
      const key = edgeKey(...next);
      if (seen.has(key)) {
        closed = true;
        break;
      }
      seen.add(key);
      if (dir === 0) edges.push(next);
      else edges.unshift(next);
      [a, b] = next;
      from = (ef.get(key) ?? []).find((f) => f !== from);
    }
    if (closed) break;
  }
  return { edges, faces, closed };
}

/** Loop cut (Ctrl+R): a new edge loop across the ring of `start`, `t` of the way along it (0…1) */
export function loopCut({ mesh }: OpIn, start: [number, number], t: number): OpOut {
  const ring = edgeRing(mesh, start);
  if (!ring.faces.length) throw new OpError("Loop cut needs four-sided faces next to the edge");
  const verts = mesh.verts.slice();
  const mid = new Map<string, number>();
  for (const [a, b] of ring.edges) {
    const idx = verts.length / 3;
    verts.push(...lerp(P(mesh, a), P(mesh, b), t));
    mid.set(`${a}>${b}`, idx);
    mid.set(`${b}>${a}`, idx);
  }
  const ringFaces = new Set(ring.faces);
  const faces: number[][] = [];
  const newLoop: number[] = [];
  mesh.faces.forEach((f, fi) => {
    if (ringFaces.has(fi)) {
      // split the quad between its two ring edges
      for (let r = 0; r < 4; r++) {
        const p0 = f[r], p1 = f[(r + 1) % 4], p2 = f[(r + 2) % 4], p3 = f[(r + 3) % 4];
        const m01 = mid.get(`${p0}>${p1}`);
        const m32 = mid.get(`${p3}>${p2}`);
        if (m01 === undefined || m32 === undefined) continue;
        faces.push([p0, m01, m32, p3], [m01, p1, p2, m32]);
        newLoop.push(m01, m32);
        return;
      }
    }
    if (!solid(f)) return void faces.push(f);
    // a face at the ends of an open ring gets the new vertex in its edge
    const loop: number[] = [];
    for (let k = 0; k < f.length; k++) {
      loop.push(f[k]);
      const m = mid.get(`${f[k]}>${f[(k + 1) % f.length]}`);
      if (m !== undefined) loop.push(m);
    }
    faces.push(loop);
  });
  const out = { ...mesh, verts, faces };
  const loopVerts = new Set(newLoop);
  const edges = new Set<string>();
  for (const f of faces) for (let k = 0; k < f.length; k++) if (loopVerts.has(f[k]) && loopVerts.has(f[(k + 1) % f.length])) edges.add(edgeKey(f[k], f[(k + 1) % f.length]));
  return { mesh: out, sel: settle(out, { verts: new Set(), edges, faces: new Set() }, "edge") };
}

/** a knife point: on a vertex, on an edge `t` of the way from a to b, or inside a face (mesh meters) */
export type KnifePoint = { vertex: number } | { a: number; b: number; t: number } | { inside: Vec3 };

/** the point lies on the face (its plane, within its outline) */
function insideFace(m: MeshData, f: number[], p: Vec3, tol = 0.02): boolean {
  const { n, d } = planeOf(m, f);
  if (Math.abs(vdot(n, p) - d) > tol) return false;
  const ax = Math.abs(n[0]) >= Math.abs(n[1]) && Math.abs(n[0]) >= Math.abs(n[2]) ? 0 : Math.abs(n[1]) >= Math.abs(n[2]) ? 1 : 2;
  const [u, w] = ax === 0 ? [1, 2] : ax === 1 ? [2, 0] : [0, 1];
  let inside = false;
  for (let i = 0, j = f.length - 1; i < f.length; j = i++) {
    const a = P(m, f[i]);
    const b = P(m, f[j]);
    if (a[w] > p[w] !== b[w] > p[w] && p[u] < ((b[u] - a[u]) * (p[w] - a[w])) / (b[w] - a[w]) + a[u]) inside = !inside;
  }
  return inside;
}

/**
 * Knife (K): cut faces along a path of points on vertices, on edges and inside faces. The path goes from
 * the outline of a face, through any points inside it, to its outline again, where the face is split; then
 * on into the next face.
 */
export function knife({ mesh }: OpIn, path: KnifePoint[]): OpOut {
  if (path.length < 2) throw new OpError("Click at least two points on the edges of a face");
  const m: MeshData = { ...mesh, verts: mesh.verts.slice(), faces: mesh.faces.map((f) => f.slice()) };
  const onEdge = new Map<string, number>();
  const boundary = (p: Exclude<KnifePoint, { inside: Vec3 }>): number => {
    if ("vertex" in p) return p.vertex;
    if (p.t < 1e-3) return p.a;
    if (p.t > 1 - 1e-3) return p.b;
    const key = `${Math.min(p.a, p.b)}-${Math.max(p.a, p.b)}@${(p.a < p.b ? p.t : 1 - p.t).toFixed(4)}`;
    const known = onEdge.get(key);
    if (known !== undefined) return known;
    // a new vertex on the edge, inserted in both faces that share it
    const idx = m.verts.length / 3;
    m.verts.push(...lerp(P(m, p.a), P(m, p.b), p.t));
    m.faces = m.faces.map((f) => {
      if (!solid(f)) return f;
      const out: number[] = [];
      for (let k = 0; k < f.length; k++) {
        out.push(f[k]);
        const n = f[(k + 1) % f.length];
        if ((f[k] === p.a && n === p.b) || (f[k] === p.b && n === p.a)) out.push(idx);
      }
      return out;
    });
    onEdge.set(key, idx);
    return idx;
  };
  // points on outlines become vertices first (in every face that has them), points inside stay positions
  const pts = path.map((p) => ("inside" in p ? { inside: p.inside } : { vertex: boundary(p) }));
  const cuts = new Set<number>();
  let i = 0;
  while (i < pts.length && "inside" in pts[i]) i++; // the path starts on an outline
  if (i > 0) throw new OpError("Start the knife on an edge or a vertex");
  while (i + 1 < pts.length) {
    const u = (pts[i] as { vertex: number }).vertex;
    const inner: Vec3[] = [];
    let j = i + 1;
    while (j < pts.length && "inside" in pts[j]) inner.push((pts[j++] as { inside: Vec3 }).inside);
    if (j >= pts.length) throw new OpError("End the knife on an edge or a vertex");
    const v = (pts[j] as { vertex: number }).vertex;
    if (u !== v || inner.length) {
      const fi = m.faces.findIndex((f) => {
        if (!solid(f) || !f.includes(u) || !f.includes(v) || u === v) return false;
        const d = Math.abs(f.indexOf(u) - f.indexOf(v));
        if (!inner.length && (d === 1 || d === f.length - 1)) return false; // along an edge: no cut
        return inner.every((p) => insideFace(m, f, p));
      });
      if (fi < 0) throw new OpError("Each part of the knife must cross one face, from its outline to its outline");
      const ids = inner.map((p) => {
        m.verts.push(...p);
        return m.verts.length / 3 - 1;
      });
      splitFace(m.faces, fi, u, v, ids);
      cuts.add(u).add(v);
      ids.forEach((x) => cuts.add(x));
    }
    i = j;
  }
  return { mesh: m, sel: settle(m, { verts: cuts, edges: new Set(), faces: new Set() }, "vertex") };
}

// ---------------------------------------------------------------------------------------------------------
// normals, checks

/** Recalculate normals (Shift+N): faces wound consistently with their neighbours, each part facing out */
export function recalcNormals(mesh: MeshData): MeshData {
  const faces = mesh.faces.map((f) => f.slice());
  const ef = edgeFaces(mesh);
  const part = new Int32Array(faces.length).fill(-1);
  let parts = 0;
  for (let s = 0; s < faces.length; s++) {
    if (part[s] >= 0 || !solid(faces[s])) continue;
    part[s] = parts;
    const queue = [s];
    while (queue.length) {
      const fi = queue.shift()!;
      const f = faces[fi];
      for (let k = 0; k < f.length; k++) {
        const a = f[k];
        const b = f[(k + 1) % f.length];
        for (const g of ef.get(edgeKey(a, b)) ?? []) {
          if (g === fi || part[g] >= 0) continue;
          // a neighbour must run the shared edge the other way
          if (runs(faces[g], a, b)) faces[g].reverse();
          part[g] = parts;
          queue.push(g);
        }
      }
    }
    parts++;
  }
  for (let p = 0; p < parts; p++) {
    const own = faces.filter((_, i) => part[i] === p);
    if (meshVolume({ ...mesh, faces: own }) < 0) faces.forEach((f, i) => part[i] === p && f.reverse());
  }
  return { ...mesh, faces };
}

/** Select non-manifold: open, shared-by-many, inconsistent and loose edges, pinched and loose vertices */
export function selectNonManifold(mesh: MeshData, mode: ElemMode): ElemSel {
  const t = meshTopology(mesh);
  const edges = [...t.boundary, ...t.nonManifold, ...t.flipped, ...t.wire];
  const verts = new Set<number>([...t.pinched, ...t.loose, ...edges.flat()]);
  if (mode === "edge") return settle(mesh, { verts, edges: new Set(edges.map(([a, b]) => edgeKey(a, b))), faces: new Set() }, "edge");
  if (mode === "face") {
    const faces = new Set<number>();
    mesh.faces.forEach((f, i) => solid(f) && f.some((v) => verts.has(v)) && faces.add(i));
    return settle(mesh, { verts, edges: new Set(), faces }, "face");
  }
  return { verts, edges: new Set(), faces: new Set() };
}

