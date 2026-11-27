// Element selection of a mesh in the vertex / edge / face modes. `verts` always holds every vertex the
// selection moves (the corners of the selected edges or faces too), so transforms work the same in each
// mode. Switching modes converts like Blender: up to edges / faces keeps those whose corners are all selected.

import type { MeshData } from "@/contrib/mesh";

export type ElemMode = "vertex" | "edge" | "face";
/** `active`: the vertex picked last (Merge → At active vertex), as Blender's selection history */
export type ElemSel = { verts: Set<number>; edges: Set<string>; faces: Set<number>; active?: number };

export const emptySelection = (): ElemSel => ({ verts: new Set(), edges: new Set(), faces: new Set() });

export const edgeKey = (a: number, b: number) => (a < b ? `${a}-${b}` : `${b}-${a}`);
export const edgeEnds = (k: string) => k.split("-").map(Number) as [number, number];

/** every edge of the mesh once (by face order) */
const edgeCache = new WeakMap<MeshData, [number, number][]>();
export function meshEdges(m: MeshData): [number, number][] {
  let out = edgeCache.get(m);
  if (out) return out;
  const seen = new Set<string>();
  out = [];
  for (const f of m.faces) {
    for (let i = 0; i < f.length; i++) {
      const a = f[i];
      const b = f[(i + 1) % f.length];
      const k = edgeKey(a, b);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(a < b ? [a, b] : [b, a]);
    }
  }
  edgeCache.set(m, out);
  return out;
}

/** the vertices a selection moves */
export function vertsOf(m: MeshData, sel: ElemSel, mode: ElemMode): Set<number> {
  if (mode === "vertex") return new Set(sel.verts);
  const out = new Set<number>();
  if (mode === "edge") for (const k of sel.edges) for (const v of edgeEnds(k)) out.add(v);
  else for (const f of sel.faces) for (const v of m.faces[f] ?? []) out.add(v);
  return out;
}

/** a selection made consistent for its mode (`verts` from the edges / faces) */
export function settle(m: MeshData, sel: ElemSel, mode: ElemMode): ElemSel {
  const active = sel.active !== undefined && sel.verts.has(sel.active) ? sel.active : undefined;
  if (mode === "vertex") return { verts: new Set(sel.verts), edges: new Set(), faces: new Set(), active };
  const verts = vertsOf(m, sel, mode);
  return { ...sel, verts, active: active !== undefined && verts.has(active) ? active : undefined };
}

/** an operation's result as a selection in `mode`: as it is when it holds that kind of element, else flushed
 *  from its vertices, as Blender does (a bevel's new faces show as their edges in edge mode) */
export function inMode(m: MeshData, sel: ElemSel, mode: ElemMode): ElemSel {
  const has = mode === "vertex" ? sel.verts.size : mode === "edge" ? sel.edges.size : sel.faces.size;
  if (has || !sel.verts.size) return settle(m, sel, mode);
  const out = convertSelection(m, sel, "vertex", mode);
  return { ...out, active: sel.active !== undefined && out.verts.has(sel.active) ? sel.active : undefined };
}

export function convertSelection(m: MeshData, sel: ElemSel, from: ElemMode | "object", to: ElemMode): ElemSel {
  const verts = from === "object" ? new Set<number>() : vertsOf(m, sel, from);
  if (to === "vertex") return { verts, edges: new Set(), faces: new Set() };
  if (to === "edge") {
    const edges = new Set<string>();
    for (const [a, b] of meshEdges(m)) if (verts.has(a) && verts.has(b)) edges.add(edgeKey(a, b));
    return settle(m, { verts, edges, faces: new Set() }, "edge");
  }
  const faces = new Set<number>();
  m.faces.forEach((f, i) => f.length >= 3 && f.every((v) => verts.has(v)) && faces.add(i));
  return settle(m, { verts, edges: new Set(), faces }, "face");
}

/** everything in a mode */
export function selectEverything(m: MeshData, mode: ElemMode): ElemSel {
  const all = new Set(Array.from({ length: m.verts.length / 3 }, (_, i) => i));
  return convertSelection(m, { verts: all, edges: new Set(), faces: new Set() }, "vertex", mode);
}

/** add (or toggle, or replace with) one element */
export function pickInto(m: MeshData, sel: ElemSel, mode: ElemMode, element: number | string, how: "replace" | "toggle" | "add"): ElemSel {
  const next: ElemSel = how === "replace" ? emptySelection() : { verts: new Set(sel.verts), edges: new Set(sel.edges), faces: new Set(sel.faces) };
  const set = (mode === "vertex" ? next.verts : mode === "edge" ? next.edges : next.faces) as Set<number | string>;
  if (how === "toggle" && set.has(element)) set.delete(element);
  else {
    set.add(element);
    if (mode === "vertex") next.active = element as number;
  }
  if (mode === "vertex" && how !== "replace" && next.active === undefined) next.active = sel.active;
  return settle(m, next, mode);
}
