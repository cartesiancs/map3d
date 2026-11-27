// Modal transforms of Edit mode, as in Blender: G (move), R (rotate), S (scale) and Height follow the mouse
// until confirmed (click / Enter) or cancelled (right click / Esc). X / Y / Z lock an axis (Shift: the plane
// across it), typing a number sets the amount, Ctrl moves in steps (1 m, 15°, 0.1, 0.5 m). Started from the
// keyboard or by dragging a gizmo handle / the selection (then releasing the button confirms).
// The math runs in meters around one reference anchor (src/edit/transform.ts).

import * as THREE from "three";
import type { LngLat } from "@/contrib/validate";
import type { Draft } from "@/edit/drafts";
import { Axis, Vec3, add, anchorOffset, axisDir, centroidOf, mapVerts, originOf, rotateAbout, scaleAbout, sub } from "@/edit/transform";
import { useEditStore } from "@/state/editStore";
import type { TileManager } from "../tiles/TileManager";
import type { EditLayer } from "./EditLayer";
import { frameMatrix } from "./solids";
import { SnapExclude, findSnap } from "./snapping";

export type ModalKind = "move" | "rotate" | "scale" | "height";

type Target = { id: string; start: Draft; verts: number[] | null; offset: Vec3; origin: Vec3; height: number };

const STEP = { move: 1, rotate: (15 * Math.PI) / 180, scale: 0.1, height: 0.5 };
const NAMES: Record<ModalKind, string> = { move: "Move", rotate: "Rotate", scale: "Scale", height: "Height" };

const _ray = new THREE.Raycaster();
const _ndc = new THREE.Vector2();
const _o = new THREE.Vector3();
const _d = new THREE.Vector3();

export class ModalTransform {
  axis: Axis | null;
  plane = false;
  numeric = "";
  private targets: Target[];
  private ref: LngLat;
  private toScene = new THREE.Matrix4();
  private toLocal = new THREE.Matrix4();
  private linear = new THREE.Matrix3();
  private pivot: Vec3;
  private pivotScene: THREE.Vector3;
  private mouse0: [number, number];
  private hit0: Vec3 | null = null;
  private lineParam0 = 0;
  private last: [number, number];
  private ctrl = false;
  private fine = false;
  private value = 0;

  constructor(
    readonly kind: ModalKind,
    private tm: TileManager,
    private camera: THREE.Camera,
    private size: { w: number; h: number },
    mouse: [number, number],
    /** the selection's pivot as drawn (scene) */
    pivotScene: THREE.Vector3,
    private layer: EditLayer,
    /** `continued`: part of a modal operation already begun (extrude / duplicate, then move: one undo step) */
    opts: { axis?: Axis | null; plane?: boolean; drag?: boolean; dir?: Vec3 | null; continued?: boolean } = {},
  ) {
    this.dir = opts.dir ?? null;
    const s = useEditStore.getState();
    this.axis = opts.axis ?? (kind === "height" ? "z" : null);
    this.plane = opts.plane ?? false;
    this.drag = opts.drag ?? false;
    const elementMode = s.mode !== "object";
    const ids = [...s.objects].filter((id) => s.drafts.has(id) && !s.drafts.get(id)!.deleted);
    this.ref = s.drafts.get(s.activeId ?? ids[0])?.mesh.anchor ?? s.drafts.get(ids[0])!.mesh.anchor;
    frameMatrix(tm.origin, this.ref, this.toScene);
    this.toLocal.copy(this.toScene).invert();
    this.linear.setFromMatrix4(this.toLocal);
    this.targets = ids.flatMap((id) => {
      const d = s.drafts.get(id)!;
      const verts = elementMode ? [...(s.elems.get(id)?.verts ?? [])] : null;
      if (verts && !verts.length) return [];
      const offset = anchorOffset(this.ref, d.mesh.anchor);
      let h = 0;
      for (let i = 1; i < d.mesh.verts.length; i += 3) h = Math.max(h, d.mesh.verts[i]);
      return [{ id, start: d, verts, offset, origin: add(originOf(d.mesh), offset), height: h }];
    });
    // pivot: the selected vertices' middle, or the buildings' origins' middle
    let sum: Vec3 = [0, 0, 0];
    let n = 0;
    for (const t of this.targets) {
      const c = t.verts ? centroidOf(t.start.mesh, t.verts) : sub(t.origin, t.offset);
      if (!c) continue;
      sum = add(sum, add(c, t.offset));
      n++;
    }
    this.pivot = n ? [sum[0] / n, sum[1] / n, sum[2] / n] : [0, 0, 0];
    this.pivotScene = pivotScene.clone();
    // the moving vertices for snapping: where they stand (reference meters) and their height above ground
    this.snapExclude = { drafts: new Set(), verts: new Map() };
    for (const t of this.targets) {
      const list = t.verts ?? Array.from({ length: t.start.mesh.verts.length / 3 }, (_, i) => i);
      if (!t.verts) this.snapExclude.drafts.add(t.id);
      else this.snapExclude.verts.set(t.id, new Set(t.verts));
      const m = t.start.mesh.verts;
      for (const v of list.slice(0, 5000)) this.movingDrawn.push(new THREE.Vector3(m[3 * v] + t.offset[0], m[3 * v + 1], m[3 * v + 2] + t.offset[2]));
    }
    this.mouse0 = mouse;
    this.last = mouse;
    this.individual = !elementMode && s.pivot === "individual";
    if (!opts.continued) useEditStore.getState().beginModal();
    this.reset0();
  }

