// Interactive mesh tools of Edit mode's element modes: Inset (I) and Bevel (Ctrl+B) follow the mouse for
// their width (typing a number sets it in meters, the wheel sets the bevel's segments), Loop cut (Ctrl+R)
// shows the cut under the mouse and makes it on click, Knife (K) collects points on edges and vertices and
// cuts on Enter. Left click / Enter confirms, right click / Esc cancels.

import * as THREE from "three";
import * as ops from "@/edit/ops";
import { KnifePoint, OpError } from "@/edit/ops";
import { ElemMode, edgeEnds, inMode } from "@/edit/select";
import { useAuthStore } from "@/state/authStore";
import { useEditStore } from "@/state/editStore";
import { editLayer } from "../Space";
import { H_UNIT_M } from "../tiles/geo";
import { selectionPivot } from "./EditInput";

export interface OperatorModal {
  done: boolean;
  move(x: number, y: number, e: PointerEvent): void;
  click(x: number, y: number, e: PointerEvent): void;
  key(e: KeyboardEvent): boolean;
  /** true when the wheel turn was used */
  wheel(dy: number): boolean;
  cancel(): void;
}

type Ctx = { camera: THREE.Camera; size: { w: number; h: number }; mouse: [number, number]; rayAt: (x: number, y: number) => THREE.Ray };

const notify = (text: string) => useAuthStore.getState().notify(text);

/** meters per screen pixel at a scene point (for widths that follow the mouse) */
function metersPerPixel(at: THREE.Vector3, camera: THREE.Camera, h: number) {
  const a = at.clone().project(camera);
  const b = at.clone().add(new THREE.Vector3(1, 0, 0)).project(camera);
  const px = Math.hypot(b.x - a.x, b.y - a.y) * (h / 2);
  return px > 0 ? H_UNIT_M / px : 0.05;
}

/** a width that follows the mouse's distance from where the tool started (Inset, Bevel) */
class WidthTool implements OperatorModal {
  done = false;
  private numeric = "";
  private segments = 1;
  private scale: number;
  private start: [number, number];

  constructor(
    private name: "Inset" | "Bevel",
    private ctx: Ctx,
    private run: (width: number, segments: number) => void,
  ) {
    const pivot = selectionPivot();
    if (!pivot) {
      notify("Select something first");
      this.done = true;
      this.scale = 0;
      this.start = ctx.mouse;
      return;
    }
    this.scale = metersPerPixel(pivot, ctx.camera, ctx.size.h);
    this.start = ctx.mouse;
    useEditStore.getState().beginModal();
    this.apply(ctx.mouse);
  }

  private width(x: number, y: number) {
    const typed = Number(this.numeric);
    if (this.numeric && Number.isFinite(typed)) return Math.max(0, typed);
    return Math.max(0, Math.hypot(x - this.start[0], y - this.start[1]) * this.scale);
  }

  private last: [number, number] = [0, 0];
  private apply([x, y]: [number, number]) {
    this.last = [x, y];
    const w = this.width(x, y);
    try {
      this.run(w, this.segments);
      useEditStore.getState().setHint(`${this.name} · ${w.toFixed(2)} m${this.name === "Bevel" ? ` · ${this.segments} segment${this.segments > 1 ? "s" : ""} (wheel)` : ""}`);
    } catch (err) {
      useEditStore.getState().endModal(false);
      notify(err instanceof OpError ? err.message : String(err));
      this.done = true;
    }
  }

  move(x: number, y: number) {
    if (!this.done) this.apply([x, y]);
  }
  click(_x: number, _y: number, e: PointerEvent) {
    if (e.button === 0) this.finish(true);
  }
  key(e: KeyboardEvent) {
    if (e.key === "Enter") return this.finish(true), true;
    if (/^[0-9.]$/.test(e.key) || e.key === "Backspace") {
      this.numeric = e.key === "Backspace" ? this.numeric.slice(0, -1) : this.numeric + e.key;
      this.apply(this.last);
      return true;
    }
    return false;
  }
  wheel(dy: number) {
    if (this.name !== "Bevel") return false;
    this.segments = Math.max(1, Math.min(4, this.segments + (dy < 0 ? 1 : -1)));
    this.apply(this.last);
    return true;
  }
  cancel() {
    this.finish(false);
  }
  private finish(keep: boolean) {
    if (this.done) return;
    this.done = true;
    useEditStore.getState().endModal(keep);
  }
}

