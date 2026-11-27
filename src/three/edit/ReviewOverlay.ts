// What a changeset does, drawn in the 3D view (review queue, My contributions): each building as it is now,
// semi-transparent grey, and as proposed, semi-transparent red with red edges; a removed building in
// translucent red with dashed edges; a move as an arrow from the old outline center to the new one. The
// tile copies of these buildings are masked meanwhile. Before / After / Both shows one side or both.

import * as THREE from "three";
import type { Kind } from "@/api/changesets";
import type { MeshData } from "@/contrib/mesh";
import { shapeCenter } from "@/edit/review";
import type { TileManager } from "../tiles/TileManager";
import { H_UNIT_M, toScene } from "../tiles/geo";
import { clearGroup, frameMatrix, groundUnder, solidGeometry, solidMaterial } from "./solids";

export type ReviewShape = {
  /** the building in the tiles (masked while shown), null for a new building */
  id: number | null;
  kind: Kind;
  before: MeshData | null;
  after: MeshData | null;
};
export type ReviewView = "before" | "after" | "both";

const MASK_OWNER = "review";
/** while a ground tile is missing the shapes stand on y = 0; rebuilt at most this often until it arrives */
const GROUND_RETRY_MS = 400;

export class ReviewOverlay {
  readonly group = new THREE.Group();
  private shapes: ReviewShape[] = [];
  private view: ReviewView = "both";
  private dirty = false;
  private built = { originId: -1, terrain: false, ground: true, at: 0 };
  private materials: ReturnType<ReviewOverlay["makeMaterials"]> | null = null;
  private pbr: boolean | null = null;
  private colors: unknown = null;

  constructor(private tm: TileManager) {
    this.group.name = "review-overlay";
  }

  /** shapes to show (null: nothing) */
  show(shapes: ReviewShape[] | null) {
    this.shapes = shapes ?? [];
    this.tm.setMasked(this.shapes.filter((s) => s.id !== null && s.kind !== "create").map((s) => s.id!), MASK_OWNER);
    this.dirty = true;
    this.tm.onChange();
  }

  setView(view: ReviewView) {
    if (view === this.view) return;
    this.view = view;
    this.dirty = true;
    this.tm.onChange();
  }

  get active() {
    return this.shapes.length > 0;
  }

  private makeMaterials(pbr: boolean) {
    const c = this.tm.colors;
    return {
      ghost: solidMaterial(pbr, { color: c.building, transparent: true, opacity: 0.35, depthWrite: false }),
      solid: solidMaterial(pbr, { color: c.building, transparent: true, opacity: 0.9 }),
      red: solidMaterial(pbr, { color: c.review, transparent: true, opacity: 0.45, depthWrite: false }),
      redStrong: solidMaterial(pbr, { color: c.review, transparent: true, opacity: 0.75 }),
      edges: new THREE.LineBasicMaterial({ color: c.review }),
      greyEdges: new THREE.LineBasicMaterial({ color: c.building }),
      // the original's outline, so the faint ghost reads against the buildings around it
      ghostEdges: new THREE.LineBasicMaterial({ color: c.reviewGhostEdge, transparent: true, opacity: 0.85, depthTest: false }),
      dashed: new THREE.LineDashedMaterial({ color: c.review, dashSize: 1.5, gapSize: 1 }),
    };
  }

  /** each frame: rebuild after a change, a rebase, terrain on / off, or once the ground under it has loaded */
  update(now = performance.now()) {
    const pbr = this.tm.config.pbr;
    if (this.pbr !== pbr || this.colors !== this.tm.colors || !this.materials) {
      if (this.materials) for (const m of Object.values(this.materials)) m.dispose();
      this.materials = this.makeMaterials(pbr);
      this.pbr = pbr;
      this.colors = this.tm.colors;
      this.dirty = true;
    }
    const b = this.built;
    const stale = b.originId !== this.tm.originId || b.terrain !== this.tm.terrain || (!b.ground && now - b.at > GROUND_RETRY_MS);
    if (!this.dirty && !stale) return;
    this.dirty = false;
    this.rebuild(now);
  }

  private rebuild(now: number) {
    // arrows own their materials (the shapes share this overlay's)
    this.group.traverse((o) => {
      if (o instanceof THREE.ArrowHelper) {
        (o.line.material as THREE.Material).dispose();
        (o.cone.material as THREE.Material).dispose();
      }
    });
    clearGroup(this.group);
    const m = this.materials!;
    let groundReady = true;
    const add = (shape: MeshData, material: THREE.Material, edges: THREE.LineBasicMaterial | THREE.LineDashedMaterial | null, order: number, solidShown = true) => {
      const matrix = frameMatrix(this.tm.origin, shape.anchor);
      const ground = groundUnder(this.tm, shape.verts, matrix);
      if (!ground) groundReady = false;
      const geometry = solidGeometry(shape, ground ?? [0, 0]);
      const solid = new THREE.Mesh(geometry, material);
      solid.matrixAutoUpdate = false;
      solid.matrix.copy(matrix);
      solid.renderOrder = order;
      solid.visible = solidShown;
      this.group.add(solid);
      if (edges) {
        const lines = new THREE.LineSegments(new THREE.EdgesGeometry(geometry, 20), edges);
        if (edges instanceof THREE.LineDashedMaterial) lines.computeLineDistances();
        lines.matrixAutoUpdate = false;
        lines.matrix.copy(matrix);
        lines.renderOrder = order + 1;
        this.group.add(lines);
      }
    };

    for (const s of this.shapes) {
      const v = this.view;
      if (s.kind === "delete") {
        if (!s.before) continue;
        if (v === "before") add(s.before, m.solid, m.greyEdges, 2);
        else add(s.before, m.red, m.dashed, 3, v === "both"); // after: where it was, as a dashed outline
        continue;
      }
      if (s.before && v !== "after") add(s.before, v === "before" ? m.solid : m.ghost, v === "before" ? m.greyEdges : m.ghostEdges, 2);
      if (s.after && v !== "before") add(s.after, v === "after" ? m.redStrong : m.red, m.edges, 4);
      if (v === "both" && s.before && s.after) this.addMoveArrow(s.before, s.after);
    }
    this.built = { originId: this.tm.originId, terrain: this.tm.terrain, ground: groundReady, at: now };
  }

  /** an arrow from where the building stood to where it would stand (moves over half a meter) */
  private addMoveArrow(before: MeshData, after: MeshData) {
    const [lng0, lat0] = shapeCenter(before);
    const [lng1, lat1] = shapeCenter(after);
    const [x0, z0] = toScene(this.tm.origin, lat0, lng0);
    const [x1, z1] = toScene(this.tm.origin, lat1, lng1);
    const length = Math.hypot(x1 - x0, z1 - z0);
    if (length * H_UNIT_M < 0.5) return;
    const top = Math.max(...[before, after].map((s) => s.verts.filter((_, i) => i % 3 === 1).reduce((a, y) => Math.max(a, y), 0)));
    const y = (this.tm.groundHeightAt(x0, z0) ?? 0) + top + 4;
    const dir = new THREE.Vector3(x1 - x0, 0, z1 - z0).normalize();
    const arrow = new THREE.ArrowHelper(dir, new THREE.Vector3(x0, y, z0), length, this.tm.colors.review, Math.min(6, length * 0.4), Math.min(4, length * 0.25));
    arrow.renderOrder = 5;
    this.group.add(arrow);
  }
}
