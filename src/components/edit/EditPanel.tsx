// Edit mode, right (left of the toolbar): the active building — its size (X east, Y north, Z = height;
// typed values scale it), levels, whether its shape can be submitted — the selection's middle in the
// element modes (typed values move it), and every building changed in this session.

import { css } from "@emotion/react";
import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Check, RotateCcw } from "lucide-react";
import { Draft, draftErrors, draftStatus, draftWarnings } from "@/edit/drafts";
import { settle } from "@/edit/select";
import type { ElemMode } from "@/edit/select";
import { selectNonManifold as nonManifold } from "@/edit/ops";
import { centroidOf, mapVerts } from "@/edit/transform";
import { LIMITS } from "@/contrib/validate";
import { groundArea, meshHeight } from "@/contrib/mesh";
import { changedDrafts, useEditStore } from "@/state/editStore";
import { englishName } from "@/utils/english";
import { editAction } from "@/three/edit/EditInput";
import { UI, fieldLabel, iconSize, input, mobile, panel, pillButton } from "@/components/ui/styles";

const STATUS = {
  modified: { label: "Modified", fg: UI.accent },
  new: { label: "New", fg: "#16a34a" },
  deleted: { label: "Removed", fg: UI.danger },
  unchanged: { label: "Unchanged", fg: UI.icon },
};

const r1 = (v: number) => Math.round(v * 10) / 10;
const small = css({ fontSize: 12, color: UI.icon });
const section = css({ marginTop: 18, paddingTop: 14, borderTop: `1px solid ${UI.line}` });

export function draftTitle(d: Draft) {
  const name = englishName(d.tags);
  const where = d.kind === "create" ? "New building" : d.featureId! < 0 ? "Added on map3d" : `OSM way ${d.featureId}`;
  return { name: name ?? (d.kind === "create" ? "New building" : "Building"), where };
}

/** a number field that commits on Enter or when it loses focus */
function NumberField({ label, value, onCommit, step = 0.1, min, max, unit = "m", disabled }: { label: string; value: number | null; onCommit: (v: number | null) => void; step?: number; min?: number; max?: number; unit?: string; disabled?: boolean }) {
  const shown = value === null ? "" : String(r1(value));
  const [text, setText] = useState(shown);
  useEffect(() => setText(shown), [shown]);
  const commit = () => {
    if (text === shown) return;
    if (text.trim() === "") return onCommit(null);
    const v = Number(text);
    if (!Number.isFinite(v) || (min !== undefined && v < min) || (max !== undefined && v > max)) return setText(shown);
    onCommit(v);
  };
  return (
    <label css={css({ display: "flex", alignItems: "center", gap: 8, marginTop: 6 })}>
      <span css={css({ width: 18, fontSize: 13, fontWeight: 600, color: UI.icon })}>{label}</span>
      <input
        css={[input, css({ height: 30, fontSize: 14, fontVariantNumeric: "tabular-nums" })]}
        type="number"
        step={step}
        value={text}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") {
            setText(shown);
            (e.target as HTMLInputElement).blur();
          }
          e.stopPropagation(); // typing is not a shortcut
        }}
      />
      <span css={css({ width: 16, fontSize: 12, color: UI.icon })}>{unit}</span>
    </label>
  );
}

/** width (east), depth (north) and height of a mesh, m */
function dimensions(d: Draft) {
  const v = d.mesh.verts;
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let i = 0; i < v.length; i += 3) {
    x0 = Math.min(x0, v[i]);
    x1 = Math.max(x1, v[i]);
    z0 = Math.min(z0, v[i + 2]);
    z1 = Math.max(z1, v[i + 2]);
  }
  return { x: x1 - x0, y: z1 - z0, z: meshHeight(d.mesh), cx: (x0 + x1) / 2, cz: (z0 + z1) / 2 };
}