/**
 * An operation applied live during a modal, always to the selection as it was when the tool started (each
 * new width replaces the last preview, never builds on it).
 */
function liveOp<A extends unknown[]>(f: (input: ops.OpIn, ...args: A) => ops.OpOut) {
  const s = useEditStore.getState();
  const start = { drafts: new Map(s.drafts), elems: new Map(s.elems) };
  const mode = s.mode as ElemMode;
  return (...args: A) => {
    const drafts = new Map(start.drafts);
    const elems = new Map(start.elems);
    let any = false;
    for (const id of s.objects) {
      const d = start.drafts.get(id);
      const sel = start.elems.get(id);
      if (!d || !sel || d.deleted) continue;
      if (mode === "face" ? !sel.faces.size : mode === "edge" ? !sel.edges.size : !sel.verts.size) continue;
      const out = f({ mesh: d.mesh, sel, mode }, ...args);
      drafts.set(id, { ...d, mesh: out.mesh });
      elems.set(id, inMode(out.mesh, out.sel, mode));
      any = true;
    }
    if (!any) throw new OpError("Select something to work on first");
    useEditStore.getState().previewModal({ drafts, elems });
  };
}

/** Loop cut: hover an edge to see the cut around its ring, click to make it */
class LoopCutTool implements OperatorModal {
  done = false;
  private target: { id: string; edge: [number, number]; t: number } | null = null;

  constructor(private ctx: Ctx) {
    useEditStore.getState().setHint("Loop cut · point at an edge, click to cut");
    this.move(...ctx.mouse);
  }

  move(x: number, y: number) {
    const s = useEditStore.getState();
    const { w, h } = this.ctx.size;
    const hit = editLayer.pickNear("edge", s.objects, x, y, this.ctx.camera, w, h, 16);
    if (!hit) {
      this.target = null;
      editLayer.setGuide(null);
      return;
    }
    const [a, b] = edgeEnds(hit.element as string);
    const t = editLayer.edgeParam(hit.id, a, b, x, y, this.ctx.camera, w, h);
    this.target = { id: hit.id, edge: [a, b], t };
    // the cut: a point on each edge of the ring, joined across each face
    const d = s.drafts.get(hit.id)!;
    const ring = ops.edgeRing(d.mesh, [a, b]);
    const pts = ring.edges.map(([p, q]) => {
      const P = editLayer.displayPoint(hit.id, p)!;
      const Q = editLayer.displayPoint(hit.id, q)!;
      return P.lerp(Q, t);
    });
    const pairs: THREE.Vector3[] = [];
    for (let i = 0; i + 1 < pts.length; i++) pairs.push(pts[i], pts[i + 1]);
    if (ring.closed && pts.length > 2) pairs.push(pts[pts.length - 1], pts[0]);
    editLayer.setGuide(pairs, "pairs");
  }

  click(_x: number, _y: number, e: PointerEvent) {
    if (e.button !== 0) return;
    const tg = this.target;
    if (!tg) return;
    const s = useEditStore.getState();
    const d = s.drafts.get(tg.id);
    if (!d) return this.cancel();
    try {
      const out = ops.loopCut({ mesh: d.mesh, sel: s.elems.get(tg.id)!, mode: "edge" }, tg.edge, tg.t);
      // to edge mode first (it converts the selections there), then the cut loop selected
      if (s.mode !== "edge") s.setMode("edge");
      const now = useEditStore.getState();
      const drafts = new Map(now.drafts);
      drafts.set(tg.id, { ...d, mesh: out.mesh });
      const elems = new Map(now.elems);
      elems.set(tg.id, out.sel);
      now.commit({ drafts, elems });
    } catch (err) {
      notify(err instanceof OpError ? err.message : String(err));
    }
    this.cancel();
  }
  key() {
    return false;
  }
  wheel() {
    return false;
  }
  cancel() {
    this.done = true;
    editLayer.setGuide(null);
    useEditStore.getState().setHint(null);
  }
}

