// Edit mode dialogs. Contribute: every changed building with what changes, the source of the change
// (English), the ODbL agreement on a first contribution, then one changeset for review. Exit: discard the
// changes, keep them on this device for later, or go back to editing.

import { css } from "@emotion/react";
import { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { ApiError, describeItem, submitChangeset } from "@/api/changesets";
import { Draft, changesetErrors, draftErrors, draftStatus, draftWarnings, toItem } from "@/edit/drafts";
import { changedDrafts, useEditStore } from "@/state/editStore";
import { useAuthStore } from "@/state/authStore";
import { useContribStore } from "@/state/contribStore";
import { refreshOverlay } from "@/three/Space";
import { isEnglishText } from "@/utils/english";
import { UI, fieldLabel, iconSize, input, panel, pillButton, primaryButton, spin } from "@/components/ui/styles";
import { draftTitle } from "./EditPanel";

const COMMENT_MIN = 10;
const COMMENT_MAX = 500;

const scrim = css({ position: "fixed", inset: 0, zIndex: 50, backgroundColor: UI.scrim, display: "flex", alignItems: "center", justifyContent: "center" });
const box = css([panel, css({ width: 460, maxWidth: "calc(100vw - 32px)", maxHeight: "calc(100vh - 64px)", overflowY: "auto", boxSizing: "border-box", borderRadius: 28, padding: "24px 26px 22px" })]);
const secondary = css([pillButton, css({ padding: "0 16px", fontSize: 14, fontWeight: 600, color: UI.text, backgroundColor: UI.control })]);

function summary(d: Draft) {
  const item = toItem(d);
  return describeItem({ kind: item.kind, fields: Object.keys(item.proposal ?? {}).map((k) => (k === "mesh" || k === "footprint" ? "shape" : k)) });
}

function ContributeDialog() {
  const drafts = useEditStore((s) => s.drafts);
  const supersedes = useEditStore((s) => s.supersedes);
  const user = useAuthStore((s) => s.user);
  const [comment, setComment] = useState("");
  const [accept, setAccept] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const changed = changedDrafts({ drafts });
  const broken = changed.filter((d) => draftErrors(d).length);
  const whole = useMemo(() => changesetErrors(changed), [drafts]); // eslint-disable-line react-hooks/exhaustive-deps
  const needsTerms = !!user && !user.acceptedTerms;
  const text = comment.trim();
  const commentOk = text.length >= COMMENT_MIN && text.length <= COMMENT_MAX && isEnglishText(text);
  const canSubmit = !busy && changed.length > 0 && !whole.length && !broken.length && commentOk && (!needsTerms || accept);
  const close = () => useEditStore.getState().setDialog(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !busy && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy]);

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setErrors([]);
    try {
      await submitChangeset({ items: changed.map(toItem), comment: text, ...(supersedes.length ? { supersedes } : {}), ...(needsTerms ? { acceptTerms: true } : {}) });
      if (needsTerms) useAuthStore.getState().setAcceptedTerms();
      useEditStore.getState().finish();
      useAuthStore.getState().notify("Sent for review. Thank you!");
      await useContribStore.getState().loadMine();
      if (useAuthStore.getState().user?.isAdmin) useContribStore.getState().loadQueue();
      refreshOverlay();
    } catch (err) {
      if (err instanceof ApiError && err.code === "stale") setErrors([`${err.message} (${err.refs.join(", ")})`]);
      else setErrors(err instanceof ApiError && err.errors.length ? err.errors : [err instanceof Error ? err.message : String(err)]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div css={scrim} onPointerDown={(e) => e.target === e.currentTarget && !busy && close()}>
      <div role="dialog" aria-modal aria-label="Contribute" css={box}>
        <h2 css={css({ margin: 0, fontSize: 22, fontWeight: 600 })}>Contribute</h2>
        <p css={css({ margin: "4px 0 0", fontSize: 14, color: UI.icon })}>
          {changed.length} {changed.length === 1 ? "building" : "buildings"} go to review together. An admin checks them before they appear for everyone.
        </p>

        <div css={css({ marginTop: 16 })}>
          {changed.map((d) => {
            const { name, where } = draftTitle(d);
            const bad = draftErrors(d);
            const warn = draftWarnings(d);
            return (
              <div key={d.id} css={css({ padding: "8px 0", borderTop: `1px solid ${UI.line}` })}>
                <div css={css({ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 14 })}>
                  <span css={css({ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" })}>{name}</span>
                  <span css={css({ color: draftStatus(d) === "deleted" ? UI.danger : UI.icon, flexShrink: 0 })}>{summary(d)}</span>
                </div>
                <div css={css({ fontSize: 12, color: UI.icon })}>{where}</div>
                {bad.length > 0 && <div css={css({ fontSize: 12, color: UI.danger, marginTop: 2 })}>{bad[0]}</div>}
                {warn.crossing.size > 0 && <div css={css({ fontSize: 12, color: UI.warn, marginTop: 2 })}>{warn.crossing.size} faces cut through each other (it can still be sent)</div>}
              </div>
            );
          })}
        </div>
        {whole.map((e) => (
          <p key={e} css={css({ margin: "10px 0 0", fontSize: 13, color: UI.danger })}>
            {e}
          </p>
        ))}
        {supersedes.length > 0 && <p css={css({ margin: "10px 0 0", fontSize: 13, color: UI.pendingFg })}>This replaces your proposal that is waiting for review.</p>}

        <label css={css({ display: "block", marginTop: 16 })}>
          <span css={fieldLabel}>What is your source? (English)</span>
          <textarea
            css={[input, css({ height: 84, padding: "8px 10px", resize: "vertical", lineHeight: 1.35 })]}
            maxLength={COMMENT_MAX}
            placeholder="e.g. Measured on site, roof shape from the city's 3D survey"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            autoFocus
          />
          {text !== "" && !commentOk && <span css={css({ display: "block", marginTop: 4, fontSize: 12, color: UI.warn })}>At least {COMMENT_MIN} characters, English only.</span>}
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

        {broken.length > 0 && <p css={css({ margin: "12px 0 0", fontSize: 13, color: UI.danger })}>Fix the buildings marked above first (each must be a closed solid).</p>}
        {errors.length > 0 && (
          <ul css={css({ margin: "12px 0 0", padding: "0 0 0 18px", fontSize: 13, color: UI.danger })}>
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        )}

        <div css={css({ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 20 })}>
          <button css={secondary} onClick={close} disabled={busy}>
            Keep editing
          </button>
          <button css={[primaryButton, css({ padding: "0 18px", backgroundColor: UI.contribute, color: UI.contributeFg, ":hover": { backgroundColor: UI.contributeHover } })]} disabled={!canSubmit} onClick={submit}>
            {busy && <Loader2 css={[iconSize(15), css({ animation: `${spin} 1s linear infinite` })]} />}
            Submit for review
          </button>
        </div>
      </div>
    </div>
  );
}

function ExitDialog() {
  const count = useEditStore((s) => changedDrafts(s).length);
  const s = useEditStore.getState();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && s.setDialog(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [s]);
  return (
    <div css={scrim} onPointerDown={(e) => e.target === e.currentTarget && s.setDialog(null)}>
      <div role="alertdialog" aria-modal aria-label="Leave Edit mode" css={[box, css({ width: 400 })]}>
        <h2 css={css({ margin: 0, fontSize: 20, fontWeight: 600 })}>Leave Edit mode?</h2>
        <p css={css({ margin: "8px 0 0", fontSize: 14, lineHeight: 1.45, color: UI.icon })}>
          {count} {count === 1 ? "building has" : "buildings have"} changes that were not submitted.
        </p>
        <div css={css({ display: "flex", justifyContent: "flex-end", flexWrap: "wrap", gap: 8, marginTop: 20 })}>
          <button css={secondary} onClick={() => s.setDialog(null)}>
            Keep editing
          </button>
          <button css={secondary} onClick={() => s.exit(true)} title="Offered again the next time you open Edit mode on this device">
            Keep for later
          </button>
          <button css={[primaryButton, css({ padding: "0 16px", backgroundColor: "#dc2626", ":hover": { backgroundColor: "#b91c1c" } })]} onClick={() => s.exit()}>
            Discard
          </button>
        </div>
      </div>
    </div>
  );
}

export function EditDialogs() {
  const dialog = useEditStore((s) => s.dialog);
  if (dialog === "contribute") return <ContributeDialog />;
  if (dialog === "exit") return <ExitDialog />;
  return null;
}
