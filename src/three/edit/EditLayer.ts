// The buildings of an Edit mode session in the 3D view: each draft drawn from its mesh (the tile copy is
// masked), the selection (whole buildings in Object mode; vertices, edges and faces in the element modes),
// removed buildings as a dashed outline, and picking of all of these. Drafts keep their meters under an
// object matrix (solids.ts), so a rebase only moves them.

import * as THREE from "three";
import type { Draft } from "@/edit/drafts";
import type { ElemSel } from "@/edit/select";
import { edgeKey, meshEdges } from "@/edit/select";
import type { Mode } from "@/state/editStore";
import { SCENE_COLORS, type TileManager } from "../tiles/TileManager";
import { triangulateFace } from "../meshGeometry";
import { clearGroup, frameMatrix, groundUnder, solidGeometry, solidMaterial } from "./solids";

const MASK_OWNER = "edit";
const GROUND_RETRY_MS = 400;

/** what a draft is drawn with; rebuilt when any of it changes */
type View = {
  draft: Draft;
  selected: boolean;
  active: boolean;
  elems: ElemSel | null;
  mode: Mode;
  originId: number;
  terrain: boolean;
  groundReady: boolean;
  builtAt: number;
  root: THREE.Group;
  solid: THREE.Mesh | null;
  /** triangle -> face */
  triFace: Int32Array;
  /** vertex positions as drawn (meters, ground offset included) */
  display: Float32Array;
};

export type ElementHit = { id: string; element: number | string };

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();

export class EditLayer {
  readonly group = new THREE.Group();
  private views = new Map<string, View>();
  private materials: ReturnType<EditLayer["makeMaterials"]> | null = null;
  private style: unknown = null;
  private raycaster = new THREE.Raycaster();
  /** the footprint being drawn (Add → Draw footprint) */
  private drawLine: THREE.Line | null = null;
  /** where a move snaps to */
  private snapMarker: THREE.Points | null = null;

  constructor(private tm: TileManager) {
    this.group.name = "edit-layer";
  }

  private makeMaterials(pbr: boolean) {
    const c = this.tm.colors;
    // pushed back a little so edges and points on the faces stay visible
    const offset = { polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 };
    return {
      solid: solidMaterial(pbr, { color: c.building, ...offset }),
      selected: solidMaterial(pbr, { color: c.selected, ...offset }),
      editing: solidMaterial(pbr, { color: c.building, ...offset }),
      faceSel: new THREE.MeshBasicMaterial({ color: c.editSelected, transparent: true, opacity: 0.35, depthWrite: false, side: THREE.DoubleSide }),
      edges: new THREE.LineBasicMaterial({ vertexColors: true }),
      outline: new THREE.LineBasicMaterial({ color: c.selected }),
      removed: new THREE.LineDashedMaterial({ color: c.review, dashSize: 1.2, gapSize: 0.8 }),
      points: new THREE.PointsMaterial({ size: 7, sizeAttenuation: false, vertexColors: true }),
      edgeColor: new THREE.Color(c.editEdge),
      selColor: new THREE.Color(c.editSelected),
    };
  }

  /** Bring the drawing up to date with the session (each frame; only what changed is rebuilt). */
  update(s: { active: boolean; drafts: Map<string, Draft>; objects: Set<string>; activeId: string | null; elems: Map<string, ElemSel>; mode: Mode }, now = performance.now()) {
    const pbr = this.tm.config.pbr;
    const style = `${pbr}|${this.tm.colors === SCENE_COLORS.dark}`;
    if (style !== this.style || !this.materials) {
      if (this.materials) for (const m of Object.values(this.materials)) if (m instanceof THREE.Material) m.dispose();
      this.materials = this.makeMaterials(pbr);
      this.style = style;
      for (const v of this.views.values()) v.originId = -1; // rebuild all
    }
    const drafts = s.active ? s.drafts : new Map<string, Draft>();
    for (const [id, v] of this.views) {
      if (drafts.has(id)) continue;
      clearGroup(v.root);
      this.group.remove(v.root);
      this.views.delete(id);
    }
    for (const [id, d] of drafts) {
      const editing = s.mode !== "object" && s.objects.has(id);
      const elems = editing ? s.elems.get(id) ?? null : null;
      const v = this.views.get(id);
      const want = { selected: s.objects.has(id), active: s.activeId === id, elems, mode: s.mode };
      const fresh =
        v &&
        v.draft === d &&
        v.selected === want.selected &&
        v.active === want.active &&
        v.elems === want.elems &&
        v.mode === want.mode &&
        v.originId === this.tm.originId &&
        v.terrain === this.tm.terrain &&
        (v.groundReady || now - v.builtAt < GROUND_RETRY_MS);
      if (fresh) continue;
      this.build(id, d, want, now);
    }
    this.tm.setMasked(
      [...drafts.values()].filter((d) => d.featureId !== null).map((d) => d.featureId!),
      MASK_OWNER,
    );
  }

