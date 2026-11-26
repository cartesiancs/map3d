// Set height… (CONTRIBUTION-DESIGN.md §4.3): propose a new height for a building. The 3D view shows the new
// height while typing; the proposal goes to the review queue with a short English description.

import { css } from "@emotion/react";
import { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { useContribStore, pendingFor } from "@/state/contribStore";
import { useAuthStore } from "@/state/authStore";
import { ApiError, BuildingBase, Proposal, refOf, submitContribution } from "@/api/contributions";
import { fetchBuildings } from "@/api/osmSource";
import { LIMITS } from "@/contrib/validate";
import { tileManager } from "@/three/Space";
import { englishName, isEnglishText } from "@/utils/english";
import { UI, iconSize, mobile, panel, pillButton, primaryButton, spin } from "./styles";
import { useLastValue } from "./usePanel";

const COMMENT_MIN = 10;
const COMMENT_MAX = 500;
/** "≈ levels × 3 m" suggestion (the stored value is always meters) */
const LEVEL_M = 3;
const round1 = (v: number) => Math.round(v * 10) / 10;

export const fieldLabel = css({ display: "block", fontSize: 13, fontWeight: 600, color: UI.icon, marginBottom: 6 });
export const input = css({
  width: "100%",
  boxSizing: "border-box",
  height: 36,
  border: `1px solid ${UI.fieldBorder}`,
  borderRadius: 10,
  backgroundColor: UI.field,
  padding: "0 10px",
  fontSize: 15,
  [mobile]: { fontSize: 16 }, // no iOS zoom on focus
  color: UI.text,
  fontFamily: "inherit",
  ":focus": { outline: `2px solid ${UI.accent}`, outlineOffset: -1, borderColor: "transparent" },
});

export const sidePanel = (open: boolean) => [
  panel,
  css({
    position: "fixed",
    top: 94,
    right: UI.side,
    width: 372,
    maxHeight: "calc(100vh - 178px)",
    boxSizing: "border-box",
    borderRadius: 32,
    padding: "28px 28px 24px",
    zIndex: 21,
    display: "flex",
    flexDirection: "column",
    overflowY: "auto",
    transition: "opacity .2s, transform .2s",
    opacity: open ? 1 : 0,
    transform: open ? "none" : "translateX(24px)",
    pointerEvents: open ? "auto" : "none",
    [mobile]: { display: "none" }, // editing is desktop only
  }),
];

/** the building's footprint and tags as the tiles have them (OSM, or its approved edit) */
async function loadBase(key: string, index: number, id: number): Promise<BuildingBase | undefined> {
  if (id < 0) return undefined; // added buildings are known to the API already
  const box = tileManager.buildingLngLatBox(key, index);
  if (!box) return undefined;
  const f = (await fetchBuildings(box)).find((b) => b.type === "way" && b.id === id);
  if (!f) return undefined;
  return { footprint: f.parts[0][0].slice(0, -1), tags: f.tags };
}

export function HeightEditor() {
  const edit = useContribStore((s) => s.heightEdit);
  const close = useContribStore((s) => s.closeHeightEdit);
  const mine = useContribStore((s) => s.mine);
  const user = useAuthStore((s) => s.user);
  const [height, setHeight] = useState("");
  const [levels, setLevels] = useState("");
  const [comment, setComment] = useState("");
  const [accept, setAccept] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serverErrors, setServerErrors] = useState<string[]>([]);

  // while the panel fades out it keeps showing the building it was editing
  const shown = useLastValue(edit);
  const ref = shown ? refOf(shown.id) : "";
  const pending = shown ? pendingFor(mine, ref) : undefined;
  const startLevels = shown?.tags["building:levels"] ?? "";

  // start from my pending proposal for this building, else from what is shown
  useEffect(() => {
    if (!edit) return;
    setHeight(String(pending?.proposal.height ?? round1(edit.height)));
    setLevels(pending?.proposal.levels != null ? String(pending.proposal.levels) : /^\d+$/.test(startLevels) ? startLevels : "");
    setComment(pending?.comment ?? "");
    setAccept(false);
    setServerErrors([]);
  }, [edit]); // eslint-disable-line react-hooks/exhaustive-deps

  const h = Number(height);
  const lv = levels.trim() === "" ? null : Number(levels);
  const heightOk = height.trim() !== "" && Number.isFinite(h) && h >= LIMITS.minHeight && h <= LIMITS.maxHeight;
  const levelsOk = lv === null || (Number.isInteger(lv) && lv >= 1 && lv <= LIMITS.maxLevels);

  // live preview in the 3D view
  useEffect(() => {
    if (!edit) return;
    tileManager.previewHeight({ key: edit.key, index: edit.index }, heightOk ? h : null);
  }, [edit, h, heightOk]);
  useEffect(() => {
    if (!edit) tileManager.previewHeight(null, null);
  }, [edit]);
  useEffect(() => () => tileManager.previewHeight(null, null), []);

  const proposal = useMemo<Proposal>(() => {
    if (!edit) return {};
    const p: Proposal = {};
    if (heightOk && Math.abs(h - edit.height) >= 0.05) p.height = round1(h);
    if (levelsOk && lv !== null && String(lv) !== startLevels) p.levels = lv;
    return p;
  }, [edit, h, heightOk, lv, levelsOk, startLevels]);

  const problems: string[] = [];
  if (!heightOk) problems.push(`Height must be between ${LIMITS.minHeight} and ${LIMITS.maxHeight} m`);
  if (!levelsOk) problems.push(`Levels must be a whole number from 1 to ${LIMITS.maxLevels}`);
  if (heightOk && levelsOk && !Object.keys(proposal).length) problems.push("Change the height or the levels");
  const commentOk = comment.trim().length >= COMMENT_MIN && comment.trim().length <= COMMENT_MAX && isEnglishText(comment.trim());
  const needsTerms = !!user && !user.acceptedTerms;
  const canSubmit = !busy && !problems.length && commentOk && (!needsTerms || accept);

  const submit = async () => {
    if (!edit || !canSubmit) return;
    setBusy(true);
    setServerErrors([]);
    try {
      const base = await loadBase(edit.key, edit.index, edit.id);
      await submitContribution({ ref, base, proposal, comment: comment.trim(), ...(needsTerms ? { acceptTerms: true } : {}) });
      if (needsTerms) useAuthStore.getState().setAcceptedTerms();
      useAuthStore.getState().notify("Sent for review. Thank you!");
      await useContribStore.getState().loadMine();
      if (useAuthStore.getState().user?.isAdmin) useContribStore.getState().loadQueue();
      close();
    } catch (err) {
      setServerErrors(err instanceof ApiError && err.errors.length ? err.errors : [err instanceof Error ? err.message : String(err)]);
    } finally {
      setBusy(false);
    }
  };

  const max = Math.max(300, Math.ceil(((shown?.height ?? 0) * 2) / 50) * 50);
  const name = shown ? englishName(shown.tags) : null;
  const levelHint = lv !== null && levelsOk ? lv * LEVEL_M : null;

  return (
    <aside aria-label="Set height" aria-hidden={!edit} css={sidePanel(!!edit)} onKeyDown={(e) => e.key === "Escape" && close()}>
      <h2 css={css({ margin: 0, fontSize: 22, fontWeight: 600 })}>Set height</h2>
      <p css={css({ margin: "4px 0 0", fontSize: 14, color: UI.icon })}>
        {name ?? "Building"} · now {shown ? round1(shown.height) : ""} m
        {pending && " · your proposal is waiting for review"}
      </p>

      <label css={css({ marginTop: 22 })}>
        <span css={fieldLabel}>Height (m)</span>
        <div css={css({ display: "flex", gap: 10, alignItems: "center" })}>
          <input
            css={[input, css({ width: 96, flexShrink: 0 })]}
            type="number"
            inputMode="decimal"
            min={LIMITS.minHeight}
            max={LIMITS.maxHeight}
            step={0.5}
            value={height}
            onChange={(e) => setHeight(e.target.value)}
            autoFocus
          />
          <input
            aria-label="Height slider"
            type="range"
            min={LIMITS.minHeight}
            max={max}
            step={0.5}
            value={heightOk ? Math.min(h, max) : LIMITS.minHeight}
            onChange={(e) => setHeight(e.target.value)}
            css={css({ flex: 1, accentColor: UI.accent })}
          />
        </div>
      </label>

      <label css={css({ marginTop: 16 })}>
        <span css={fieldLabel}>Levels (optional)</span>
        <div css={css({ display: "flex", gap: 10, alignItems: "center" })}>
          <input
            css={[input, css({ width: 96, flexShrink: 0 })]}
            type="number"
            inputMode="numeric"
            min={1}
            max={LIMITS.maxLevels}
            step={1}
            value={levels}
            onChange={(e) => setLevels(e.target.value)}
          />
          {levelHint !== null && (
            <button
              type="button"
              onClick={() => setHeight(String(levelHint))}
              css={css({ border: "none", background: "none", padding: 0, color: UI.accent, fontSize: 13, fontWeight: 600, cursor: "pointer" })}
            >
              Use ≈ {lv} × {LEVEL_M} m = {levelHint} m
            </button>
          )}
        </div>
      </label>

      <label css={css({ marginTop: 16 })}>
        <span css={fieldLabel}>What is your source? (English)</span>
        <textarea
          css={[input, css({ height: 84, padding: "8px 10px", resize: "vertical", lineHeight: 1.35 })]}
          maxLength={COMMENT_MAX}
          placeholder="e.g. Measured from the city's 3D survey"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
        />
        {comment.trim() !== "" && !commentOk && (
          <span css={css({ display: "block", marginTop: 4, fontSize: 12, color: UI.warn })}>
            At least {COMMENT_MIN} characters, English only.
          </span>
        )}
      </label>

      {needsTerms && (
        <label css={css({ display: "flex", gap: 8, alignItems: "flex-start", marginTop: 14, fontSize: 13, lineHeight: 1.4 })}>
          <input type="checkbox" checked={accept} onChange={(e) => setAccept(e.target.checked)} css={css({ marginTop: 2, accentColor: UI.accent })} />
          <span>
            I agree that my contributions are published under the{" "}
            <a href="https://opendatacommons.org/licenses/odbl/1-0/" target="_blank" rel="noreferrer" css={css({ color: UI.accent })}>
              ODbL 1.0
            </a>
            , like OpenStreetMap data.
          </span>
        </label>
      )}

      {[...problems, ...serverErrors].length > 0 && (
        <ul css={css({ margin: "14px 0 0", padding: "0 0 0 18px", fontSize: 13, color: UI.danger })}>
          {[...problems, ...serverErrors].map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}

      <div css={css({ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 20 })}>
        <button css={[pillButton, css({ padding: "0 16px", fontSize: 14, fontWeight: 600, color: UI.text, backgroundColor: UI.control })]} onClick={close}>
          Cancel
        </button>
        <button css={[primaryButton, css({ padding: "0 18px" })]} disabled={!canSubmit} onClick={submit}>
          {busy && <Loader2 css={[iconSize(15), css({ animation: `${spin} 1s linear infinite` })]} />}
          Submit for review
        </button>
      </div>
      <p css={css({ margin: "12px 0 0", fontSize: 12, color: UI.placeholder })}>An admin checks every change before it appears for everyone.</p>
    </aside>
  );
}
