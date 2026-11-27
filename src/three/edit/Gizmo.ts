// The transform handles of Edit mode, at the pivot of the selection and the same size on screen at any
// distance: arrows along X (east), Y (north) and Z (up) for Move, rings around them for Rotate, cubes for
// Scale. Picked in screen space; dragging one runs the matching constrained transform (EditInput.tsx).

import * as THREE from "three";
import type { Axis } from "@/edit/transform";

export type GizmoKind = "move" | "rotate" | "scale";
export type GizmoHit = { kind: GizmoKind; axis: Axis | null };

const COLORS: Record<Axis, string> = { x: "#ef4444", y: "#22c55e", z: "#3b82f6" };
/** scene direction of a UI axis (scene x = east, z = south) */
const SCENE_DIR: Record<Axis, THREE.Vector3> = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 0, -1), z: new THREE.Vector3(0, 1, 0) };
/** size on screen: this fraction of the distance to the camera */
const SIZE = 0.16;
const RING_SEGMENTS = 64;

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();

export class Gizmo {
  readonly group = new THREE.Group();
  private kind: GizmoKind | null = null;
  private parts: Partial<Record<Axis, THREE.Object3D>> = {};
  private center: THREE.Object3D | null = null;
  private highlight: GizmoHit | null = null;
  /** world length of one gizmo unit (updated per frame) */
  private unit = 1;

  constructor() {
    this.group.name = "edit-gizmo";
    this.group.visible = false;
    this.group.renderOrder = 10;
  }

  private material(color: string) {
    return new THREE.MeshBasicMaterial({ color, depthTest: false, depthWrite: false, transparent: true, opacity: 0.95 });
  }

  private build(kind: GizmoKind) {
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      (m.material as THREE.Material | undefined)?.dispose?.();
    });
    this.group.clear();
    this.parts = {};
    this.center = null;
    for (const axis of ["x", "y", "z"] as Axis[]) {
      const dir = SCENE_DIR[axis];
      const part = new THREE.Group();
      const mat = this.material(COLORS[axis]);
      if (kind === "rotate") {
        const ring = new THREE.Mesh(new THREE.TorusGeometry(1, 0.025, 6, RING_SEGMENTS), mat);
        // torus lies in its xy plane (normal z): turn the normal onto the axis
        ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
        part.add(ring);
      } else {
        const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.85, 6), mat);
        shaft.position.copy(dir).multiplyScalar(0.425);
        shaft.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
        const tip = kind === "move" ? new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.22, 12), mat) : new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.14, 0.14), mat);
        tip.position.copy(dir).multiplyScalar(0.95);
        tip.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
        part.add(shaft, tip);
      }
      part.traverse((o) => (o.renderOrder = 10));
      this.parts[axis] = part;
      this.group.add(part);
    }
    // the middle: free move on the ground plane / uniform scale
    if (kind !== "rotate") {
      const c = new THREE.Mesh(kind === "move" ? new THREE.SphereGeometry(0.07, 12, 8) : new THREE.BoxGeometry(0.12, 0.12, 0.12), this.material("#f5f5f5"));
      c.renderOrder = 10;
      this.center = c;
      this.group.add(c);
    }
    this.kind = kind;
  }

  /** where and which handles to show (null: hidden) */
  set(kind: GizmoKind | null, at: THREE.Vector3 | null, camera: THREE.Camera) {
    if (!kind || !at) {
      this.group.visible = false;
      return;
    }
    if (kind !== this.kind) this.build(kind);
    this.group.visible = true;
    this.group.position.copy(at);
    this.unit = camera.position.distanceTo(at) * SIZE;
    this.group.scale.setScalar(this.unit);
    this.group.updateMatrixWorld(true);
  }

  setHighlight(hit: GizmoHit | null) {
    if (hit?.axis === this.highlight?.axis && hit?.kind === this.highlight?.kind) return false;
    this.highlight = hit;
    for (const axis of ["x", "y", "z"] as Axis[]) {
      this.parts[axis]?.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.MeshBasicMaterial | undefined;
        if (m) m.color.set(hit?.axis === axis ? "#facc15" : COLORS[axis]);
      });
    }
    const cm = (this.center as THREE.Mesh | null)?.material as THREE.MeshBasicMaterial | undefined;
    if (cm) cm.color.set(hit && hit.axis === null ? "#facc15" : "#f5f5f5");
    return true;
  }

  get visible() {
    return this.group.visible;
  }

  /** the handle under a screen point (px), if any */
  pick(x: number, y: number, camera: THREE.Camera, w: number, h: number): GizmoHit | null {
    if (!this.group.visible || !this.kind) return null;
    const o = this.group.position;
    const toScreen = (p: THREE.Vector3) => {
      const q = _b.copy(p).project(camera);
      return [((q.x + 1) / 2) * w, ((1 - q.y) / 2) * h] as const;
    };
    const [cx, cy] = toScreen(o);
    if (this.center && Math.hypot(cx - x, cy - y) < 10) return { kind: this.kind, axis: null };
    let best: { axis: Axis; d: number } | null = null;
    for (const axis of ["x", "y", "z"] as Axis[]) {
      let d = Infinity;
      if (this.kind === "rotate") {
        // distance to the ring drawn on screen (a polyline around it)
        const dir = SCENE_DIR[axis];
        const u = new THREE.Vector3().crossVectors(dir, Math.abs(dir.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0)).normalize();
        const v = new THREE.Vector3().crossVectors(dir, u);
        let prev: readonly [number, number] | null = null;
        for (let i = 0; i <= RING_SEGMENTS; i++) {
          const t = (i / RING_SEGMENTS) * Math.PI * 2;
          _a.copy(o).addScaledVector(u, Math.cos(t) * this.unit).addScaledVector(v, Math.sin(t) * this.unit);
          const p = toScreen(_a);
          if (prev) d = Math.min(d, segmentDistance(x, y, prev, p));
          prev = p;
        }
      } else {
        const tip = toScreen(_a.copy(o).addScaledVector(SCENE_DIR[axis], this.unit));
        d = segmentDistance(x, y, [cx, cy], tip);
      }
      if (d < 9 && (!best || d < best.d)) best = { axis, d };
    }
    return best ? { kind: this.kind, axis: best.axis } : null;
  }
}

function segmentDistance(x: number, y: number, p: readonly [number, number], q: readonly [number, number]) {
  const dx = q[0] - p[0];
  const dy = q[1] - p[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((x - p[0]) * dx + (y - p[1]) * dy) / l2)) : 0;
  return Math.hypot(p[0] + t * dx - x, p[1] + t * dy - y);
}
