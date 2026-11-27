// Mouse and keys of Edit mode (map-style mouse, Blender keys). Pointer presses are taken before the map
// controls see them when they hit a gizmo handle or the selection, or start a box selection (Shift-drag,
// B); otherwise the map pans and rotates as always, and a press that did not move is a click (select).
// A short right click opens the edit menu.

import { useEffect } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { toLocal } from "@/contrib/mesh";
import { Draft, newDraftId } from "@/edit/drafts";
import * as ops from "@/edit/ops";
import { OpError, OpOut } from "@/edit/ops";
import { ElemMode, ElemSel, emptySelection, inMode, pickInto, settle } from "@/edit/select";
import { extrudeFootprint } from "@/edit/transform";
import { useAuthStore } from "@/state/authStore";
import { useContribStore } from "@/state/contribStore";
import { Mode, useEditStore } from "@/state/editStore";
import { useViewStore } from "@/state/viewStore";
import { editLayer, gizmo, tileManager } from "../Space";
import type { BuildingTileData } from "../tiles/buildTile";
import { fromScene } from "../tiles/geo";
import { ModalKind, ModalTransform } from "./modal";
import { OperatorModal, interactiveTool } from "./tools";

const notify = (text: string) => useAuthStore.getState().notify(text);
const elemMode = (m: Mode): ElemMode | null => (m === "object" ? null : m);

/**
 * run a mesh operation on every building being edited: one undo step, or (`preview`) a live change inside a
 * modal operation already begun (extrude then move: one step together, as in Blender)
 */
