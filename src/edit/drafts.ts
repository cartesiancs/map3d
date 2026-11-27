// Edit mode drafts: the buildings of an editing session, each with the shape it started from and its
// current shape (both meshes in meters, src/contrib/mesh.ts). Pure data and checks; the session state
// lives in src/state/editStore.ts.

import type { BuildingBase, ItemInput, Proposal } from "@/api/changesets";
import { MeshData, classifyPrism, encodeMesh, groundCenter, isWire, meshHeight, meshOutline, normalizeMesh, toLocal, validateMesh } from "@/contrib/mesh";
import { selfIntersections } from "./intersect";
import { withHeight } from "./transform";
import { LIMITS, type LngLat } from "@/contrib/validate";

/** the API's limits (worker/src/changesets.ts RULES), checked here first so they show before submitting */
export const CHANGESET_LIMITS = { maxMoveM: 200, maxSpanM: 1000, maxBodyBytes: 1_000_000, maxBuildings: 50 };

export type Draft = {
  /** "way:<id>" / "new:<n>" for a building that exists, "draft:<uuid>" for one added in this session */
  readonly id: string;
  readonly ref: string | null;
  /** the building in the tiles (masked while it is edited), null for an added one */
  readonly featureId: number | null;
  readonly kind: "modify" | "create";
  /** the OSM building (footprint, tags) the first edit of a way starts from */
  readonly base: BuildingBase | null;
  /** its map3d:edited tag when editing started ('osm': never edited) */
  readonly baseRev: string;
  readonly tags: Record<string, string>;
  /** the shape when editing started (null: added in this session) */
  readonly original: MeshData | null;
  readonly originalLevels: number | null;
  readonly mesh: MeshData;
  readonly levels: number | null;
  readonly deleted: boolean;
};

export const isNewDraft = (id: string) => id.startsWith("draft:");
export const newDraftId = () => `draft:${crypto.randomUUID()}`;

export function levelsOf(tags: Record<string, string>): number | null {
  const v = tags["building:levels"];
  return v && /^\d+$/.test(v) ? Number(v) : null;
}

const sameMesh = (a: MeshData, b: MeshData) =>
  a === b ||
  (a.anchor[0] === b.anchor[0] &&
    a.anchor[1] === b.anchor[1] &&
    a.verts.length === b.verts.length &&
    a.faces.length === b.faces.length &&
    a.verts.every((v, i) => Math.abs(v - b.verts[i]) < 5e-4) &&
    a.faces.every((f, i) => f.length === b.faces[i].length && f.every((v, k) => v === b.faces[i][k])));

export const shapeChanged = (d: Draft) => !d.original || !sameMesh(d.mesh, d.original);

/** the draft would change something when submitted */
export function isChanged(d: Draft) {
  if (d.kind === "create") return !d.deleted;
  return d.deleted || shapeChanged(d) || d.levels !== d.originalLevels;
}

/** changed in height (and levels) only, if at all: the building as it was, taller or lower (Height editing) */
export function onlyHeight(d: Draft): boolean {
  if (d.kind !== "modify" || d.deleted || !d.original) return false;
  return !shapeChanged(d) || sameMesh(d.mesh, withHeight(d.original, meshHeight(d.mesh)));
}

export type DraftStatus = "modified" | "new" | "deleted" | "unchanged";
export function draftStatus(d: Draft): DraftStatus {
  if (d.kind === "create") return "new";
  if (d.deleted) return "deleted";
  return isChanged(d) ? "modified" : "unchanged";
}

/** the middle of a shape's outline seen from above (as the API measures a move) */
export function outlineCenter(m: MeshData): LngLat {
  const ring = classifyPrism(m)?.footprint ?? meshOutline(m);
  let lng = 0;
  let lat = 0;
  for (const [x, y] of ring) {
    lng += x;
    lat += y;
  }
  return [lng / ring.length, lat / ring.length];
}

/** how far a draft's outline moved from where the building stood (m) */
export function movedM(d: Draft): number {
  if (!d.original) return 0;
  const [x, z] = toLocal(groundCenter(d.original), groundCenter(d.mesh));
  return Math.hypot(x, z);
}

/** does the draft send a footprint or a mesh (else only a height and levels, which the API does not check as a shape) */
const sendsShapeOf = new WeakMap<Draft, boolean>();
function sendsShape(d: Draft): boolean {
  let v = sendsShapeOf.get(d);
  if (v === undefined) {
    const p = toItem(d).proposal ?? {};
    v = !!(p.footprint || p.mesh);
    sendsShapeOf.set(d, v);
  }
  return v;
}

