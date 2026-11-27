// Edit mode, top center: the selection mode (Object, Vertex, Edge, Face — Tab, 1, 2, 3), snapping
// (Shift+Tab), the pivot for rotate / scale, undo and redo; under it what the running operation does
// ("Move · X · 5 m"), and the offer to bring back unsubmitted edits from an earlier visit.

import { css } from "@emotion/react";
import { useEffect, useRef, useState } from "react";
import { ChevronDown, Loader2, Magnet, Redo2, Undo2 } from "lucide-react";
import { Mode, Pivot, useEditStore } from "@/state/editStore";
import type { SnapTarget } from "@/three/edit/snapping";
import { UI, iconSize, mobile, panel, pillButton, spin } from "@/components/ui/styles";

const MODES: [Mode, string, string][] = [
  ["object", "Object", "Tab"],
  ["vertex", "Vertex", "1"],
  ["edge", "Edge", "2"],
  ["face", "Face", "3"],
];

const bar = css([
  panel,
  css({
    position: "fixed",
    top: UI.top + UI.barHeight + 10,
    left: "50%",
    transform: "translateX(-50%)",
    zIndex: 25,
    display: "flex",
    alignItems: "center",
    gap: 6,
    height: 38,
    padding: "0 6px",
    borderRadius: 19,
    whiteSpace: "nowrap",
    [mobile]: { display: "none" },
  }),
]);

const segment = (on: boolean) =>
  css({
    height: 28,
    padding: "0 12px",
    border: "none",
    borderRadius: 14,
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
    color: on ? "#ffffff" : UI.text,
    backgroundColor: on ? UI.accent : "transparent",
    ":hover": { backgroundColor: on ? UI.accent : UI.surfaceHover },
  });

const iconButton = (on = false) => [pillButton, css({ height: 28, minWidth: 28, width: 28, backgroundColor: on ? UI.accent : "transparent", color: on ? "#ffffff" : UI.icon })];

const SNAP_TARGETS: [SnapTarget, string][] = [
  ["vertex", "Vertex"],
  ["edge", "Edge"],
  ["face", "Face"],
  ["ground", "Ground"],
];

