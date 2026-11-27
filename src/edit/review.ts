// What a changeset item does to its building, as shapes and numbers: the building before (its approved
// state, or the OSM original) and after (the proposal laid over it), for the review overlay and the diff
// rows of the review queue and My contributions.

import type { CurrentState, ItemDetail, Proposal } from "@/api/changesets";
import { MeshData, decodeMesh, groundArea, groundCenter, meshHeight, prismToMesh, toLocal } from "@/contrib/mesh";
import type { LngLat } from "@/contrib/validate";
import { buildingHeight } from "@/three/tiles/geo";

export type ItemShapes = {
  before: MeshData | null;
  after: MeshData | null;
  /** tags of the building before (for its height when it has none of its own) */
  tags: Record<string, string>;
};

function currentMesh(c: CurrentState, tags: Record<string, string>): MeshData {
  if (c.mesh) return decodeMesh(c.mesh);
  return prismToMesh(c.footprint, c.height ?? buildingHeight(tags));
}

/** a mesh with its vertices above the ground scaled to a new height (how the API applies a height to a mesh) */
function withHeight(m: MeshData, height: number): MeshData {
  const h0 = meshHeight(m);
  if (!(h0 > 0)) return m;
  return { ...m, verts: m.verts.map((v, i) => (i % 3 === 1 ? (v * height) / h0 : v)) };
}

export function itemShapes(item: Pick<ItemDetail, "kind" | "proposal" | "base" | "current">): ItemShapes {
  const tags = item.base?.tags ?? {};
  const before = item.kind === "create" ? null : item.current && !item.current.deleted ? currentMesh(item.current, tags) : item.base ? prismToMesh(item.base.footprint, buildingHeight(tags)) : null;
  if (item.kind === "delete") return { before, after: null, tags };
  return { before, after: applyProposal(before, item.current, tags, item.proposal), tags };
}

function applyProposal(before: MeshData | null, current: CurrentState | null, tags: Record<string, string>, p: Proposal): MeshData | null {
  if (p.mesh) return decodeMesh(p.mesh);
  const footprint = p.footprint ?? (current && !current.mesh ? current.footprint : null);
  if (p.footprint) return prismToMesh(p.footprint, p.height ?? (before ? meshHeight(before) : 10));
  if (before && p.height != null) return withHeight(before, p.height);
  if (footprint) return prismToMesh(footprint, p.height ?? (current?.height ?? buildingHeight(tags)));
  return before;
}

export type ItemDiff = {
  heightBefore: number | null;
  heightAfter: number | null;
  areaBefore: number | null;
  areaAfter: number | null;
  /** how far it moved (m): the middle of what stands on the ground, before and after */
  movedM: number | null;
  vertsBefore: number | null;
  vertsAfter: number | null;
  facesBefore: number | null;
  facesAfter: number | null;
};

const round1 = (v: number) => Math.round(v * 10) / 10;

export function itemDiff({ before, after }: ItemShapes): ItemDiff {
  let movedM: number | null = null;
  if (before && after) {
    // both sides measured the same way: the middle of what stands on the ground
    const [x, z] = toLocal(groundCenter(before), groundCenter(after));
    movedM = round1(Math.hypot(x, z));
  }
  return {
    heightBefore: before && round1(meshHeight(before)),
    heightAfter: after && round1(meshHeight(after)),
    areaBefore: before && Math.round(groundArea(before)),
    areaAfter: after && Math.round(groundArea(after)),
    movedM,
    vertsBefore: before && before.verts.length / 3,
    vertsAfter: after && after.verts.length / 3,
    facesBefore: before && before.faces.length,
    facesAfter: after && after.faces.length,
  };
}

/** where a shape stands (where to look at it, where a move arrow starts and ends) */
export const shapeCenter = (m: MeshData): LngLat => groundCenter(m);