/** problems that block submitting the draft (its shape, when that changed, and how far it moved) */
const checked = new WeakMap<MeshData, string[]>();
export function draftErrors(d: Draft): string[] {
  if (d.deleted || !shapeChanged(d)) return [];
  // only taller or lower: the footprint stays as it is on the map (an OSM footprint the shape rules would
  // refuse, crossing itself say, can still be given a height), so only the height is checked
  if (d.kind === "modify" && !sendsShape(d)) {
    const h = meshHeight(d.mesh);
    return h >= LIMITS.minHeight && h <= LIMITS.maxHeight ? [] : [`the height must be between ${LIMITS.minHeight} and ${LIMITS.maxHeight} m`];
  }
  let errors = checked.get(d.mesh);
  if (!errors) {
    errors = validateMesh(normalizeMesh(d.mesh));
    if (d.kind === "modify" && movedM(d) > CHANGESET_LIMITS.maxMoveM) {
      errors = [...errors, `an edited building must stay within ${CHANGESET_LIMITS.maxMoveM} m of where it was`];
    }
    checked.set(d.mesh, errors);
  }
  return errors;
}

/** what does not block submitting but is worth knowing: faces cutting through each other, loose edges left out */
export type DraftWarnings = { crossing: Set<number>; loose: number };
export function draftWarnings(d: Draft): DraftWarnings {
  if (d.deleted || !shapeChanged(d)) return { crossing: new Set(), loose: 0 };
  return { crossing: selfIntersections(d.mesh), loose: d.mesh.faces.filter(isWire).length };
}

/** problems of the changeset as a whole: how many buildings, how far apart, how large */
export function changesetErrors(drafts: Draft[]): string[] {
  const errors: string[] = [];
  if (drafts.length > CHANGESET_LIMITS.maxBuildings) errors.push(`A changeset has at most ${CHANGESET_LIMITS.maxBuildings} buildings: revert some, submit, then continue.`);
  if (drafts.length > 1) {
    const centers = drafts.map((d) => outlineCenter(d.deleted && d.original ? d.original : d.mesh));
    const lngs = centers.map((c) => c[0]);
    const lats = centers.map((c) => c[1]);
    const sw: LngLat = [Math.min(...lngs), Math.min(...lats)];
    const [w] = toLocal(sw, [Math.max(...lngs), sw[1]]);
    const [, h] = toLocal(sw, [sw[0], Math.max(...lats)]);
    if (Math.abs(w) > CHANGESET_LIMITS.maxSpanM || Math.abs(h) > CHANGESET_LIMITS.maxSpanM) {
      errors.push(`The buildings of one changeset must lie within ${CHANGESET_LIMITS.maxSpanM} m of each other: submit them in separate changesets.`);
    }
  }
  const bytes = JSON.stringify(drafts.map(toItem)).length;
  if (bytes > CHANGESET_LIMITS.maxBodyBytes) errors.push(`The changeset is too large (${(bytes / 1e6).toFixed(1)} MB, at most 1 MB): submit fewer or simpler buildings at a time.`);
  return errors;
}

/** the same corners in the same order (any start) */
function sameRing(a: LngLat[], b: LngLat[]) {
  if (a.length !== b.length) return false;
  const k = (p: LngLat) => `${Math.round(p[0] * 1e7)},${Math.round(p[1] * 1e7)}`;
  const A = a.map(k);
  const B = b.map(k);
  const s = B.indexOf(A[0]);
  return s >= 0 && A.every((v, i) => v === B[(s + i) % B.length]);
}

/** the changeset item a draft becomes */
export function toItem(d: Draft): ItemInput {
  if (d.kind === "modify" && d.deleted) return { ref: d.ref!, kind: "delete", ...(d.base ? { base: d.base } : {}), baseRev: d.baseRev };
  const proposal: Proposal = {};
  if (shapeChanged(d)) {
    const clean = normalizeMesh(d.mesh);
    const prism = classifyPrism(clean);
    if (prism) {
      // the same footprint as before (both cleaned alike): only the height changed. Sending the footprint
      // again would put it through the shape rules, which many OSM footprints do not meet (tiny edges).
      const before = d.original && classifyPrism(normalizeMesh(d.original));
      if (!before || !sameRing(before.footprint, prism.footprint)) proposal.footprint = prism.footprint;
      proposal.height = prism.height;
    } else proposal.mesh = encodeMesh(clean);
  }
  if (d.levels !== d.originalLevels || (d.kind === "create" && d.levels !== null)) proposal.levels = d.levels;
  if (d.kind === "create") return { kind: "create", clientId: d.id, proposal };
  return { ref: d.ref!, kind: "modify", ...(d.base ? { base: d.base } : {}), baseRev: d.baseRev, proposal };
}
