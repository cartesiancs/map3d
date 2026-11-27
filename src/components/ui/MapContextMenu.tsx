// Right-click menu of the 3D view, styled after the shadcn/ui Context Menu (Radix primitive + Emotion, no
// Tailwind). Space.tsx decides when a right click opens it (a short click, not a rotate drag) and what was hit;
// the menu is then opened at that point through a synthetic contextmenu event on an invisible trigger.
// In Edit mode (three/edit/EditInput.tsx) it is the edit menu, and X opens the delete menu.

import { css } from "@emotion/react";
import { useEffect, useRef } from "react";
import * as Menu from "@radix-ui/react-context-menu";
import { ArrowUpFromLine, Box, Copy, Crosshair, ExternalLink, LogIn, LogOut, Pencil, PenTool, Trash2 } from "lucide-react";
import { MenuTarget, useContribStore } from "@/state/contribStore";
import { useAuthStore } from "@/state/authStore";
import { useViewStore } from "@/state/viewStore";
import { pendingFor, refOf } from "@/api/changesets";
import { Editing, defaultEditing, useEditStore } from "@/state/editStore";
import * as ops from "@/edit/ops";
import { selectNonManifold } from "@/edit/ops";
import type { ElemMode } from "@/edit/select";
import { editAction, runOp } from "@/three/edit/EditInput";
import { editLayer } from "@/three/Space";
import { Vector3 } from "three";
import { englishName } from "@/utils/english";
import { UI, iconSize } from "./styles";

const MENU = { bg: UI.menu, border: UI.menuBorder, highlight: UI.menuHover, muted: UI.muted };

const content = css({
  minWidth: 224,
  padding: 4,
  backgroundColor: MENU.bg,
  color: UI.text,
  border: `1px solid ${MENU.border}`,
  borderRadius: 8,
  boxShadow: `0 4px 6px -1px ${UI.shadowStrong}, 0 2px 4px -2px ${UI.shadowStrong}`,
  fontSize: 14,
  zIndex: 60,
  outline: "none",
  transformOrigin: "var(--radix-context-menu-content-transform-origin)",
  animation: "map3d-menu-in .1s ease-out",
  "@keyframes map3d-menu-in": { from: { opacity: 0, transform: "scale(.96)" }, to: { opacity: 1, transform: "none" } },
});

const item = css({
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "6px 8px",
  borderRadius: 4,
  cursor: "default",
  userSelect: "none",
  outline: "none",
  lineHeight: "20px",
  "&[data-highlighted]": { backgroundColor: MENU.highlight },
  "&[data-disabled]": { opacity: 0.5, pointerEvents: "none" },
  svg: { color: MENU.muted },
});

const label = css({ padding: "6px 8px", fontSize: 14, fontWeight: 600, lineHeight: "20px" });
const sub = css({ display: "block", fontSize: 12, fontWeight: 400, color: MENU.muted, marginTop: 1 });
const separator = css({ height: 1, margin: "4px -4px", backgroundColor: MENU.border });
const badge = css({
  display: "inline-block",
  marginLeft: 6,
  padding: "1px 6px",
  borderRadius: 9,
  fontSize: 11,
  fontWeight: 600,
  backgroundColor: UI.pendingBg,
  color: UI.pendingFg,
  verticalAlign: "1px",
});
const shortcut = css({ marginLeft: "auto", paddingLeft: 16, fontSize: 12, letterSpacing: "0.1em", color: MENU.muted });

const coords = (lat: number, lng: number) => `${lat.toFixed(6)}, ${lng.toFixed(6)}`;

function copy(text: string) {
  const notify = useAuthStore.getState().notify;
  navigator.clipboard?.writeText(text).then(
    () => notify("Coordinates copied"),
    () => notify(text),
  );
}