/** Knife: click points on edges and vertices, and inside faces between them; Enter cuts */
class KnifeTool implements OperatorModal {
  done = false;
  private id: string | null = null;
  private path: KnifePoint[] = [];
  private shown: THREE.Vector3[] = [];

  constructor(private ctx: Ctx) {
    useEditStore.getState().setHint("Knife · click on edges, vertices or inside a face, Enter to cut");
  }

  /** the knife point under the mouse: a vertex nearby, else a point on the nearest edge, else inside the face */
  private at(x: number, y: number): { id: string; point: KnifePoint; p: THREE.Vector3 } | null {
    const s = useEditStore.getState();
    const { w, h } = this.ctx.size;
    const ids = this.id ? [this.id] : s.objects;
    const v = editLayer.pickNear("vertex", ids, x, y, this.ctx.camera, w, h, 8);
    if (v) return { id: v.id, point: { vertex: v.element as number }, p: editLayer.displayPoint(v.id, v.element as number)! };
    const e = editLayer.pickNear("edge", ids, x, y, this.ctx.camera, w, h, 12);
    if (!e) {
      const allowed = new Set(ids);
      const f = editLayer.pickSurface(this.ctx.rayAt(x, y), (id) => allowed.has(id));
      return f ? { id: f.id, point: { inside: f.local }, p: f.point } : null;
    }
    const [a, b] = edgeEnds(e.element as string);
    const t = editLayer.edgeParam(e.id, a, b, x, y, this.ctx.camera, w, h);
    const p = editLayer.displayPoint(e.id, a)!.lerp(editLayer.displayPoint(e.id, b)!, t);
    return { id: e.id, point: { a, b, t }, p };
  }

  move(x: number, y: number) {
    const hit = this.at(x, y);
    editLayer.setGuide(hit ? [...this.shown, hit.p] : this.shown.length ? this.shown : null);
  }
  click(x: number, y: number, e: PointerEvent) {
    if (e.button !== 0) return;
    const hit = this.at(x, y);
    if (!hit) return;
    this.id ??= hit.id;
    this.path.push(hit.point);
    this.shown.push(hit.p);
    editLayer.setGuide(this.shown);
  }
  key(e: KeyboardEvent) {
    if (e.key !== "Enter") return false;
    const s = useEditStore.getState();
    const d = this.id ? s.drafts.get(this.id) : null;
    if (d && this.path.length >= 2) {
      try {
        const out = ops.knife({ mesh: d.mesh, sel: s.elems.get(d.id)!, mode: "vertex" }, this.path);
        // to vertex mode first (it converts the selections there), then the new vertices selected
        if (s.mode !== "vertex") s.setMode("vertex");
        const now = useEditStore.getState();
        const drafts = new Map(now.drafts);
        drafts.set(d.id, { ...d, mesh: out.mesh });
        const elems = new Map(now.elems);
        elems.set(d.id, out.sel);
        now.commit({ drafts, elems });
      } catch (err) {
        notify(err instanceof OpError ? err.message : String(err));
      }
    }
    this.cancel();
    return true;
  }
  wheel() {
    return false;
  }
  cancel() {
    this.done = true;
    editLayer.setGuide(null);
    useEditStore.getState().setHint(null);
  }
}

export function interactiveTool(name: "inset" | "bevel" | "loopcut" | "knife", ctx: Ctx): OperatorModal | null {
  const s = useEditStore.getState();
  if (s.mode === "object") {
    notify("Switch to vertex, edge or face mode (Tab) first");
    return null;
  }
  if (name === "loopcut") return new LoopCutTool(ctx);
  if (name === "knife") return new KnifeTool(ctx);
  if (name === "inset") {
    if (s.mode !== "face") {
      notify("Inset works on faces: switch to face mode (3)");
      return null;
    }
    const op = liveOp((i, width: number) => ops.insetFaces(i, width));
    return new WidthTool("Inset", ctx, (width) => op(width));
  }
  if (s.mode !== "edge") {
    notify("Bevel works on edges: switch to edge mode (2)");
    return null;
  }
  const op = liveOp((i, width: number, segments: number) => ops.bevelEdges(i, width, segments));
  return new WidthTool("Bevel", ctx, (width, segments) => op(width, segments));
}