  readonly drag: boolean;
  private individual: boolean;
  /** a direction to move along until an axis is chosen (extrude: the normal) */
  private dir: Vec3 | null;
  private snapExclude: SnapExclude;
  private movingDrawn: THREE.Vector3[] = [];

  get empty() {
    return this.targets.length === 0;
  }

  /** the mouse ray in the reference meters (origin, direction) */
  private ray(x: number, y: number): [Vec3, Vec3] {
    _ndc.set((x / this.size.w) * 2 - 1, -(y / this.size.h) * 2 + 1);
    _ray.setFromCamera(_ndc, this.camera);
    _o.copy(_ray.ray.origin).applyMatrix4(this.toLocal);
    _d.copy(_ray.ray.direction).applyMatrix3(this.linear);
    return [
      [_o.x, _o.y, _o.z],
      [_d.x, _d.y, _d.z],
    ];
  }

  /** the pivot as drawn, in the reference meters (drawn y includes the ground) */
  private pivotDrawn(): Vec3 {
    const p = this.pivotScene.clone().applyMatrix4(this.toLocal);
    return [p.x, p.y, p.z];
  }

  /** where the mouse ray meets the plane through the pivot with this normal */
  private onPlane(x: number, y: number, normal: Vec3): Vec3 | null {
    const [o, d] = this.ray(x, y);
    const p = this.pivotDrawn();
    const den = d[0] * normal[0] + d[1] * normal[1] + d[2] * normal[2];
    if (Math.abs(den) < 1e-9) return null;
    const t = ((p[0] - o[0]) * normal[0] + (p[1] - o[1]) * normal[1] + (p[2] - o[2]) * normal[2]) / den;
    if (t < 0) return null;
    return [o[0] + t * d[0], o[1] + t * d[1], o[2] + t * d[2]];
  }

  /** parameter along the axis line through the pivot of the point nearest to the mouse ray */
  private onLine(x: number, y: number, axis: Axis | Vec3): number {
    const [o, d] = this.ray(x, y);
    const p = this.pivotDrawn();
    const u = typeof axis === "string" ? axisDir(axis) : axis;
    const w0 = sub(p, o);
    const a = 1;
    const b = u[0] * d[0] + u[1] * d[1] + u[2] * d[2];
    const c = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
    const dd = u[0] * w0[0] + u[1] * w0[1] + u[2] * w0[2];
    const e = d[0] * w0[0] + d[1] * w0[1] + d[2] * w0[2];
    const den = a * c - b * b;
    return Math.abs(den) < 1e-9 ? 0 : (b * e - c * dd) / den;
  }

  private planeNormal(): Vec3 {
    if (this.axis && this.plane) return axisDir(this.axis);
    return [0, 1, 0]; // free move: on the ground plane
  }

  /** start values for the current constraint */
  private reset0() {
    const [x, y] = this.mouse0;
    if (this.kind === "move" || this.kind === "height") {
      if (this.axis && !this.plane) this.lineParam0 = this.onLine(x, y, this.axis);
      else if (this.dir && !this.axis) this.lineParam0 = this.onLine(x, y, this.dir);
      else this.hit0 = this.onPlane(x, y, this.planeNormal());
    }
  }

  private screenPivot(): [number, number] {
    const q = this.pivotScene.clone().project(this.camera);
    return [((q.x + 1) / 2) * this.size.w, ((1 - q.y) / 2) * this.size.h];
  }