function BuildingItems({ target }: { target: Extract<MenuTarget, { kind: "building" }> }) {
  const status = useAuthStore((s) => s.status);
  const signIn = useAuthStore((s) => s.signIn);
  const mine = useContribStore((s) => s.mine);
  const pending = pendingFor(mine, refOf(target.id));
  const name = englishName(target.tags);
  const signedIn = status === "signedIn";

  const edit = (editing: Editing) => () => {
    useContribStore.getState().closeMenu();
    void useEditStore.getState().enter(target.id, editing);
  };
  // E opens the way of editing used last
  const usual = defaultEditing();

  return (
    <>
      <Menu.Label css={label}>
        {name ?? "Building"}
        {pending && <span css={badge}>Pending review</span>}
        <span css={sub}>{target.id < 0 ? "Added on map3d" : `OSM way ${target.id}`}</span>
      </Menu.Label>
      <Menu.Separator css={separator} />
      <Menu.Item css={item} disabled={!signedIn} onSelect={edit("height")}>
        <ArrowUpFromLine css={iconSize(16)} />
        Edit height
        {usual === "height" && <span css={shortcut}>E</span>}
      </Menu.Item>
      <Menu.Item css={item} disabled={!signedIn} onSelect={edit("shape")}>
        <Pencil css={iconSize(16)} />
        Edit shape
        {usual === "shape" && <span css={shortcut}>E</span>}
      </Menu.Item>
      <Menu.Item css={item} onSelect={() => copy(coords(target.lat, target.lng))}>
        <Copy css={iconSize(16)} /> Copy coordinates
      </Menu.Item>
      {target.id > 0 && (
        <Menu.Item css={item} onSelect={() => window.open(`https://www.openstreetmap.org/way/${target.id}`, "_blank", "noopener,noreferrer")}>
          <ExternalLink css={iconSize(16)} /> View on OpenStreetMap
        </Menu.Item>
      )}
      {status === "signedOut" && (
        <>
          <Menu.Separator css={separator} />
          <Menu.Item css={item} onSelect={signIn}>
            <LogIn css={iconSize(16)} /> Sign in with GitHub to contribute
          </Menu.Item>
        </>
      )}
    </>
  );
}