function ActiveBuilding({ d }: { d: Draft }) {
  const s = useEditStore.getState();
  const mode = useEditStore((st) => st.mode);
  const dims = dimensions(d);
  const errors = draftErrors(d);
  const warnings = draftWarnings(d);
  const status = draftStatus(d);
  const { name, where } = draftTitle(d);
  const footprint = useMemo(() => Math.round(groundArea(d.mesh)), [d.mesh]);

  /** scale along one axis about the middle of the footprint (height: from the ground) */
  const resize = (axis: "x" | "y" | "z", to: number | null) => {
    if (to === null || to <= 0) return;
    if (axis === "z") return s.setHeight(d.id, to);
    const from = axis === "x" ? dims.x : dims.y;
    if (!(from > 0)) return;
    const k = to / from;
    const drafts = new Map(s.drafts);
    drafts.set(d.id, { ...d, mesh: mapVerts(d.mesh, null, ([x, y, z]) => (axis === "x" ? [dims.cx + (x - dims.cx) * k, y, z] : [x, y, dims.cz + (z - dims.cz) * k])) });
    s.commit({ drafts });
  };

  return (
    <div>
      <div css={css({ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 })}>
        <h3 css={css({ margin: 0, fontSize: 17, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" })}>{name}</h3>
        <span css={css({ fontSize: 12, fontWeight: 600, color: STATUS[status].fg, flexShrink: 0 })}>{STATUS[status].label}</span>
      </div>
      <div css={[small, css({ marginTop: 2 })]}>{where}</div>

      {!d.deleted && (
        <>
          <div css={css({ marginTop: 12 })}>
            <span css={fieldLabel}>Dimensions</span>
            <NumberField label="X" value={dims.x} min={0.5} onCommit={(v) => resize("x", v)} />
            <NumberField label="Y" value={dims.y} min={0.5} onCommit={(v) => resize("y", v)} />
            <NumberField label="Z" value={dims.z} min={LIMITS.minHeight} max={LIMITS.maxHeight} onCommit={(v) => resize("z", v)} />
          </div>
          <div css={css({ marginTop: 12 })}>
            <span css={fieldLabel}>Levels</span>
            <NumberField label="" value={d.levels} step={1} min={1} max={LIMITS.maxLevels} unit="" onCommit={(v) => s.setLevels(d.id, v === null ? null : Math.round(v))} />
          </div>
          <div css={[small, css({ marginTop: 10 })]}>
            Footprint {footprint.toLocaleString("en")} m² · {d.mesh.verts.length / 3} vertices · {d.mesh.faces.length} faces
          </div>
          {errors.length === 0 ? (
            <div css={css({ display: "flex", gap: 6, alignItems: "center", marginTop: 8, fontSize: 13, color: "#16a34a" })}>
              <Check css={iconSize(14)} /> Closed solid, ready to submit
            </div>
          ) : (
            <div css={css({ marginTop: 8, fontSize: 13, color: UI.danger })}>
              <div css={css({ display: "flex", gap: 6, alignItems: "center", fontWeight: 600 })}>
                <AlertTriangle css={iconSize(14)} /> Can't be submitted yet
              </div>
              <ul css={css({ margin: "4px 0 0", paddingLeft: 18 })}>
                {errors.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
              {mode !== "object" && (
                <button
                  css={css({ marginTop: 4, border: "none", background: "none", padding: 0, color: UI.accent, fontSize: 13, fontWeight: 600, cursor: "pointer" })}
                  onClick={() => {
                    const elems = new Map(s.elems);
                    elems.set(d.id, nonManifold(d.mesh, mode as ElemMode));
                    s.setElems(elems);
                  }}
                >
                  Select the problems
                </button>
              )}
            </div>
          )}
          {(warnings.crossing.size > 0 || warnings.loose > 0) && (
            <div css={css({ marginTop: 8, fontSize: 13, color: UI.warn })}>
              {warnings.crossing.size > 0 && (
                <div css={css({ display: "flex", gap: 6, alignItems: "center" })}>
                  <AlertTriangle css={iconSize(14)} /> {warnings.crossing.size} faces cut through each other
                  <button
                    css={css({ marginLeft: "auto", border: "none", background: "none", padding: 0, color: UI.accent, fontSize: 13, fontWeight: 600, cursor: "pointer" })}
                    onClick={() => {
                      if (s.mode !== "face") s.setMode("face");
                      const elems = new Map(useEditStore.getState().elems);
                      elems.set(d.id, settle(d.mesh, { verts: new Set(), edges: new Set(), faces: new Set(warnings.crossing) }, "face"));
                      useEditStore.getState().setElems(elems);
                    }}
                  >
                    Select them
                  </button>
                </div>
              )}
              {warnings.loose > 0 && <div css={css({ marginTop: 2 })}>{warnings.loose} loose edges are left out when submitting</div>}
            </div>
          )}
        </>
      )}
      {status !== "unchanged" && (
        <button css={[pillButton, css({ marginTop: 12, height: 30, padding: "0 12px", fontSize: 13, fontWeight: 600, color: UI.text, backgroundColor: UI.control, gap: 6 })]} onClick={() => s.revert(d.id)}>
          <RotateCcw css={iconSize(14)} /> {d.kind === "create" ? "Remove this new building" : d.deleted ? "Bring it back" : "Revert to how it was"}
        </button>
      )}
    </div>
  );
}

/** the selection's middle in the element modes (relative to the building's footprint middle); typing moves it */
function SelectionMiddle({ d }: { d: Draft }) {
  const s = useEditStore.getState();
  const mode = useEditStore((st) => st.mode);
  const sel = useEditStore((st) => st.elems.get(d.id));
  if (mode === "object" || !sel || !sel.verts.size) return null;
  const c = centroidOf(d.mesh, sel.verts)!;
  const dims = dimensions(d);
  const shown = { x: c[0] - dims.cx, y: -(c[2] - dims.cz), z: c[1] };
  const moveTo = (axis: "x" | "y" | "z", v: number | null) => {
    if (v === null) return;
    const delta = v - shown[axis];
    const drafts = new Map(s.drafts);
    drafts.set(d.id, { ...d, mesh: mapVerts(d.mesh, sel.verts, ([x, y, z]) => (axis === "x" ? [x + delta, y, z] : axis === "y" ? [x, y, z - delta] : [x, Math.max(0, y + delta), z])) });
    s.commit({ drafts });
  };
  const count = mode === "vertex" ? sel.verts.size : mode === "edge" ? sel.edges.size : sel.faces.size;
  return (
    <div css={section}>
      <span css={fieldLabel}>
        {count} {mode === "vertex" ? "vertices" : mode === "edge" ? "edges" : "faces"} selected · middle
      </span>
      <NumberField label="X" value={shown.x} onCommit={(v) => moveTo("x", v)} />
      <NumberField label="Y" value={shown.y} onCommit={(v) => moveTo("y", v)} />
      <NumberField label="Z" value={shown.z} min={0} onCommit={(v) => moveTo("z", v)} />
    </div>
  );
}

function Changes() {
  const drafts = useEditStore((s) => s.drafts);
  const activeId = useEditStore((s) => s.activeId);
  const changed = changedDrafts({ drafts });
  const s = useEditStore.getState();
  if (!changed.length) return <p css={[small, css({ margin: 0, lineHeight: 1.5 })]}>No changes yet.</p>;
  return (
    <div>
      {changed.map((d) => {
        const { name, where } = draftTitle(d);
        const st = draftStatus(d);
        const bad = draftErrors(d).length > 0;
        return (
          <div
            key={d.id}
            css={css({
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "6px 8px",
              margin: "0 -8px",
              borderRadius: 10,
              backgroundColor: d.id === activeId ? UI.surfaceHover : "transparent",
            })}
          >
            <button
              css={css({ flex: 1, minWidth: 0, textAlign: "left", border: "none", background: "none", padding: 0, cursor: "pointer", color: UI.text })}
              onClick={() => {
                if (s.mode !== "object") s.setMode("object");
                s.select([d.id], false);
                editAction("frame");
              }}
            >
              <div css={css({ fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" })}>{name}</div>
              <div css={small}>
                <span css={css({ color: STATUS[st].fg, fontWeight: 600 })}>{STATUS[st].label}</span> · {where}
                {bad && <span css={css({ color: UI.danger })}> · needs fixing</span>}
              </div>
            </button>
            <button aria-label="Revert" title="Revert" css={[pillButton, css({ width: 26, minWidth: 26, height: 26, backgroundColor: "transparent" })]} onClick={() => s.revert(d.id)}>
              <RotateCcw css={iconSize(13)} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

export function EditPanel() {
  const active = useEditStore((s) => s.active);
  const activeId = useEditStore((s) => s.activeId);
  const drafts = useEditStore((s) => s.drafts);
  const count = changedDrafts({ drafts }).length;
  if (!active) return null;
  const d = activeId ? drafts.get(activeId) : undefined;
  return (
    <aside
      aria-label="Edit"
      css={[
        panel,
        css({
          position: "fixed",
          top: 94,
          right: UI.side + 44 + 10,
          width: 320,
          maxHeight: "calc(100vh - 178px)",
          overflowY: "auto",
          boxSizing: "border-box",
          borderRadius: 24,
          padding: "18px 20px 20px",
          zIndex: 23,
          [mobile]: { display: "none" },
        }),
      ]}
    >
      {d ? (
        <>
          <ActiveBuilding d={d} />
          <SelectionMiddle d={d} />
        </>
      ) : (
        <p css={[small, css({ margin: 0, lineHeight: 1.6 })]}>
          Click a building to edit it (Shift+click: several). <strong>Tab</strong> edits its vertices, edges and faces; <strong>G</strong>, <strong>R</strong>, <strong>S</strong> move, rotate and
          scale; <strong>Shift+A</strong> adds a building.
        </p>
      )}
      <div css={section}>
        <span css={fieldLabel}>Changes{count ? ` (${count})` : ""}</span>
        <Changes />
      </div>
    </aside>
  );
}