export function runOp(label: string, f: (d: Draft, sel: ElemSel, mode: ElemMode) => OpOut | null, opts: { preview?: boolean } = {}): boolean {
  const s = useEditStore.getState();
  const mode = elemMode(s.mode);
  if (!mode) return false;
  const drafts = new Map(s.drafts);
  const elems = new Map(s.elems);
  let changed = false;
  try {
    for (const id of s.objects) {
      const d = s.drafts.get(id);
      const sel = s.elems.get(id);
      if (!d || !sel || d.deleted) continue;
      const empty = mode === "vertex" ? !sel.verts.size : mode === "edge" ? !sel.edges.size : !sel.faces.size;
      if (empty) continue;
      const out = f(d, sel, mode);
      if (!out) continue;
      drafts.set(id, { ...d, mesh: out.mesh });
      elems.set(id, inMode(out.mesh, out.sel, mode));
      changed = true;
    }
  } catch (err) {
    notify(err instanceof OpError ? err.message : `${label}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
  if (!changed) {
    notify("Select something to work on first");
    return false;
  }
  if (opts.preview) s.previewModal({ drafts, elems });
  else s.commit({ drafts, elems });
  return true;
}

/** the selection's middle as drawn (scene), for the gizmo and modal transforms */
export function selectionPivot(): THREE.Vector3 | null {
  const s = useEditStore.getState();
  // an operation may have just changed the meshes (extrude, then move): draw them first
  editLayer.update(s);
  const sum = new THREE.Vector3();
  let n = 0;
  const p = new THREE.Vector3();
  for (const id of s.objects) {
    const d = s.drafts.get(id);
    if (!d || d.deleted) continue;
    if (s.mode === "object") {
      // the building's middle (put on the ground below)
      const box = editLayer.bounds([id]);
      if (!box) continue;
      sum.add(box.center);
      n++;
      continue;
    }
    for (const v of s.elems.get(id)?.verts ?? []) {
      if (editLayer.displayPoint(id, v, p)) {
        sum.add(p);
        n++;
      }
    }
  }
  if (!n) return null;
  sum.divideScalar(n);
  if (s.mode === "object") {
    // object pivots stand on the ground under the middle
    const g = tileManager.groundHeightAt(sum.x, sum.z) ?? 0;
    sum.y = g;
  }
  return sum;
}

type Press = {
  x: number;
  y: number;
  button: number;
  shift: boolean;
  /** what the press started on */
  on: "gizmo" | "selection" | "box" | "map";
  gizmo?: { kind: "move" | "rotate" | "scale"; axis: "x" | "y" | "z" | null };
  time: number;
};

let modal: ModalTransform | null = null;
let tool: OperatorModal | null = null;
let lastMouse: [number, number] = [0, 0];

export function EditInput() {
  const { gl, camera, invalidate } = useThree();
  const active = useEditStore((s) => s.active);

  useEffect(() => {
    if (!active) return;
    const el = gl.domElement;
    const parent = el.parentElement ?? el;
    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    let press: Press | null = null;
    let boxArmed = false;
    const rectEl = document.createElement("div");
    Object.assign(rectEl.style, { position: "absolute", border: "1px dashed #f97316", background: "rgba(249,115,22,.08)", pointerEvents: "none", display: "none", zIndex: "5" });
    parent.appendChild(rectEl);

    const local = (e: MouseEvent): [number, number] => {
      const r = el.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    };
    const size = () => ({ w: el.clientWidth, h: el.clientHeight });
    const rayAt = (x: number, y: number) => {
      const { w, h } = size();
      ndc.set((x / w) * 2 - 1, -(y / h) * 2 + 1);
      raycaster.setFromCamera(ndc, camera);
      return raycaster.ray.clone();
    };
    const stop = (e: Event) => {
      e.stopPropagation();
      e.preventDefault();
    };

    const startModal = (kind: ModalKind, at: [number, number], opts: ConstructorParameters<typeof ModalTransform>[7] = {}) => {
      const pivot = selectionPivot();
      if (!pivot) {
        notify("Select something first");
        return null;
      }
      const m = new ModalTransform(kind, tileManager, camera, size(), at, pivot, editLayer, opts);
      if (m.empty) {
        m.cancel();
        notify("Select something first");
        return null;
      }
      modal = m;
      m.move(at[0], at[1], false, false);
      invalidate();
      return m;
    };
    const endModal = (keep: boolean) => {
      if (!modal) return;
      if (keep) modal.confirm();
      else modal.cancel();
      modal = null;
      invalidate();
    };

    // ------------------------------------------------------------------------- selection
    const hitsSelection = (x: number, y: number) => {
      const s = useEditStore.getState();
      const { w, h } = size();
      const mode = elemMode(s.mode);
      if (!mode) {
        const hit = editLayer.pickDraft(rayAt(x, y));
        return !!hit && s.objects.has(hit.id);
      }
      if (mode === "face") {
        const hit = editLayer.pickFace(rayAt(x, y), s.objects);
        return !!hit && !!s.elems.get(hit.id)?.faces.has(hit.element as number);
      }
      const hit = editLayer.pickNear(mode, s.objects, x, y, camera, w, h);
      if (!hit) return false;
      const sel = s.elems.get(hit.id);
      return mode === "vertex" ? !!sel?.verts.has(hit.element as number) : !!sel?.edges.has(hit.element as string);
    };

    const click = (x: number, y: number, additive: boolean) => {
      const s = useEditStore.getState();
      const mode = elemMode(s.mode);
      const ray = rayAt(x, y);
      if (!mode) {
        const d = editLayer.pickDraft(ray);
        const t = tileManager.pick(ray);
        if (d && (!t || d.distance <= t.distance)) s.select([d.id], additive);
        else if (t) {
          const info = tileManager.describe(t.tile.key, t.index);
          if (info) void s.addBuilding(info.id, additive);
        } else if (!additive) s.deselectAll();
        return;
      }
      const { w, h } = size();
      const hit = mode === "face" ? editLayer.pickFace(ray, s.objects) : editLayer.pickNear(mode, s.objects, x, y, camera, w, h);
      if (!hit) {
        if (!additive) s.deselectAll();
        return;
      }
      const elems = new Map(additive ? s.elems : [...s.elems.keys()].map((k) => [k, emptySelection()] as const));
      const d = s.drafts.get(hit.id)!;
      elems.set(hit.id, pickInto(d.mesh, (additive ? s.elems.get(hit.id) : null) ?? emptySelection(), mode, hit.element, additive ? "toggle" : "replace"));
      s.setElems(elems);
    };

    const boxSelect = (r: { x0: number; y0: number; x1: number; y1: number }, additive: boolean) => {
      const s = useEditStore.getState();
      const { w, h } = size();
      const mode = elemMode(s.mode);
      if (!mode) {
        const ids = editLayer.boxDrafts(r, camera, w, h);
        // and map buildings in the box (read into the session)
        const add: number[] = [];
        const p = new THREE.Vector3();
        for (const t of tileManager.tiles.building.values()) {
          if (t.state !== "ready" || !t.object?.visible) continue;
          const d = t.data as BuildingTileData;
          for (let i = 0; i < d.ids.length; i++) {
            if (t.maskSaved?.has(i)) continue;
            const b = d.bounds;
            const base = t.bases ? t.bases[2 * i + 1] : 0;
            p.set((b[5 * i] + b[5 * i + 2]) / 2, base + b[5 * i + 4] / 2, (b[5 * i + 1] + b[5 * i + 3]) / 2).project(camera);
            if (p.z > 1) continue;
            const sx = ((p.x + 1) / 2) * w;
            const sy = ((1 - p.y) / 2) * h;
            if (sx >= r.x0 && sx <= r.x1 && sy >= r.y0 && sy <= r.y1) add.push(d.ids[i]);
          }
        }
        const limit = 50;
        if (add.length > limit) notify(`Only ${limit} buildings at a time`);
        s.select(ids, additive);
        for (const id of add.slice(0, limit)) void s.addBuilding(id, true);
        return;
      }
      const found = editLayer.boxElements(mode, s.objects, r, camera, w, h);
      const elems = new Map(s.elems);
      for (const [id, list] of found) {
        const d = s.drafts.get(id)!;
        const prev = additive ? s.elems.get(id) ?? emptySelection() : emptySelection();
        const next: ElemSel = { verts: new Set(prev.verts), edges: new Set(prev.edges), faces: new Set(prev.faces) };
        for (const e of list) (mode === "vertex" ? next.verts : mode === "edge" ? next.edges : next.faces).add(e as never);
        elems.set(id, settle(d.mesh, next, mode));
      }
      s.setElems(elems);
    };

    // ------------------------------------------------------------------------- footprint drawing (Add → Draw)
    const drawPoints: THREE.Vector3[] = [];
    const finishDraw = () => {
      const pts = drawPoints.splice(0);
      editLayer.setDrawPreview(null);
      if (pts.length < 3) return;
      const first = fromScene(tileManager.origin, pts[0].x, pts[0].z);
      const anchor: [number, number] = [Math.round(first.lng * 1e7) / 1e7, Math.round(first.lat * 1e7) / 1e7];
      // local meters of each point, counter-clockwise seen from above
      let ring = pts.map((p) => {
        const ll = fromScene(tileManager.origin, p.x, p.z);
        return toLocal(anchor, [ll.lng, ll.lat]);
      });
      let area = 0;
      for (let i = 0; i < ring.length; i++) {
        const [x1, z1] = ring[i];
        const [x2, z2] = ring[(i + 1) % ring.length];
        area += x1 * -z2 - x2 * -z1;
      }
      if (area < 0) ring = ring.reverse();
      const mesh = extrudeFootprint(anchor, ring, 10);
      useEditStore.getState().addDraft({ id: newDraftId(), ref: null, featureId: null, kind: "create", base: null, baseRev: "new", tags: {}, original: null, originalLevels: null, mesh, levels: null, deleted: false });
      useEditStore.getState().setTool("move");
    };
    const drawClick = (x: number, y: number) => {
      const p = tileManager.pickGround(rayAt(x, y));
      if (!p) return;
      if (drawPoints.length >= 3) {
        // clicking the first point again closes the footprint
        const q = drawPoints[0].clone().project(camera);
        const { w, h } = size();
        if (Math.hypot(((q.x + 1) / 2) * w - x, ((1 - q.y) / 2) * h - y) < 12) return finishDraw();
      }
      drawPoints.push(p);
      editLayer.setDrawPreview(drawPoints);
      invalidate();
    };

    // ------------------------------------------------------------------------- pointer
    const onDown = (e: PointerEvent) => {
      if (e.pointerType !== "mouse" && e.pointerType !== "pen") return;
      const [x, y] = local(e);
      lastMouse = [x, y];
      const s = useEditStore.getState();
      if (s.dialog) return;
      // a modal transform from the keyboard: left confirms, right cancels
      if (modal && !modal.drag) {
        stop(e);
        endModal(e.button === 0);
        return;
      }
      if (tool) {
        stop(e);
        if (e.button === 2) tool.cancel();
        else tool.click(x, y, e);
        if (tool?.done) tool = null;
        invalidate();
        return;
      }
      const mac = /Mac/.test(navigator.platform);
      const button = mac && e.button === 0 && e.ctrlKey ? 2 : e.button; // Ctrl+click on a Mac is a right click
      if (button === 2) {
        press = { x, y, button: 2, shift: e.shiftKey, on: "map", time: performance.now() };
        return; // the map rotates on a right drag
      }
      if (button !== 0) return;
      if (s.tool === "draw" && s.mode === "object") {
        stop(e);
        drawClick(x, y);
        return;
      }
      const { w, h } = size();
      // Shift is for selecting: the handles step aside (a Shift+click on what is under them toggles it)
      const g = e.shiftKey ? null : gizmo.pick(x, y, camera, w, h);
      if (g) {
        stop(e);
        el.setPointerCapture?.(e.pointerId);
        press = { x, y, button: 0, shift: e.shiftKey, on: "gizmo", gizmo: g, time: performance.now() };
        return;
      }
      if (e.shiftKey || boxArmed) {
        stop(e);
        el.setPointerCapture?.(e.pointerId);
        press = { x, y, button: 0, shift: e.shiftKey, on: "box", time: performance.now() };
        return;
      }
      if (hitsSelection(x, y)) {
        stop(e);
        el.setPointerCapture?.(e.pointerId);
        press = { x, y, button: 0, shift: false, on: "selection", time: performance.now() };
        return;
      }
      press = { x, y, button: 0, shift: false, on: "map", time: performance.now() };
    };

    const onMove = (e: PointerEvent) => {
      const [x, y] = local(e);
      lastMouse = [x, y];
      if (modal) {
        modal.move(x, y, e.ctrlKey || e.metaKey, e.shiftKey);
        invalidate();
        return;
      }
      if (tool) {
        tool.move(x, y, e);
        invalidate();
        return;
      }
      if (press && press.button === 0 && press.on !== "map") {
        const moved = Math.hypot(x - press.x, y - press.y);
        if (press.on === "gizmo" && moved > 3) {
          const g = press.gizmo!;
          const s = useEditStore.getState();
          const kind: ModalKind = s.tool === "height" ? "height" : g.kind;
          startModal(kind, [press.x, press.y], { axis: g.axis, drag: true });
          press = null;
          modal?.move(x, y, e.ctrlKey || e.metaKey, e.shiftKey);
          return;
        }
        if (press.on === "selection" && moved > 4) {
          const s = useEditStore.getState();
          startModal(s.tool === "height" ? "height" : "move", [press.x, press.y], { drag: true });
          press = null;
          modal?.move(x, y, e.ctrlKey || e.metaKey, e.shiftKey);
          return;
        }
        if (press.on === "box") {
          const x0 = Math.min(press.x, x), x1 = Math.max(press.x, x), y0 = Math.min(press.y, y), y1 = Math.max(press.y, y);
          Object.assign(rectEl.style, { display: moved > 3 ? "block" : "none", left: `${el.offsetLeft + x0}px`, top: `${el.offsetTop + y0}px`, width: `${x1 - x0}px`, height: `${y1 - y0}px` });
        }
        return;
      }
      if (!e.buttons) {
        const { w, h } = size();
        const g = gizmo.pick(x, y, camera, w, h);
        if (gizmo.setHighlight(g)) invalidate();
        el.style.cursor = g ? "grab" : useEditStore.getState().tool === "draw" ? "crosshair" : "";
        if (useEditStore.getState().tool === "draw" && drawPoints.length) {
          const p = tileManager.pickGround(rayAt(x, y));
          editLayer.setDrawPreview(p ? [...drawPoints, p] : drawPoints);
          invalidate();
        }
      }
    };

    const onUp = (e: PointerEvent) => {
      const [x, y] = local(e);
      if (modal?.drag) {
        endModal(true);
        return;
      }
      const p = press;
      press = null;
      if (!p) return;
      const moved = Math.hypot(x - p.x, y - p.y);
      if (p.button === 2) {
        if (moved <= 4 && performance.now() - p.time < 500) openMenu(e.clientX, e.clientY, x, y);
        return;
      }
      if (p.on === "box") {
        rectEl.style.display = "none";
        boxArmed = false;
        if (moved > 4) boxSelect({ x0: Math.min(p.x, x), x1: Math.max(p.x, x), y0: Math.min(p.y, y), y1: Math.max(p.y, y) }, p.shift);
        else click(x, y, true); // Shift+click: add / remove
        invalidate();
        return;
      }
      // a handle pressed without dragging does nothing (it is not a click on what lies behind it)
      if (p.on === "gizmo") return;
      if (moved <= 5 && performance.now() - p.time < 600) {
        click(x, y, false);
        invalidate();
      }
    };

    const openMenu = (clientX: number, clientY: number, x: number, y: number) => {
      const p = tileManager.pickGround(rayAt(x, y));
      const ll = p ? fromScene(tileManager.origin, p.x, p.z) : null;
      useContribStore.getState().openMenu({ kind: "edit", lat: ll?.lat ?? null, lng: ll?.lng ?? null }, clientX, clientY);
    };

    // ------------------------------------------------------------------------- keys
    const onKey = (e: KeyboardEvent) => {
      const s = useEditStore.getState();
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (s.dialog || useContribStore.getState().menu) return;
      const used = handleKey(e, s);
      if (used) {
        e.preventDefault();
        e.stopImmediatePropagation();
        invalidate();
      }
    };

    const handleKey = (e: KeyboardEvent, s: ReturnType<typeof useEditStore.getState>): boolean => {
      const k = e.key.toLowerCase();
      const ctrl = e.ctrlKey || e.metaKey;
      if (modal) {
        if (e.key === "Escape") endModal(false);
        else if (e.key === "Enter") endModal(true);
        else if (!modal.key(e)) return false;
        return true;
      }
      if (tool) {
        if (e.key === "Escape") tool.cancel();
        else if (!tool.key(e)) return false;
        if (tool.done) tool = null;
        return true;
      }
      if (s.tool === "draw" && drawPoints.length) {
        if (e.key === "Enter") finishDraw();
        else if (e.key === "Escape") {
          drawPoints.length = 0;
          editLayer.setDrawPreview(null);
        } else if (e.key === "Backspace") {
          drawPoints.pop();
          editLayer.setDrawPreview(drawPoints.length ? drawPoints : null);
        } else return false;
        return true;
      }
      const mode = elemMode(s.mode);
      if (ctrl && k === "z") {
        if (e.shiftKey) s.redo();
        else s.undo();
        return true;
      }
      if (ctrl && k === "y") return s.redo(), true;
      if (e.key === "Tab") {
        if (e.shiftKey) s.toggleSnap();
        else s.setMode(s.mode === "object" ? lastElemMode : "object");
        return true;
      }
      if (!ctrl && !e.altKey && (k === "1" || k === "2" || k === "3") && !e.code.startsWith("Numpad")) {
        const m = ({ "1": "vertex", "2": "edge", "3": "face" } as const)[k];
        lastElemMode = m;
        s.setMode(m);
        return true;
      }
      // views (numpad, as in Blender)
      if (e.code === "Numpad7") return useViewStore.getState().view(ctrl ? "bottom" : "top"), true;
      if (e.code === "Numpad1") return useViewStore.getState().view(ctrl ? "back" : "front"), true;
      if (e.code === "Numpad3") return useViewStore.getState().view(ctrl ? "left" : "right"), true;
      if (e.code === "NumpadDecimal" || (e.key === "." && !mode)) return frameSelected(), true;
      if (e.key === "Home") return frameAll(), true;

      if (!ctrl && !e.altKey && (k === "g" || k === "r" || k === "s") && !e.shiftKey) {
        startModal(k === "g" ? "move" : k === "r" ? "rotate" : "scale", lastMouse);
        return true;
      }
      if (k === "a" && e.shiftKey && !ctrl) return addBox(), true;
      if (k === "a" && !ctrl) {
        if (e.altKey) s.deselectAll();
        else s.selectAll();
        return true;
      }
      if (k === "b" && !ctrl) {
        boxArmed = true;
        return true;
      }
      if (e.key === "Escape") {
        if (s.tool === "draw") s.setTool("move");
        else if (mode ? [...s.elems.values()].some((x) => x.verts.size) : s.objects.size) s.deselectAll();
        else s.requestExit();
        return true;
      }
      if (k === "d" && e.shiftKey && !ctrl) {
        if (mode) return false;
        duplicate();
        return true;
      }
      if (!mode) {
        if ((k === "x" || e.key === "Delete") && !ctrl) return s.deleteSelected(), true;
        return false;
      }
      // element modes
      if ((k === "x" || e.key === "Delete") && !ctrl) {
        const [mx, my] = lastMouse;
        const r = el.getBoundingClientRect();
        useContribStore.getState().openMenu({ kind: "delete" }, r.left + mx, r.top + my);
        return true;
      }
      if (k === "e" && !ctrl) return extrude(), true;
      if (k === "m" && !ctrl) return openMergeMenu(), true;
      if (k === "f" && !ctrl) return runOp("Fill", (d, sel, m) => ops.fill({ mesh: d.mesh, sel, mode: m })), true;
      if (k === "j" && !ctrl) return runOp("Connect", (d, sel, m) => ops.connect({ mesh: d.mesh, sel, mode: m })), true;
      if (k === "n" && e.shiftKey && !ctrl) return runOp("Normals", (d, sel) => ({ mesh: ops.recalcNormals(d.mesh), sel })), true;
      if (k === "i" && !ctrl) return startTool("inset"), true;
      if (k === "b" && ctrl) return startTool("bevel"), true;
      if (k === "r" && ctrl) return startTool("loopcut"), true;
      if (k === "k" && !ctrl) return startTool("knife"), true;
      return false;
    };

    // E: extrude what is selected (faces as a region, edges, lone vertices), then move it: along the
    // region's normal when there are faces, else freely. Extrude and move are one undo step (cancelling the
    // move takes the extrusion back too).
    const extrude = () => {
      const s = useEditStore.getState();
      let normal: [number, number, number] | null = null;
      s.beginModal();
      const ok = runOp(
        "Extrude",
        (d, sel, m) => {
          const out = ops.extrude({ mesh: d.mesh, sel, mode: m });
          normal ??= out.normal;
          return { mesh: out.mesh, sel: out.sel };
        },
        { preview: true },
      );
      if (!ok) return s.endModal(false);
      if (!startModal("move", lastMouse, { ...(normal ? { dir: normal } : {}), continued: true })) s.endModal(true);
    };

    // Shift+D: duplicate the buildings, then move the copies (one undo step)
    const duplicate = () => {
      const s = useEditStore.getState();
      if (s.mode !== "object") return;
      s.beginModal();
      if (!s.duplicateSelected(true).length) return s.endModal(false);
      if (!startModal("move", lastMouse, { continued: true })) s.endModal(true);
    };

    // M: the merge menu at the mouse; its cursor is the surface (or ground) under the mouse
    const openMergeMenu = () => {
      const ray = rayAt(...lastMouse);
      const hit = editLayer.pickSurface(ray)?.point ?? tileManager.pickGround(ray);
      const r = el.getBoundingClientRect();
      useContribStore.getState().openMenu({ kind: "merge", cursor: hit ? [hit.x, hit.y, hit.z] : null }, r.left + lastMouse[0], r.top + lastMouse[1]);
    };

    const startTool = (name: "inset" | "bevel" | "loopcut" | "knife") => {
      const { w, h } = size();
      tool = interactiveTool(name, { camera, size: { w, h }, mouse: lastMouse, rayAt });
      if (tool?.done) tool = null;
    };

    const addBox = () => {
      const p = tileManager.pickGround(rayAt(...lastMouse));
      if (!p) return notify("Point at the ground to add a building there");
      const ll = fromScene(tileManager.origin, p.x, p.z);
      useEditStore.getState().addBox([Math.round(ll.lng * 1e7) / 1e7, Math.round(ll.lat * 1e7) / 1e7]);
    };

    const frameSelected = () => {
      const s = useEditStore.getState();
      const sphere = editLayer.bounds(s.objects);
      if (sphere) useViewStore.getState().frame(sphere.center.x, sphere.center.y, sphere.center.z, sphere.radius);
    };
    const frameAll = () => {
      const s = useEditStore.getState();
      const sphere = editLayer.bounds(s.drafts.keys());
      if (sphere) useViewStore.getState().frame(sphere.center.x, sphere.center.y, sphere.center.z, sphere.radius);
    };

    // a wheel turn during a tool (bevel segments) is the tool's, not a zoom
    const onWheel = (e: WheelEvent) => {
      if (tool?.wheel(e.deltaY)) {
        stop(e);
        invalidate();
      }
    };

    const onEditAction = (e: Event) => {
      const action = (e as CustomEvent<string>).detail;
      if (action === "extrude") extrude();
      else if (action === "duplicate") duplicate();
      else if (action === "merge") openMergeMenu();
      else if (action === "addBox") addBox();
      else if (action === "addBoxCenter") {
        const { w, h } = size();
        lastMouse = [w / 2, h / 2];
        addBox();
      }
      else if (action === "frame") frameSelected();
      else if (action === "frameAll") frameAll();
      else if (action === "g" || action === "r" || action === "s") startModal(action === "g" ? "move" : action === "r" ? "rotate" : "scale", lastMouse);
      else if (action === "height") startModal("height", lastMouse);
      else if (action === "inset" || action === "bevel" || action === "loopcut" || action === "knife") startTool(action);
      invalidate();
    };

    parent.addEventListener("pointerdown", onDown, true);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("keydown", onKey, true);
    parent.addEventListener("wheel", onWheel, { capture: true, passive: false });
    window.addEventListener("map3d-edit", onEditAction);
    return () => {
      parent.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("keydown", onKey, true);
      parent.removeEventListener("wheel", onWheel, true);
      window.removeEventListener("map3d-edit", onEditAction);
      rectEl.remove();
      if (modal) endModal(false);
      tool?.cancel();
      tool = null;
      editLayer.setDrawPreview(null);
      el.style.cursor = "";
    };
  }, [active, gl, camera, invalidate]);

  // the gizmo follows the selection
  useFrame(() => {
    const s = useEditStore.getState();
    const kind = !s.active || tool || s.tool === "draw" ? null : s.tool === "move" || s.tool === "rotate" || s.tool === "scale" ? s.tool : null;
    gizmo.set(kind, kind ? selectionPivot() : null, camera);
  });

  return null;
}

let lastElemMode: ElemMode = "vertex";

/** for the toolbar and menus: run an Edit mode action as if its key was pressed */
export function editAction(action: string) {
  window.dispatchEvent(new CustomEvent("map3d-edit", { detail: action }));
}