/** Edit mode: what can be done with the selection (by mode), adding buildings, views */
function EditItems({ target }: { target: Extract<MenuTarget, { kind: "edit" }> }) {
  const editing = useEditStore((s) => s.editing);
  const mode = useEditStore((s) => s.mode);
  const count = useEditStore((s) => (s.mode === "object" ? s.objects.size : [...s.elems.values()].reduce((n, e) => n + e.verts.size, 0)));
  const s = useEditStore.getState();
  const none = count === 0;
  const run = (a: string) => () => editAction(a);
  const entry = (label: string, key: string, onSelect: () => void, disabled = none) => (
    <Menu.Item css={item} disabled={disabled} onSelect={onSelect}>
      {label}
      <span css={shortcut}>{key}</span>
    </Menu.Item>
  );
  if (editing === "height")
    return (
      <>
        <Menu.Label css={label}>
          Height editing
          <span css={sub}>{`${count} ${count === 1 ? "building" : "buildings"} selected`}</span>
        </Menu.Label>
        <Menu.Separator css={separator} />
        {entry("Change height", "G", run("height"))}
        {entry("Select all", "A", () => s.selectAll(), false)}
        {entry("Frame selected", "Num .", run("frame"))}
        <Menu.Separator css={separator} />
        <Menu.Item css={item} onSelect={() => s.setEditing("shape")}>
          <Pencil css={iconSize(16)} /> Edit shape instead
        </Menu.Item>
        <Menu.Item css={item} onSelect={() => s.requestExit()}>
          <LogOut css={iconSize(16)} /> Exit Edit mode
        </Menu.Item>
      </>
    );
  return (
    <>
      <Menu.Label css={label}>
        Edit mode
        <span css={sub}>
          {mode === "object" ? `${count} ${count === 1 ? "building" : "buildings"} selected` : `${mode[0].toUpperCase()}${mode.slice(1)} mode · ${count} vertices selected`}
        </span>
      </Menu.Label>
      <Menu.Separator css={separator} />
      {entry("Move", "G", run("g"))}
      {entry("Rotate", "R", run("r"))}
      {entry("Scale", "S", run("s"))}
      {mode === "object" ? (
        <>
          {entry("Height", "", run("height"))}
          {entry("Duplicate", "⇧D", run("duplicate"))}
          <Menu.Item css={item} disabled={none} onSelect={() => s.deleteSelected()}>
            <Trash2 css={iconSize(16)} /> Remove
            <span css={shortcut}>X</span>
          </Menu.Item>
          <Menu.Separator css={separator} />
          <Menu.Item
            css={item}
            disabled={target.lat === null}
            onSelect={() => target.lat !== null && s.addBox([Math.round(target.lng! * 1e7) / 1e7, Math.round(target.lat * 1e7) / 1e7])}
          >
            <Box css={iconSize(16)} /> Add a building here
            <span css={shortcut}>⇧A</span>
          </Menu.Item>
          <Menu.Item css={item} onSelect={() => s.setTool("draw")}>
            <PenTool css={iconSize(16)} /> Draw a footprint
          </Menu.Item>
        </>
      ) : (
        <>
          <Menu.Separator css={separator} />
          {entry("Extrude", "E", run("extrude"))}
          {entry("Inset faces", "I", run("inset"))}
          {entry("Bevel edges", "Ctrl B", run("bevel"))}
          {entry("Loop cut", "Ctrl R", run("loopcut"), false)}
          {entry("Knife", "K", run("knife"), false)}
          {entry("Merge…", "M", run("merge"))}
          {entry("Fill", "F", () => runOp("Fill", (d, sel, m) => ops.fill({ mesh: d.mesh, sel, mode: m })))}
          {entry("Connect", "J", () => runOp("Connect", (d, sel, m) => ops.connect({ mesh: d.mesh, sel, mode: m })))}
          <Menu.Separator css={separator} />
          <DeleteItems />
          <Menu.Separator css={separator} />
          {entry("Recalculate normals", "⇧N", () => runOp("Normals", (d, sel) => ({ mesh: ops.recalcNormals(d.mesh), sel })), false)}
          {entry("Select problems", "", () => {
            const elems = new Map(s.elems);
            for (const id of s.objects) {
              const d = s.drafts.get(id);
              if (d) elems.set(id, selectNonManifold(d.mesh, s.mode as ElemMode));
            }
            s.setElems(elems);
          }, false)}
          {entry("Back to Object mode", "Tab", () => s.setMode("object"), false)}
        </>
      )}
      <Menu.Separator css={separator} />
      {entry("Frame selected", "Num .", run("frame"))}
      <Menu.Item css={item} onSelect={() => s.requestExit()}>
        <LogOut css={iconSize(16)} /> Exit Edit mode
      </Menu.Item>
    </>
  );
}

/** Edit mode, M: merge the selected vertices at their center, at the one picked last, at the cursor, or by distance */
function MergeItems({ cursor }: { cursor: [number, number, number] | null }) {
  const merge = (at: "center" | "active" | "cursor") => () =>
    runOp("Merge", (d, sel, m) => {
      if (at !== "cursor") return ops.mergeAt({ mesh: d.mesh, sel, mode: m }, at);
      const local = cursor && editLayer.toDraftMeters(d.id, new Vector3(...cursor));
      if (!local) throw new ops.OpError("Point at a surface or the ground, then press M");
      return ops.mergeAt({ mesh: d.mesh, sel, mode: m }, local);
    });
  const byDistance = (distance: number) => () => {
    let merged = 0;
    const ok = runOp("Merge by distance", (d, sel, m) => {
      const out = ops.mergeByDistance({ mesh: d.mesh, sel, mode: m }, distance);
      merged += out.merged;
      return out;
    });
    if (ok) useAuthStore.getState().notify(merged ? `Merged ${merged} vertices` : "Nothing that close together");
  };
  return (
    <>
      <Menu.Label css={label}>Merge</Menu.Label>
      <Menu.Separator css={separator} />
      <Menu.Item css={item} onSelect={merge("center")}>
        At center
      </Menu.Item>
      <Menu.Item css={item} onSelect={merge("active")}>
        At last selected
      </Menu.Item>
      <Menu.Item css={item} disabled={!cursor} onSelect={merge("cursor")}>
        At cursor
      </Menu.Item>
      <Menu.Separator css={separator} />
      {[0.01, 0.05, 0.5].map((d) => (
        <Menu.Item key={d} css={item} onSelect={byDistance(d)}>
          By distance · {Math.round(d * 100)} cm
        </Menu.Item>
      ))}
    </>
  );
}