/** what snapping snaps to (several at once; the nearest kind under the mouse wins: vertex, edge, face, ground) */
function SnapTo() {
  const snapTo = useEditStore((s) => s.snapTo);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [open]);
  return (
    <div ref={box} css={css({ position: "relative" })}>
      <button css={[pillButton, css({ height: 28, minWidth: 20, width: 20, backgroundColor: "transparent", color: UI.icon })]} aria-label="Snap to" aria-expanded={open} title="Snap to…" onClick={() => setOpen((v) => !v)}>
        <ChevronDown css={iconSize(13)} />
      </button>
      {open && (
        <div role="group" aria-label="Snap to" css={[panel, css({ position: "absolute", top: 34, left: -60, width: 140, padding: 8, borderRadius: 12, zIndex: 30 })]}>
          <div css={css({ fontSize: 11, fontWeight: 600, color: UI.icon, padding: "0 4px 4px" })}>Snap to</div>
          {SNAP_TARGETS.map(([t, label]) => (
            <label key={t} css={css({ display: "flex", alignItems: "center", gap: 8, padding: "4px", fontSize: 13, cursor: "pointer" })}>
              <input
                type="checkbox"
                checked={snapTo.includes(t)}
                onChange={(e) => useEditStore.getState().setSnapTo(e.target.checked ? [...snapTo, t] : snapTo.filter((x) => x !== t))}
                css={css({ accentColor: UI.accent })}
              />
              {label}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

function time(iso: string) {
  const d = new Date(iso);
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString("en", { hour: "numeric", minute: "2-digit" })
    : d.toLocaleDateString("en", { month: "short", day: "numeric" });
}

export function ModeBar() {
  const active = useEditStore((s) => s.active);
  const mode = useEditStore((s) => s.mode);
  const snap = useEditStore((s) => s.snap);
  const pivot = useEditStore((s) => s.pivot);
  const canUndo = useEditStore((s) => s.undoStack.length > 0);
  const canRedo = useEditStore((s) => s.redoStack.length > 0);
  const hint = useEditStore((s) => s.hint);
  const loading = useEditStore((s) => s.loading);
  const restore = useEditStore((s) => s.restore);
  const store = useEditStore.getState();
  if (!active) return null;

  return (
    <>
      <div role="toolbar" aria-label="Edit mode" css={bar}>
        <div role="radiogroup" aria-label="Select" css={css({ display: "flex", gap: 2 })}>
          {MODES.map(([m, label, key]) => (
            <button key={m} role="radio" aria-checked={mode === m} css={segment(mode === m)} title={`${label} (${key})`} onClick={() => store.setMode(m)}>
              {label}
            </button>
          ))}
        </div>
        <span css={css({ width: 1, height: 20, backgroundColor: UI.line })} />
        <div css={css({ display: "flex", alignItems: "center" })}>
          <button css={iconButton(snap)} aria-pressed={snap} title="Snap while moving (Shift+Tab; Ctrl: 1 m steps)" aria-label="Snap" onClick={() => store.toggleSnap()}>
            <Magnet css={iconSize(15)} />
          </button>
          <SnapTo />
        </div>
        <select
          aria-label="Pivot"
          value={pivot}
          title="Rotate and scale around"
          onChange={(e) => store.setPivot(e.target.value as Pivot)}
          css={css({ height: 28, border: "none", borderRadius: 14, backgroundColor: "transparent", color: UI.text, fontSize: 13, fontFamily: "inherit", padding: "0 4px", cursor: "pointer" })}
        >
          <option value="median">Median point</option>
          <option value="individual">Individual origins</option>
        </select>
        <span css={css({ width: 1, height: 20, backgroundColor: UI.line })} />
        <button css={iconButton()} disabled={!canUndo} title="Undo (Ctrl+Z)" aria-label="Undo" onClick={() => store.undo()}>
          <Undo2 css={iconSize(15)} />
        </button>
        <button css={iconButton()} disabled={!canRedo} title="Redo (Ctrl+Shift+Z)" aria-label="Redo" onClick={() => store.redo()}>
          <Redo2 css={iconSize(15)} />
        </button>
      </div>

      {(hint || loading > 0) && (
        <div
          role="status"
          css={[
            panel,
            css({
              position: "fixed",
              top: UI.top + UI.barHeight + 56,
              left: "50%",
              transform: "translateX(-50%)",
              zIndex: 25,
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "6px 14px",
              borderRadius: 14,
              fontSize: 13,
              fontWeight: 600,
              fontVariantNumeric: "tabular-nums",
              [mobile]: { display: "none" },
            }),
          ]}
        >
          {loading > 0 && <Loader2 css={[iconSize(14), css({ animation: `${spin} 1s linear infinite` })]} />}
          {hint ?? "Loading the building…"}
        </div>
      )}

      {restore && (
        <div
          role="alertdialog"
          aria-label="Restore unsaved edits"
          css={[
            panel,
            css({
              position: "fixed",
              top: UI.top + UI.barHeight + 56,
              left: "50%",
              transform: "translateX(-50%)",
              zIndex: 26,
              display: "flex",
              alignItems: "center",
              gap: 12,
              padding: "8px 10px 8px 16px",
              borderRadius: 16,
              fontSize: 13,
            }),
          ]}
        >
          <span>
            Unsubmitted edits from {time(restore.savedAt)} ({restore.drafts.length} {restore.drafts.length === 1 ? "building" : "buildings"})
          </span>
          <button css={[pillButton, css({ height: 28, padding: "0 12px", fontSize: 13, fontWeight: 600, color: "#fff", backgroundColor: UI.accent })]} onClick={() => store.restoreSaved(true)}>
            Restore
          </button>
          <button css={[pillButton, css({ height: 28, padding: "0 12px", fontSize: 13, fontWeight: 600, color: UI.text, backgroundColor: UI.control })]} onClick={() => store.restoreSaved(false)}>
            Discard
          </button>
        </div>
      )}
    </>
  );
}
