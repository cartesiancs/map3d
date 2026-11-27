// Snapping for moves in Edit mode (Shift+Tab; what to snap to is chosen in the mode bar), as in Blender:
// the target is what the mouse points at — a vertex or an edge near it on screen, else the face under it,
// else the ground — among the buildings of the map, the other drafts and the parts of the edited ones that
// do not move. The moving vertex closest to the target lands on it: exactly in place (seen from above) and
// at exactly its height above its own ground (on terrain, buildings stand on the ground under them, so
// that is what lines them up). Ctrl steps (1 m) are the grid.

import * as THREE from "three";
import type { BuildingTileData } from "../tiles/buildTile";
import type { TileManager } from "../tiles/TileManager";
import type { EditLayer } from "./EditLayer";

export type SnapTarget = "vertex" | "edge" | "face" | "ground";
/** `point`: where it is drawn (scene); `height`: its height above its own ground (m) */
export type SnapHit = { point: THREE.Vector3; height: number; kind: SnapTarget };

/** what does not count as a target: whole drafts (Object mode), or the moving vertices of a draft */
export type SnapExclude = { drafts: Set<string>; verts: Map<string, Set<number>> };

const VERTEX_PX = 14;
const EDGE_PX = 10;
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _n1 = new THREE.Vector3();
const _n2 = new THREE.Vector3();

type Screen = { camera: THREE.Camera; w: number; h: number; x: number; y: number };

function toScreen(p: THREE.Vector3, s: Screen): [number, number] | null {
  _c.copy(p).applyMatrix4(s.camera.matrixWorldInverse);
  if (_c.z > -0.1) return null; // behind the camera
  _c.copy(p).project(s.camera);
  return [((_c.x + 1) / 2) * s.w, ((1 - _c.y) / 2) * s.h];
}

/** the point of segment p-q nearest to the mouse on screen, and how far (px) */
function nearOnSegment(p: THREE.Vector3, q: THREE.Vector3, s: Screen): { t: number; d: number } | null {
  const P = toScreen(p, s);
  const Q = toScreen(q, s);
  if (!P || !Q) return null;
  const dx = Q[0] - P[0];
  const dy = Q[1] - P[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((s.x - P[0]) * dx + (s.y - P[1]) * dy) / l2)) : 0;
  return { t, d: Math.hypot(P[0] + t * dx - s.x, P[1] + t * dy - s.y) };
}

/** tile buildings whose box is near the mouse ray (their vertices / edges are candidates) */
function nearbyTileBuildings(tm: TileManager, ray: THREE.Ray, maxDist: number) {
  const out: { d: BuildingTileData; b: number; base: Float32Array | undefined }[] = [];
  const box = new THREE.Box3();
  for (const t of tm.tiles.building.values()) {
    if (t.state !== "ready" || !t.object?.visible || !t.box) continue;
    if (ray.distanceToPoint(t.box.getCenter(_a)) > maxDist + t.box.getSize(_b).length()) continue;
    const d = t.data as BuildingTileData;
    for (let b = 0; b < d.ids.length; b++) {
      if (t.maskSaved?.has(b)) continue;
      const low = t.bases ? t.bases[2 * b] : 0;
      const high = t.bases ? t.bases[2 * b + 1] : 0;
      box.min.set(d.bounds[5 * b], tm.terrain ? low : 0, d.bounds[5 * b + 1]);
      box.max.set(d.bounds[5 * b + 2], (tm.terrain ? high : 0) + d.bounds[5 * b + 4], d.bounds[5 * b + 3]);
      if (ray.distanceToPoint(box.getCenter(_a)) > box.getSize(_b).length() / 2 + 8) continue;
      out.push({ d, b, base: tm.terrain ? t.vertexBase : undefined });
    }
  }
  return out;
}