  private build(id: string, d: Draft, want: { selected: boolean; active: boolean; elems: ElemSel | null; mode: Mode }, now: number) {
    let v = this.views.get(id);
    if (!v) {
      const root = new THREE.Group();
      root.matrixAutoUpdate = false;
      root.userData.draftId = id;
      this.group.add(root);
      v = { draft: d, ...want, originId: -1, terrain: false, groundReady: false, builtAt: 0, root, solid: null, triFace: new Int32Array(), display: new Float32Array() };
      this.views.set(id, v);
    }
    clearGroup(v.root);
    const m = this.materials!;
    const mesh = d.deleted && d.original ? d.original : d.mesh;
    frameMatrix(this.tm.origin, mesh.anchor, v.root.matrix);
    v.root.matrixWorldNeedsUpdate = true;
    const ground = groundUnder(this.tm, mesh.verts, v.root.matrix);
    const tris: number[] = [];
    const triFace: number[] = [];
    mesh.faces.forEach((f, i) => {
      const before = tris.length;
      triangulateFace(mesh.verts, f, tris);
      for (let k = before; k < tris.length; k += 3) triFace.push(i);
    });
    const geometry = solidGeometry(mesh, ground ?? [0, 0], tris);
    v.display = geometry.getAttribute("position").array as Float32Array;
    v.triFace = Int32Array.from(triFace);
    Object.assign(v, { draft: d, ...want, originId: this.tm.originId, terrain: this.tm.terrain, groundReady: !!ground, builtAt: now });

    if (d.deleted) {
      // where a removed building was: dashed edges only (not pickable)
      const lines = new THREE.LineSegments(new THREE.EdgesGeometry(geometry, 20), m.removed);
      lines.computeLineDistances();
      v.root.add(lines);
      geometry.dispose();
      v.solid = null;
      return;
    }
    const editing = !!want.elems;
    const solid = new THREE.Mesh(geometry, editing ? m.editing : want.selected ? m.selected : m.solid);
    solid.userData.draftId = id;
    v.solid = solid;
    v.root.add(solid);

    if (!editing) {
      if (want.selected) v.root.add(new THREE.LineSegments(new THREE.EdgesGeometry(geometry, 20), m.outline));
      return;
    }
    // element modes: every edge, the selection in orange, vertices as points in vertex mode
    const sel = want.elems!;
    const edges = meshEdges(mesh);
    const pos = new Float32Array(edges.length * 6);
    const col = new Float32Array(edges.length * 6);
    edges.forEach(([a, b], i) => {
      pos.set(v!.display.subarray(3 * a, 3 * a + 3), 6 * i);
      pos.set(v!.display.subarray(3 * b, 3 * b + 3), 6 * i + 3);
      const on = want.mode === "edge" ? sel.edges.has(edgeKey(a, b)) : want.mode === "vertex" ? sel.verts.has(a) && sel.verts.has(b) : false;
      const c = on ? m.selColor : m.edgeColor;
      c.toArray(col, 6 * i);
      c.toArray(col, 6 * i + 3);
    });
    const eg = new THREE.BufferGeometry();
    eg.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    eg.setAttribute("color", new THREE.BufferAttribute(col, 3));
    const lines = new THREE.LineSegments(eg, m.edges);
    lines.renderOrder = 2;
    v.root.add(lines);

    if (want.mode === "face" && sel.faces.size) {
      const idx: number[] = [];
      for (let t = 0; t < v.triFace.length; t++) if (sel.faces.has(v.triFace[t])) idx.push(tris[3 * t], tris[3 * t + 1], tris[3 * t + 2]);
      const fg = new THREE.BufferGeometry();
      fg.setAttribute("position", new THREE.BufferAttribute(v.display, 3));
      fg.setIndex(idx);
      const faces = new THREE.Mesh(fg, m.faceSel);
      faces.renderOrder = 3;
      v.root.add(faces);
    }
    if (want.mode === "vertex") {
      const n = mesh.verts.length / 3;
      const pc = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) (sel.verts.has(i) ? m.selColor : m.edgeColor).toArray(pc, 3 * i);
      const pg = new THREE.BufferGeometry();
      pg.setAttribute("position", new THREE.BufferAttribute(v.display.slice(), 3));
      pg.setAttribute("color", new THREE.BufferAttribute(pc, 3));
      const points = new THREE.Points(pg, m.points);
      points.renderOrder = 4;
      v.root.add(points);
    }
  }

  /** the outline of a footprint being drawn on the ground (scene points), or none */
  setDrawPreview(points: THREE.Vector3[] | null) {
    this.setGuide(points && points.map((p) => p.clone().setY(p.y + 0.5)), "strip");
  }

  /** a guide drawn over everything (tool previews): a polyline, or separate segments (pairs of points) */
  setGuide(points: THREE.Vector3[] | null, kind: "strip" | "pairs" = "strip") {
    if (this.drawLine) {
      this.group.remove(this.drawLine);
      this.drawLine.geometry.dispose();
      (this.drawLine.material as THREE.Material).dispose();
      this.drawLine = null;
    }
    if (!points?.length) return;
    const g = new THREE.BufferGeometry().setFromPoints(points);
    const material = new THREE.LineBasicMaterial({ color: kind === "pairs" ? "#facc15" : this.tm.colors.editSelected, depthTest: false });
    this.drawLine = kind === "pairs" ? new THREE.LineSegments(g, material) : new THREE.Line(g, material);
    this.drawLine.renderOrder = 6;
    this.group.add(this.drawLine);
  }

  /** mark the point a move snaps to (vertex: square-ish dot, edge / face / ground: other colors), or none */
  setSnapMarker(point: THREE.Vector3 | null, kind: "vertex" | "edge" | "face" | "ground" = "vertex") {
    if (!point) {
      if (this.snapMarker) this.snapMarker.visible = false;
      return;
    }
    if (!this.snapMarker) {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(3), 3));
      this.snapMarker = new THREE.Points(g, new THREE.PointsMaterial({ size: 13, sizeAttenuation: false, depthTest: false, transparent: true }));
      this.snapMarker.renderOrder = 8;
      this.snapMarker.frustumCulled = false;
      this.group.add(this.snapMarker);
    }
    const colors = { vertex: "#facc15", edge: "#38bdf8", face: "#a78bfa", ground: "#4ade80" };
    (this.snapMarker.material as THREE.PointsMaterial).color.set(colors[kind]);
    const attr = this.snapMarker.geometry.getAttribute("position") as THREE.BufferAttribute;
    attr.setXYZ(0, point.x, point.y, point.z);
    attr.needsUpdate = true;
    this.snapMarker.visible = true;
  }

  /** every drawn vertex of the drafts (scene coordinates) */
  forEachDisplayVertex(f: (id: string, v: number, p: THREE.Vector3) => void) {
    const p = new THREE.Vector3();
    for (const [id, v] of this.views) {
      if (v.draft.deleted) continue;
      for (let i = 0; i < v.display.length / 3; i++) f(id, i, p.fromArray(v.display, 3 * i).applyMatrix4(v.root.matrix));
    }
  }

  /** every drawn edge of the drafts (scene coordinates) */
  forEachDisplayEdge(f: (id: string, a: number, b: number, p: THREE.Vector3, q: THREE.Vector3) => void) {
    const p = new THREE.Vector3();
    const q = new THREE.Vector3();
    for (const [id, v] of this.views) {
      if (v.draft.deleted) continue;
      for (const [a, b] of meshEdges(v.draft.mesh)) {
        if (3 * Math.max(a, b) >= v.display.length) continue;
        f(id, a, b, p.fromArray(v.display, 3 * a).applyMatrix4(v.root.matrix), q.fromArray(v.display, 3 * b).applyMatrix4(v.root.matrix));
      }
    }
  }

  /**
   * The nearest drawn face under the ray that `accept` lets through: where it is hit (scene) and that point
   * in the draft's own meters (exact: from the hit triangle's corners).
   */
  pickSurface(ray: THREE.Ray, accept: (id: string, face: number[]) => boolean = () => true) {
    this.raycaster.ray.copy(ray);
    let best: { id: string; face: number; distance: number; point: THREE.Vector3; local: [number, number, number] } | null = null;
    const tri = new THREE.Triangle();
    const bary = new THREE.Vector3();
    for (const [id, v] of this.views) {
      if (!v.solid) continue;
      v.root.updateMatrixWorld(true);
      for (const hit of this.raycaster.intersectObject(v.solid, false)) {
        if (best && hit.distance >= best.distance) break;
        if (hit.faceIndex == null || !hit.face) continue;
        const face = v.triFace[hit.faceIndex];
        if (!accept(id, v.draft.mesh.faces[face])) continue;
        const { a, b, c } = hit.face;
        tri.set(this.displayPoint(id, a)!, this.displayPoint(id, b)!, this.displayPoint(id, c)!);
        tri.getBarycoord(hit.point, bary);
        const m = v.draft.mesh.verts;
        const local = [0, 1, 2].map((k) => bary.x * m[3 * a + k] + bary.y * m[3 * b + k] + bary.z * m[3 * c + k]) as [number, number, number];
        best = { id, face, distance: hit.distance, point: hit.point.clone(), local };
        break;
      }
    }
    return best;
  }

  /** a vertex's height above its draft's ground (its mesh y) */
  meshHeightOf(id: string, v: number): number {
    return this.views.get(id)?.draft.mesh.verts[3 * v + 1] ?? 0;
  }

  /** a scene point in a draft's meters (on the drawn surface: its ground offset taken off) */
  toDraftMeters(id: string, p: THREE.Vector3): [number, number, number] | null {
    const v = this.views.get(id);
    if (!v) return null;
    const q = p.clone().applyMatrix4(new THREE.Matrix4().copy(v.root.matrix).invert());
    return [q.x, Math.max(0, q.y - this.groundOf(id)), q.z];
  }

  /** how far along an edge a screen point lies (0 at a, 1 at b), measured on screen */
  edgeParam(id: string, a: number, b: number, x: number, y: number, camera: THREE.Camera, w: number, h: number): number {
    const v = this.views.get(id);
    if (!v) return 0.5;
    const p = this.screen(v, a, camera, w, h);
    const q = this.screen(v, b, camera, w, h);
    if (!p || !q) return 0.5;
    const dx = q[0] - p[0];
    const dy = q[1] - p[1];
    const l2 = dx * dx + dy * dy;
    return l2 ? Math.max(0, Math.min(1, ((x - p[0]) * dx + (y - p[1]) * dy) / l2)) : 0.5;
  }

  // ---------------------------------------------------------------------------------------------------
  // positions and picking

  /** a vertex as drawn, in scene coordinates */
  displayPoint(id: string, vertex: number, target = new THREE.Vector3()): THREE.Vector3 | null {
    const v = this.views.get(id);
    if (!v || vertex * 3 >= v.display.length) return null;
    return target.fromArray(v.display, 3 * vertex).applyMatrix4(v.root.matrix);
  }

  /** the ground offset a draft is drawn with (its highest ground under it; 0 without terrain) */
  groundOf(id: string): number {
    const v = this.views.get(id);
    if (!v) return 0;
    const mesh = v.draft.mesh;
    for (let i = 0; i < mesh.verts.length / 3; i++) if (mesh.verts[3 * i + 1] >= 0.05) return v.display[3 * i + 1] - mesh.verts[3 * i + 1];
    return 0;
  }

  /** the nearest drawn draft under the ray */
  pickDraft(ray: THREE.Ray): { id: string; distance: number } | null {
    this.raycaster.ray.copy(ray);
    let best: { id: string; distance: number } | null = null;
    for (const [id, v] of this.views) {
      if (!v.solid) continue;
      v.root.updateMatrixWorld(true);
      const hit = this.raycaster.intersectObject(v.solid, false)[0];
      if (hit && (!best || hit.distance < best.distance)) best = { id, distance: hit.distance };
    }
    return best;
  }

  /** the face of a draft under the ray */
  pickFace(ray: THREE.Ray, ids: Iterable<string>): (ElementHit & { distance: number }) | null {
    this.raycaster.ray.copy(ray);
    let best: (ElementHit & { distance: number }) | null = null;
    for (const id of ids) {
      const v = this.views.get(id);
      if (!v?.solid) continue;
      v.root.updateMatrixWorld(true);
      const hit = this.raycaster.intersectObject(v.solid, false)[0];
      if (hit && hit.faceIndex != null && (!best || hit.distance < best.distance)) best = { id, element: v.triFace[hit.faceIndex], distance: hit.distance };
    }
    return best;
  }

  /** screen position (px from the canvas' top left) and camera distance of a drawn vertex */
  private screen(v: View, i: number, camera: THREE.Camera, w: number, h: number): [number, number, number] | null {
    _v.fromArray(v.display, 3 * i).applyMatrix4(v.root.matrix);
    const depth = _w.copy(_v).applyMatrix4(camera.matrixWorldInverse).z;
    if (depth > -0.1) return null; // behind the camera
    _v.project(camera);
    return [((_v.x + 1) / 2) * w, ((1 - _v.y) / 2) * h, -depth];
  }

  /**
   * The vertex or edge nearest to a screen point (px), among the drafts being edited, within `radius` px;
   * of near-equal candidates the one closer to the camera.
   */
  pickNear(mode: "vertex" | "edge", ids: Iterable<string>, x: number, y: number, camera: THREE.Camera, w: number, h: number, radius = 12): ElementHit | null {
    // candidates within the radius on screen, with the point that would be picked (scene)
    const cands: { hit: ElementHit; d: number; depth: number; at: THREE.Vector3 }[] = [];
    for (const id of ids) {
      const v = this.views.get(id);
      if (!v || v.draft.deleted) continue;
      const mesh = v.draft.mesh;
      const n = mesh.verts.length / 3;
      const pts: ([number, number, number] | null)[] = [];
      for (let i = 0; i < n; i++) pts.push(this.screen(v, i, camera, w, h));
      const world = (i: number) => new THREE.Vector3().fromArray(v.display, 3 * i).applyMatrix4(v.root.matrix);
      if (mode === "vertex") {
        pts.forEach((p, i) => {
          const d = p ? Math.hypot(p[0] - x, p[1] - y) : Infinity;
          if (p && d <= radius) cands.push({ hit: { id, element: i }, d, depth: p[2], at: world(i) });
        });
        continue;
      }
      for (const [a, b] of meshEdges(mesh)) {
        const p = pts[a];
        const q = pts[b];
        if (!p || !q) continue;
        const dx = q[0] - p[0];
        const dy = q[1] - p[1];
        const l2 = dx * dx + dy * dy;
        const t = l2 ? Math.max(0, Math.min(1, ((x - p[0]) * dx + (y - p[1]) * dy) / l2)) : 0;
        const d = Math.hypot(p[0] + t * dx - x, p[1] + t * dy - y);
        if (d <= radius) cands.push({ hit: { id, element: edgeKey(a, b) }, d, depth: p[2] + (q[2] - p[2]) * t, at: world(a).lerp(world(b), t) });
      }
    }
    // nearest on screen; of near-equal ones the one closer to the camera; never one hidden behind a surface
    cands.sort((a, b) => (Math.abs(a.d - b.d) <= 2 ? a.depth - b.depth : a.d - b.d));
    for (const c of cands) if (this.visible(c.at, camera)) return c.hit;
    return null;
  }

  /** nothing (a building being edited, or one of the map) stands between the camera and this point */
  visible(p: THREE.Vector3, camera: THREE.Camera): boolean {
    const origin = camera.getWorldPosition(new THREE.Vector3());
    const dist = origin.distanceTo(p);
    if (dist < 1e-6) return true;
    const ray = new THREE.Ray(origin, p.clone().sub(origin).normalize());
    const near = dist - Math.max(0.05, dist * 0.002);
    this.raycaster.ray.copy(ray);
    this.raycaster.far = near;
    try {
      for (const v of this.views.values()) {
        if (!v.solid) continue;
        v.root.updateMatrixWorld(true);
        if (this.raycaster.intersectObject(v.solid, false).length) return false;
      }
    } finally {
      this.raycaster.far = Infinity;
    }
    const t = this.tm.pick(ray);
    return !t || t.distance >= near;
  }

  /** elements inside a screen rectangle (vertices: the point, edges: both ends, faces: the center) */
  boxElements(mode: "vertex" | "edge" | "face", ids: Iterable<string>, rect: { x0: number; y0: number; x1: number; y1: number }, camera: THREE.Camera, w: number, h: number) {
    const inside = (p: [number, number, number] | null) => !!p && p[0] >= rect.x0 && p[0] <= rect.x1 && p[1] >= rect.y0 && p[1] <= rect.y1;
    const out = new Map<string, (number | string)[]>();
    for (const id of ids) {
      const v = this.views.get(id);
      if (!v || v.draft.deleted) continue;
      const mesh = v.draft.mesh;
      const pts = Array.from({ length: mesh.verts.length / 3 }, (_, i) => this.screen(v, i, camera, w, h));
      const found: (number | string)[] = [];
      const world = (i: number) => new THREE.Vector3().fromArray(v.display, 3 * i).applyMatrix4(v.root.matrix);
      // as without X-ray in Blender: what a surface hides is not selected
      if (mode === "vertex") pts.forEach((p, i) => inside(p) && this.visible(world(i), camera) && found.push(i));
      else if (mode === "edge")
        for (const [a, b] of meshEdges(mesh)) inside(pts[a]) && inside(pts[b]) && this.visible(world(a).lerp(world(b), 0.5), camera) && found.push(edgeKey(a, b));
      else {
        const eye = camera.getWorldPosition(new THREE.Vector3());
        mesh.faces.forEach((f, i) => {
          if (f.length < 3) return; // a loose edge
          let sx = 0, sy = 0, sd = 0, ok = true;
          for (const k of f) {
            const p = pts[k];
            if (!p) ok = false;
            else {
              sx += p[0];
              sy += p[1];
              sd += p[2];
            }
          }
          if (!ok || !inside([sx / f.length, sy / f.length, sd / f.length])) return;
          // facing the camera, its middle not hidden
          const c = new THREE.Vector3();
          const nrm = new THREE.Vector3();
          const ws = f.map(world);
          ws.forEach((p, k) => {
            c.add(p);
            const q = ws[(k + 1) % ws.length];
            nrm.x += (p.y - q.y) * (p.z + q.z);
            nrm.y += (p.z - q.z) * (p.x + q.x);
            nrm.z += (p.x - q.x) * (p.y + q.y);
          });
          c.divideScalar(ws.length);
          nrm.normalize();
          if (nrm.dot(eye.clone().sub(c)) <= 0) return;
          if (this.visible(c.addScaledVector(nrm, 0.05), camera)) found.push(i);
        });
      }
      out.set(id, found);
    }
    return out;
  }

  /** drafts whose center is inside a screen rectangle */
  boxDrafts(rect: { x0: number; y0: number; x1: number; y1: number }, camera: THREE.Camera, w: number, h: number): string[] {
    const out: string[] = [];
    for (const [id, v] of this.views) {
      if (!v.solid) continue;
      v.solid.geometry.boundingBox!.getCenter(_v).applyMatrix4(v.root.matrix);
      const depth = _w.copy(_v).applyMatrix4(camera.matrixWorldInverse).z;
      if (depth > -0.1) continue;
      _v.project(camera);
      const x = ((_v.x + 1) / 2) * w;
      const y = ((1 - _v.y) / 2) * h;
      if (x >= rect.x0 && x <= rect.x1 && y >= rect.y0 && y <= rect.y1) out.push(id);
    }
    return out;
  }

  /** the scene bounding sphere of some drafts (frame selected) */
  bounds(ids: Iterable<string>): THREE.Sphere | null {
    const box = new THREE.Box3();
    for (const id of ids) {
      const v = this.views.get(id);
      if (!v) continue;
      for (let i = 0; i < v.display.length; i += 3) box.expandByPoint(_v.fromArray(v.display, i).applyMatrix4(v.root.matrix));
    }
    return box.isEmpty() ? null : box.getBoundingSphere(new THREE.Sphere());
  }
}
