// Edit mode, right edge: the tools, as in Blender's toolbar. Object mode: select, move, rotate, scale,
// height, add a box / draw a footprint, duplicate, remove. Vertex / edge / face modes: the transforms and
// the mesh tools (extrude, inset, bevel, loop cut, knife, merge, fill, delete, normals). Then the views.

import { css } from "@emotion/react";
import type { LucideIcon } from "lucide-react";
import {
  ArrowUpFromLine,
  Cable,
  ArrowUpToLine,
  Box,
  Columns2,
  Copy,
  Eye,
  FlipVertical2,
  Focus,
  Frame,
  Merge,
  MousePointer2,
  Move,
  PaintBucket,
  PenTool,
  RotateCw,
  ScanLine,
  Scaling,
  Slice,
  Squircle,
  Trash2,
} from "lucide-react";
import * as ops from "@/edit/ops";
import { selectNonManifold } from "@/edit/ops";
import { ElemMode } from "@/edit/select";
import { Tool, useEditStore } from "@/state/editStore";
import { useContribStore } from "@/state/contribStore";
import { useViewStore } from "@/state/viewStore";
import { editAction, runOp } from "@/three/edit/EditInput";
import { UI, iconSize, mobile, panel } from "@/components/ui/styles";

type Item =
  | { kind: "tool"; tool: Tool; icon: LucideIcon; label: string }
  | { kind: "action"; run: (button: HTMLElement) => void; icon: LucideIcon; label: string; danger?: boolean }
  | { kind: "gap" };

const tool = (t: Tool, icon: LucideIcon, label: string): Item => ({ kind: "tool", tool: t, icon, label });
const action = (run: (button: HTMLElement) => void, icon: LucideIcon, label: string, danger = false): Item => ({ kind: "action", run, icon, label, danger });
const gap: Item = { kind: "gap" };

const deleteMenu = (button: HTMLElement) => {
  const r = button.getBoundingClientRect();
  useContribStore.getState().openMenu({ kind: "delete" }, r.left - 8, r.top);
};

const OBJECT: Item[] = [
  tool("select", MousePointer2, "Select — click, Shift+drag or B for a box"),
  tool("move", Move, "Move (G)"),
  tool("rotate", RotateCw, "Rotate (R)"),
  tool("scale", Scaling, "Scale (S)"),
  tool("height", ArrowUpFromLine, "Height — drag a building up or down"),
  gap,
  action(() => editAction("addBoxCenter"), Box, "Add a building (Shift+A)"),
  tool("draw", PenTool, "Draw a footprint — click its corners, Enter to finish"),
  action(() => editAction("duplicate"), Copy, "Duplicate (Shift+D)"),
  action(() => useEditStore.getState().deleteSelected(), Trash2, "Remove (X)", true),
];

const ELEMENT: Item[] = [
  tool("select", MousePointer2, "Select — click, Shift+drag or B for a box"),
  tool("move", Move, "Move (G)"),
  tool("rotate", RotateCw, "Rotate (R)"),
  tool("scale", Scaling, "Scale (S)"),
  gap,
  action(() => editAction("extrude"), ArrowUpToLine, "Extrude (E)"),
  action(() => editAction("inset"), Frame, "Inset faces (I)"),
  action(() => editAction("bevel"), Squircle, "Bevel edges (Ctrl+B)"),
  action(() => editAction("loopcut"), Columns2, "Loop cut (Ctrl+R)"),
  action(() => editAction("knife"), Slice, "Knife (K)"),
  action((b) => {
    const r = b.getBoundingClientRect();
    useContribStore.getState().openMenu({ kind: "merge", cursor: null }, r.left - 8, r.top);
  }, Merge, "Merge (M)"),
  action(() => runOp("Fill", (d, sel, m) => ops.fill({ mesh: d.mesh, sel, mode: m })), PaintBucket, "Fill (F): a hole, or two vertices"),
  action(() => runOp("Connect", (d, sel, m) => ops.connect({ mesh: d.mesh, sel, mode: m })), Cable, "Connect two corners of a face (J)"),
  action(deleteMenu, Trash2, "Delete / Dissolve (X)", true),
  gap,
  action(() => runOp("Normals", (d, sel) => ({ mesh: ops.recalcNormals(d.mesh), sel })), FlipVertical2, "Recalculate normals (Shift+N)"),
  action(() => {
    const s = useEditStore.getState();
    const elems = new Map(s.elems);
    for (const id of s.objects) {
      const d = s.drafts.get(id);
      if (d) elems.set(id, selectNonManifold(d.mesh, s.mode as ElemMode));
    }
    s.setElems(elems);
  }, ScanLine, "Select problems (open or broken edges)"),
];

const button = (on: boolean, danger = false) =>
  css({
    width: 34,
    height: 34,
    border: "none",
    borderRadius: 17,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
    color: on ? "#ffffff" : danger ? UI.danger : UI.icon,
    backgroundColor: on ? UI.accent : "transparent",
    ":hover": { backgroundColor: on ? UI.accent : UI.surfaceHover },
  });

export function EditToolbar() {
  const active = useEditStore((s) => s.active);
  const mode = useEditStore((s) => s.mode);
  const current = useEditStore((s) => s.tool);
  if (!active) return null;
  const items = mode === "object" ? OBJECT : ELEMENT;
  const views: [string, () => void, LucideIcon][] = [
    ["Top view (Numpad 7)", () => useViewStore.getState().view("top"), Eye],
    ["Front view (Numpad 1)", () => useViewStore.getState().view("front"), Eye],
    ["Right view (Numpad 3)", () => useViewStore.getState().view("right"), Eye],
    ["Frame selected (Numpad .)", () => editAction("frame"), Focus],
  ];
  return (
    <nav
      aria-label="Edit tools"
      css={[
        panel,
        css({
          position: "fixed",
          top: 94,
          right: UI.side,
          zIndex: 24,
          width: 44,
          boxSizing: "border-box",
          padding: 5,
          borderRadius: 22,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 2,
          maxHeight: "calc(100vh - 120px)",
          overflowY: "auto",
          [mobile]: { display: "none" },
        }),
      ]}
    >
      {items.map((it, i) => {
        if (it.kind === "gap") return <span key={i} css={css({ width: 22, height: 1, margin: "4px 0", backgroundColor: UI.line, flexShrink: 0 })} />;
        const Icon = it.icon;
        if (it.kind === "tool")
          return (
            <button key={i} css={button(current === it.tool)} title={it.label} aria-label={it.label} aria-pressed={current === it.tool} onClick={() => useEditStore.getState().setTool(it.tool)}>
              <Icon css={iconSize(16)} />
            </button>
          );
        return (
          <button key={i} css={button(false, it.danger)} title={it.label} aria-label={it.label} onClick={(e) => it.run(e.currentTarget)}>
            <Icon css={iconSize(16)} />
          </button>
        );
      })}
      <span css={css({ width: 22, height: 1, margin: "4px 0", backgroundColor: UI.line, flexShrink: 0 })} />
      {views.map(([label, run, Icon], i) => (
        <button key={label} css={button(false)} title={label} aria-label={label} onClick={run}>
          {i < 3 ? <span css={css({ fontSize: 11, fontWeight: 700 })}>{["T", "F", "R"][i]}</span> : <Icon css={iconSize(16)} />}
        </button>
      ))}
    </nav>
  );
}