/** the snap target under the mouse, if any (scene coordinates) */
export function findSnap(tm: TileManager, layer: EditLayer, ray: THREE.Ray, screen: Screen, targets: Set<SnapTarget>, exclude: SnapExclude): SnapHit | null {
  const tiles = targets.has("vertex") || targets.has("edge") ? nearbyTileBuildings(tm, ray, 200) : [];
  const tileVertex = (d: BuildingTileData, base: Float32Array | undefined, v: number, out: THREE.Vector3) =>
    out.set(d.positions[3 * v], d.positions[3 * v + 1] + (base ? base[v] : 0), d.positions[3 * v + 2]);
  // tile positions hold the height above the building's ground; drafts' meshes too
  const tileHeight = (d: BuildingTileData, v: number) => d.positions[3 * v + 1];
  const draftHeight = (id: string, v: number) => layer.meshHeightOf(id, v);

  if (targets.has("vertex")) {
    let best: { p: THREE.Vector3; h: number; d: number } | null = null;
    const consider = (p: THREE.Vector3, h: () => number) => {
      const q = toScreen(p, screen);
      if (!q) return;
      const d = Math.hypot(q[0] - screen.x, q[1] - screen.y);
      if (d < VERTEX_PX && (!best || d < best.d)) best = { p: p.clone(), h: h(), d };
    };
    for (const { d, b, base } of tiles) {
      const v0 = d.ranges[4 * b];
      for (let v = v0; v < v0 + d.ranges[4 * b + 1]; v++) consider(tileVertex(d, base, v, _a), () => tileHeight(d, v));
    }
    layer.forEachDisplayVertex((id, v, p) => {
      if (exclude.drafts.has(id) || exclude.verts.get(id)?.has(v)) return;
      consider(p, () => draftHeight(id, v));
    });
    if (best) {
      const hit = best as { p: THREE.Vector3; h: number };
      return { point: hit.p, height: hit.h, kind: "vertex" };
    }
  }

  if (targets.has("edge")) {
    let best: { p: THREE.Vector3; h: number; d: number } | null = null;
    const consider = (p: THREE.Vector3, q: THREE.Vector3, hp: number, hq: number) => {
      const n = nearOnSegment(p, q, screen);
      if (n && n.d < EDGE_PX && (!best || n.d < best.d)) best = { p: p.clone().lerp(q, n.t), h: hp + (hq - hp) * n.t, d: n.d };
    };
    for (const { d, b, base } of tiles) {
      // the edges of its faces: triangle edges, without the diagonals inside flat faces
      const i0 = d.ranges[4 * b + 2];
      const ic = d.ranges[4 * b + 3];
      const edges = new Map<string, { a: number; b: number; normals: THREE.Vector3[] }>();
      for (let k = i0; k < i0 + ic; k += 3) {
        const tri = [d.index[k], d.index[k + 1], d.index[k + 2]];
        tileVertex(d, base, tri[0], _a);
        tileVertex(d, base, tri[1], _b);
        tileVertex(d, base, tri[2], _c);
        const n = new THREE.Vector3().subVectors(_b, _a).cross(_n1.subVectors(_c, _a)).normalize();
        for (let e = 0; e < 3; e++) {
          const x = tri[e];
          const y = tri[(e + 1) % 3];
          const key = x < y ? `${x}-${y}` : `${y}-${x}`;
          const it = edges.get(key);
          if (it) it.normals.push(n);
          else edges.set(key, { a: x, b: y, normals: [n] });
        }
      }
      for (const e of edges.values()) {
        if (e.normals.length === 2 && e.normals[0].dot(e.normals[1]) > 0.9999) continue; // inside a flat face
        consider(tileVertex(d, base, e.a, _n1).clone(), tileVertex(d, base, e.b, _n2).clone(), tileHeight(d, e.a), tileHeight(d, e.b));
      }
    }
    layer.forEachDisplayEdge((id, a, b, p, q) => {
      if (exclude.drafts.has(id) || exclude.verts.get(id)?.has(a) || exclude.verts.get(id)?.has(b)) return;
      consider(p, q, draftHeight(id, a), draftHeight(id, b));
    });
    if (best) {
      const hit = best as { p: THREE.Vector3; h: number };
      return { point: hit.p, height: hit.h, kind: "edge" };
    }
  }

  if (targets.has("face")) {
    const fromDraft = layer.pickSurface(ray, (id, face) => !exclude.drafts.has(id) && !face.some((v) => exclude.verts.get(id)?.has(v)));
    const t = tm.pick(ray);
    if (fromDraft && (!t || fromDraft.distance <= t.distance)) return { point: fromDraft.point, height: fromDraft.local[1], kind: "face" };
    if (t) {
      // a tile building's face: its height above the roof base of that building (the ground it stands on)
      const p = ray.at(t.distance, new THREE.Vector3());
      const high = tm.terrain && t.tile.bases ? t.tile.bases[2 * t.index + 1] : 0;
      const low = tm.terrain && t.tile.bases ? t.tile.bases[2 * t.index] : 0;
      return { point: p, height: Math.max(0, p.y - (p.y - low < 0.05 ? low : high)), kind: "face" };
    }
  }

  if (targets.has("ground")) {
    const g = tm.pickGround(ray);
    if (g) return { point: g, height: 0, kind: "ground" };
  }
  return null;
}