  move(x: number, y: number, ctrl: boolean, shift: boolean) {
    this.last = [x, y];
    this.ctrl = ctrl;
    this.fine = shift;
    this.apply();
  }

  /** a key while the transform runs: true when it was used */
  key(e: KeyboardEvent): boolean {
    const k = e.key.toLowerCase();
    if (k === "x" || k === "y" || k === "z") {
      const plane = e.shiftKey;
      if (this.kind === "height") return true;
      if (this.axis === k && this.plane === plane) this.axis = null;
      else {
        this.axis = k as Axis;
        this.plane = plane;
      }
      this.reset0();
      this.apply();
      return true;
    }
    if (/^[0-9]$/.test(e.key) || e.key === "." || e.key === "-" || e.key === "Backspace") {
      if (e.key === "Backspace") this.numeric = this.numeric.slice(0, -1);
      else if (e.key === "-") this.numeric = this.numeric.startsWith("-") ? this.numeric.slice(1) : `-${this.numeric}`;
      else this.numeric += e.key;
      this.apply();
      return true;
    }
    if (e.key === "Control" || e.key === "Meta" || e.key === "Shift") {
      this.ctrl = e.ctrlKey || e.metaKey;
      this.fine = e.shiftKey;
      this.apply();
      return true;
    }
    return false;
  }

  private typed(): number | null {
    if (!this.numeric || this.numeric === "-" || this.numeric === ".") return null;
    const v = Number(this.numeric);
    return Number.isFinite(v) ? v : null;
  }

  private snapStep(v: number, step: number) {
    if (!this.ctrl) return v;
    const s = this.fine ? step / 10 : step;
    return Math.round(v / s) * s;
  }

  private apply() {
    const [x, y] = this.last;
    const typed = this.typed();
    const s = useEditStore.getState();
    const drafts = new Map(s.drafts);
    let f: (t: Target) => (p: Vec3) => Vec3;

    if (this.kind === "move") {
      let delta: Vec3 = [0, 0, 0];
      if (typed !== null) delta = (this.axis ? axisDir(this.axis) : this.dir ?? axisDir("x")).map((c) => c * typed) as Vec3;
      else if (this.dir && !this.axis) {
        const t = this.snapStep(this.onLine(x, y, this.dir) - this.lineParam0, STEP.move);
        delta = this.dir.map((c) => c * t) as Vec3;
      } else if (this.axis && !this.plane) {
        const t = this.snapStep(this.onLine(x, y, this.axis) - this.lineParam0, STEP.move);
        delta = axisDir(this.axis).map((c) => c * t) as Vec3;
      } else {
        const hit = this.onPlane(x, y, this.planeNormal());
        if (hit && this.hit0) delta = sub(hit, this.hit0).map((c) => this.snapStep(c, STEP.move)) as Vec3;
      }
      if (typed === null && s.snap && !this.ctrl) delta = this.snapped(x, y, delta);
      else this.layer.setSnapMarker(null);
      this.value = Math.hypot(...delta);
      f = () => (p) => add(p, delta);
      s.setHint(`${NAMES.move}${this.axis ? ` · ${this.axis.toUpperCase()}${this.plane ? " plane" : ""}` : ""} · ${this.fmt(delta)}`);
    } else if (this.kind === "rotate") {
      const axis = this.axis ?? "z";
      let angle: number;
      if (typed !== null) angle = (typed * Math.PI) / 180;
      else {
        const [px, py] = this.screenPivot();
        const a0 = Math.atan2(py - this.mouse0[1], this.mouse0[0] - px);
        const a1 = Math.atan2(py - y, x - px);
        // counter-clockwise on screen is a positive turn when the axis points at the camera
        const forward = new THREE.Vector3();
        this.camera.getWorldDirection(forward);
        const dir = axis === "x" ? new THREE.Vector3(1, 0, 0) : axis === "y" ? new THREE.Vector3(0, 0, -1) : new THREE.Vector3(0, 1, 0);
        const sign = dir.dot(forward) < 0 ? 1 : -1;
        angle = this.snapStep(sign * (a1 - a0), STEP.rotate);
      }
      this.value = angle;
      f = (t) => (p) => rotateAbout(p, this.individual ? t.origin : this.pivot, axis, angle);
      s.setHint(`${NAMES.rotate} · ${axis.toUpperCase()} · ${((angle * 180) / Math.PI).toFixed(1)}°`);
    } else if (this.kind === "scale") {
      let k: number;
      if (typed !== null) k = typed;
      else {
        const [px, py] = this.screenPivot();
        const d0 = Math.hypot(this.mouse0[0] - px, this.mouse0[1] - py);
        const d1 = Math.hypot(x - px, y - py);
        k = d0 > 5 ? d1 / d0 : 1 + (x - this.mouse0[0]) / 100;
        k = this.snapStep(k, STEP.scale);
      }
      this.value = k;
      f = (t) => (p) => scaleAbout(p, this.individual ? t.origin : this.pivot, k, this.axis, this.plane);
      s.setHint(`${NAMES.scale}${this.axis ? ` · ${this.axis.toUpperCase()}${this.plane ? " plane" : ""}` : ""} · ${k.toFixed(3)}`);
    } else {
      // height: the top follows the mouse up and down; each building scales up from its ground
      const dh = typed !== null ? null : this.snapStep(this.onLine(x, y, "z") - this.lineParam0, STEP.height);
      f = (t) => {
        const target = typed !== null ? typed : Math.max(0.5, t.height + dh!);
        const k = t.height > 0 ? target / t.height : 1;
        return (p) => [p[0], p[1] * k, p[2]];
      };
      const first = this.targets[0];
      const h = first ? (typed !== null ? typed : Math.max(0.5, first.height + dh!)) : 0;
      this.value = h;
      s.setHint(`${NAMES.height} · ${h.toFixed(1)} m`);
    }

    for (const t of this.targets) {
      const g = f(t);
      const mesh = mapVerts(t.start.mesh, t.verts, (p) => sub(g(add(p, t.offset)), t.offset));
      drafts.set(t.id, { ...t.start, mesh });
    }
    s.previewModal({ drafts });
  }