/** Edit mode, X: delete vertices / edges / faces, or dissolve them (their faces join) */
function DeleteItems() {
  const mode = useEditStore((s) => s.mode) as ElemMode;
  const del = (what: "vertices" | "edges" | "faces") => () => runOp("Delete", (d, sel, m) => ops.deleteElements({ mesh: d.mesh, sel, mode: m }, what));
  const dissolveLabel = mode === "vertex" ? "Dissolve vertices" : mode === "edge" ? "Dissolve edges" : "Dissolve faces";
  return (
    <>
      <Menu.Item css={item} onSelect={del("vertices")}>
        <Trash2 css={iconSize(16)} /> Delete vertices
      </Menu.Item>
      <Menu.Item css={item} onSelect={del("edges")}>
        <Trash2 css={iconSize(16)} /> Delete edges
      </Menu.Item>
      <Menu.Item css={item} onSelect={del("faces")}>
        <Trash2 css={iconSize(16)} /> Delete faces
      </Menu.Item>
      <Menu.Item css={item} onSelect={() => runOp("Dissolve", (d, sel, m) => ops.dissolve({ mesh: d.mesh, sel, mode: m }))}>
        {dissolveLabel}
      </Menu.Item>
    </>
  );
}

function GroundItems({ target }: { target: Extract<MenuTarget, { kind: "ground" }> }) {
  return (
    <>
      <Menu.Label css={label}>
        Ground
        <span css={sub}>{coords(target.lat, target.lng)}</span>
      </Menu.Label>
      <Menu.Separator css={separator} />
      <Menu.Item css={item} onSelect={() => copy(coords(target.lat, target.lng))}>
        <Copy css={iconSize(16)} /> Copy coordinates
      </Menu.Item>
      <Menu.Item css={item} onSelect={() => useViewStore.getState().flyTo(target.x, target.z, target.distance)}>
        <Crosshair css={iconSize(16)} /> Center view here
      </Menu.Item>
    </>
  );
}

export function MapContextMenu() {
  const menu = useContribStore((s) => s.menu);
  const closeMenu = useContribStore((s) => s.closeMenu);
  const trigger = useRef<HTMLSpanElement>(null);

  // open (or move) the menu at the clicked point
  useEffect(() => {
    if (!menu || !trigger.current) return;
    trigger.current.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: menu.x, clientY: menu.y }));
  }, [menu?.seq]); // eslint-disable-line react-hooks/exhaustive-deps

  // E: Edit the right-clicked building while the menu is open (shadcn-style shortcut hint)
  useEffect(() => {
    if (menu?.target.kind !== "building") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "e" || e.metaKey || e.ctrlKey || e.altKey) return;
      if (useAuthStore.getState().status !== "signedIn") return;
      const target = menu.target as Extract<MenuTarget, { kind: "building" }>;
      e.preventDefault();
      useContribStore.getState().closeMenu();
      void useEditStore.getState().enter(target.id);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [menu]);

  return (
    <Menu.Root onOpenChange={(open) => !open && closeMenu()}>
      <Menu.Trigger asChild>
        <span ref={trigger} aria-hidden css={css({ position: "fixed", left: 0, top: 0, width: 0, height: 0, pointerEvents: "none" })} />
      </Menu.Trigger>
      <Menu.Portal>
        {menu && (
          <Menu.Content css={content} collisionPadding={8} onCloseAutoFocus={(e) => e.preventDefault()}>
            {menu.target.kind === "building" ? (
              <BuildingItems target={menu.target} />
            ) : menu.target.kind === "edit" ? (
              <EditItems target={menu.target} />
            ) : menu.target.kind === "merge" ? (
              <MergeItems cursor={menu.target.cursor} />
            ) : menu.target.kind === "delete" ? (
              <>
                <Menu.Label css={label}>Delete</Menu.Label>
                <Menu.Separator css={separator} />
                <DeleteItems />
              </>
            ) : (
              <GroundItems target={menu.target} />
            )}
          </Menu.Content>
        )}
      </Menu.Portal>
    </Menu.Root>
  );
}