  /**
   * Snapping: the target under the mouse; the moving vertex closest to it (where the move would put it)
   * lands on it, within the axis / plane the move is locked to.
   */
  private snapped(x: number, y: number, delta: Vec3): Vec3 {
    _ndc.set((x / this.size.w) * 2 - 1, -(y / this.size.h) * 2 + 1);
    _ray.setFromCamera(_ndc, this.camera);
    const targets = new Set(useEditStore.getState().snapTo);
    const hit = findSnap(this.tm, this.layer, _ray.ray, { camera: this.camera, w: this.size.w, h: this.size.h, x, y }, targets, this.snapExclude);
    if (!hit || !this.movingDrawn.length) {
      this.layer.setSnapMarker(null);
      return delta;
    }
    // in place seen from above, and at the target's height above its own ground
    const goal = hit.point.clone().applyMatrix4(this.toLocal);
    goal.y = hit.height;
    let best: THREE.Vector3 | null = null;
    let bestD = Infinity;
    const moved = new THREE.Vector3();
    for (const p of this.movingDrawn) {
      const d = moved.set(p.x + delta[0], p.y + delta[1], p.z + delta[2]).distanceToSquared(goal);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    let d: Vec3 = [goal.x - best!.x, goal.y - best!.y, goal.z - best!.z];
    const along = this.axis && !this.plane ? axisDir(this.axis) : !this.axis && this.dir ? this.dir : null;
    if (along) {
      const k = d[0] * along[0] + d[1] * along[1] + d[2] * along[2];
      d = [along[0] * k, along[1] * k, along[2] * k];
    } else if (this.axis && this.plane) {
      const n = axisDir(this.axis);
      const k = d[0] * n[0] + d[1] * n[1] + d[2] * n[2];
      d = [d[0] - n[0] * k, d[1] - n[1] * k, d[2] - n[2] * k];
    }
    this.layer.setSnapMarker(hit.point, hit.kind);
    return d;
  }

  private fmt(d: Vec3) {
    // UI axes: X east, Y north, Z up
    const parts: string[] = [];
    if (Math.abs(d[0]) > 1e-6) parts.push(`X ${d[0].toFixed(2)}`);
    if (Math.abs(d[2]) > 1e-6) parts.push(`Y ${(-d[2]).toFixed(2)}`);
    if (Math.abs(d[1]) > 1e-6) parts.push(`Z ${d[1].toFixed(2)}`);
    return parts.length ? `${parts.join("  ")} m` : "0 m";
  }

  confirm() {
    this.layer.setSnapMarker(null);
    useEditStore.getState().endModal(true);
  }

  cancel() {
    this.layer.setSnapMarker(null);
    useEditStore.getState().endModal(false);
  }
}
