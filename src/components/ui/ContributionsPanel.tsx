// "My contributions" (everyone signed in) and the "Review queue" (admins), CONTRIBUTION-DESIGN.md §4.5–4.6.
// Both list changesets (Edit mode proposals) in one panel on the left. Picking one flies the camera there
// and draws it in the 3D view (reviewOverlay): each building as it is, semi-transparent grey, and as
// proposed, semi-transparent red; a removed building in red with dashed edges; a move as an arrow.

import { css } from "@emotion/react";
import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Check, Eye, EyeOff, Loader2, MapPin, Pencil, SkipForward, X } from "lucide-react";
import { useContribStore } from "@/state/contribStore";
import { useAuthStore } from "@/state/authStore";
import { useEditStore } from "@/state/editStore";
import {
  ApiError,
  Changeset,
  ChangesetDetail,
  ItemDetail,
  Status,
  approveChangeset,
  buildingIdOf,
  describeChangeset,
  describeItem,
  fetchChangeset,
  rejectChangeset,
  withdrawChangeset,
} from "@/api/changesets";
import { goToPlace, refreshOverlay, reviewOverlay } from "@/three/Space";
import type { ReviewShape, ReviewView } from "@/three/edit/ReviewOverlay";
import { H_UNIT_M, M_PER_DEG } from "@/three/tiles/geo";
import { ItemDiff, itemDiff, itemShapes, shapeCenter } from "@/edit/review";
import { englishName } from "@/utils/english";
import { UI, fieldLabel, iconSize, input, mobile, panel, pillButton, primaryButton, spin } from "./styles";
import { useLastValue, usePresence } from "./usePanel";

const STATUS: Record<Status, { label: string; bg: string; fg: string }> = {
  pending: { label: "Pending", bg: UI.pendingBg, fg: UI.pendingFg },
  conflict: { label: "Needs review", bg: "#fee2e2", fg: "#991b1b" },
  approved: { label: "Approved", bg: "#dcfce7", fg: "#166534" },
  rejected: { label: "Rejected", bg: "#f4f4f5", fg: "#52525b" },
  withdrawn: { label: "Withdrawn", bg: "#f4f4f5", fg: "#71717a" },
};

const chip = (s: Status) =>
  css({ display: "inline-block", padding: "1px 8px", borderRadius: 9, fontSize: 11, fontWeight: 600, backgroundColor: STATUS[s].bg, color: STATUS[s].fg, flexShrink: 0 });
const small = css({ fontSize: 12, color: UI.icon });
const linkButton = css({
  border: "none",
  background: "none",
  padding: 0,
  color: UI.accent,
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  ":disabled": { opacity: 0.5, cursor: "default" },
});
const card = css({ backgroundColor: UI.card, borderRadius: 16, padding: "12px 14px", marginTop: 10 });
const secondary = css([pillButton, css({ padding: "0 14px", fontSize: 14, fontWeight: 600, color: UI.text, backgroundColor: UI.control })]);
const date = (iso: string) => new Date(iso).toLocaleDateString("en", { year: "numeric", month: "short", day: "numeric" });

/** camera over the whole changeset */
function showChangeset(c: Pick<Changeset, "bbox" | "lat" | "lng">) {
  const [w, s, e, n] = c.bbox;
  const spanM = Math.max((e - w) * M_PER_DEG * Math.cos((c.lat * Math.PI) / 180), (n - s) * M_PER_DEG);
  goToPlace(c.lat, c.lng, Math.max(320, (spanM / H_UNIT_M) * 2 + 160));
}

/** the shapes of every item, for the overlay */
function shapesOf(detail: ChangesetDetail): ReviewShape[] {
  return detail.items.map((i) => {
    const s = itemShapes(i);
    return { id: buildingIdOf(i.ref), kind: i.kind, before: s.before, after: s.after };
  });
}

/** load a changeset in full (cached while the panel is open) */
const details = new Map<string, Promise<ChangesetDetail>>();
const loadDetail = (id: string, fresh = false) => {
  if (fresh || !details.has(id)) details.set(id, fetchChangeset(id).catch((err) => (details.delete(id), Promise.reject(err))));
  return details.get(id)!;
};

function itemTitle(i: ItemDetail) {
  const name = englishName(i.base?.tags ?? {}) ?? i.current?.name ?? null;
  const id = buildingIdOf(i.ref);
  const where = id === null ? "New building" : id < 0 ? "Added on map3d" : `OSM way ${id}`;
  return name ? `${name} · ${where}` : where;
}

/** "a → b" for one number */
function Change({ label, before, after, unit = "" }: { label: string; before: number | null; after: number | null; unit?: string }) {
  if (before === after || (before === null && after === null)) return null;
  const f = (v: number | null) => (v === null ? "—" : `${v.toLocaleString("en")}${unit}`);
  return (
    <div css={css({ display: "flex", justifyContent: "space-between", fontSize: 13, padding: "2px 0" })}>
      <span css={css({ color: UI.icon })}>{label}</span>
      <span>
        <span css={css({ color: UI.icon })}>{f(before)}</span> → <strong>{f(after)}</strong>
      </span>
    </div>
  );
}

function Diff({ d }: { d: ItemDiff }) {
  return (
    <div css={css({ marginTop: 4 })}>
      <Change label="Height" before={d.heightBefore} after={d.heightAfter} unit=" m" />
      <Change label="Footprint" before={d.areaBefore} after={d.areaAfter} unit=" m²" />
      {d.movedM !== null && d.movedM >= 0.1 && (
        <div css={css({ display: "flex", justifyContent: "space-between", fontSize: 13, padding: "2px 0" })}>
          <span css={css({ color: UI.icon })}>Moved</span>
          <strong>{d.movedM} m</strong>
        </div>
      )}
      <Change label="Vertices" before={d.vertsBefore} after={d.vertsAfter} />
      <Change label="Faces" before={d.facesBefore} after={d.facesAfter} />
    </div>
  );
}

/** every building of a changeset with what changes; clicking one flies there */
function Items({ detail }: { detail: ChangesetDetail }) {
  const rows = useMemo(() => detail.items.map((i) => ({ item: i, shapes: itemShapes(i) })), [detail]);
  return (
    <div css={css({ marginTop: 8 })}>
      {rows.map(({ item, shapes }) => {
        const where = shapes.after ?? shapes.before;
        return (
          <button
            key={item.seq}
            onClick={() => {
              if (!where) return;
              const [lng, lat] = shapeCenter(where);
              goToPlace(lat, lng, 220);
            }}
            css={css({
              display: "block",
              width: "100%",
              textAlign: "left",
              border: "none",
              borderTop: `1px solid ${UI.line}`,
              background: "none",
              padding: "8px 0",
              cursor: "pointer",
              color: UI.text,
            })}
          >
            <div css={css({ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 13 })}>
              <span css={css({ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" })}>{itemTitle(item)}</span>
              <span css={css({ color: item.kind === "delete" ? UI.danger : UI.icon, flexShrink: 0 })}>{describeItem(item)}</span>
            </div>
            {item.stale && <div css={css({ fontSize: 12, color: UI.danger, marginTop: 2 })}>Changed since this was proposed</div>}
            <Diff d={itemDiff(shapes)} />
          </button>
        );
      })}
    </div>
  );
}

function ViewToggle({ view, onChange }: { view: ReviewView; onChange: (v: ReviewView) => void }) {
  const options: [ReviewView, string][] = [
    ["before", "Before"],
    ["after", "After"],
    ["both", "Both"],
  ];
  return (
    <div role="radiogroup" aria-label="Show" css={css({ display: "flex", backgroundColor: UI.line, borderRadius: 10, padding: 2, marginTop: 10 })}>
      {options.map(([v, label]) => (
        <button
          key={v}
          role="radio"
          aria-checked={view === v}
          onClick={() => onChange(v)}
          css={css({
            flex: 1,
            height: 26,
            border: "none",
            borderRadius: 8,
            fontSize: 12,
            fontWeight: 600,
            cursor: "pointer",
            color: UI.text,
            backgroundColor: view === v ? UI.raised : "transparent",
          })}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/** draw a changeset on the map while `id` is set */
function usePreview(id: string | null, view: ReviewView) {
  const [detail, setDetail] = useState<ChangesetDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setDetail(null);
    setError(null);
    if (!id) {
      reviewOverlay.show(null);
      return;
    }
    let live = true;
    loadDetail(id).then(
      (d) => {
        if (!live) return;
        setDetail(d);
        reviewOverlay.show(shapesOf(d));
      },
      (err) => live && setError(err instanceof Error ? err.message : String(err)),
    );
    return () => {
      live = false;
    };
  }, [id]);
  useEffect(() => reviewOverlay.setView(view), [view]);
  useEffect(() => () => reviewOverlay.show(null), []);
  return { detail, error };
}

function MyContributions() {
  const mine = useContribStore((s) => s.mine);
  const loadMine = useContribStore((s) => s.loadMine);
  const [busy, setBusy] = useState<string | null>(null);
  const [shown, setShown] = useState<string | null>(null);
  const [view, setView] = useState<ReviewView>("both");
  const { detail, error } = usePreview(shown, view);

  const withdraw = async (c: Changeset) => {
    setBusy(c.id);
    try {
      await withdrawChangeset(c.id);
      if (shown === c.id) setShown(null);
      await loadMine();
    } catch (err) {
      useAuthStore.getState().notify(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const edit = async (c: Changeset) => {
    setBusy(c.id);
    try {
      const d = await loadDetail(c.id, true);
      setShown(null);
      useContribStore.getState().setPanel(null);
      await useEditStore.getState().reopen(d);
    } catch (err) {
      useAuthStore.getState().notify(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  if (!mine.length) {
    return <p css={[small, css({ marginTop: 16, lineHeight: 1.5 })]}>Nothing yet. Right-click a building and choose “Edit height” or “Edit shape” to suggest a change.</p>;
  }
  return (
    <div>
      {mine.map((c) => {
        const open = c.status === "pending" || c.status === "conflict";
        return (
          <div key={c.id} css={card}>
            <div css={css({ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 })}>
              <span css={css({ fontSize: 14, fontWeight: 600 })}>{describeChangeset(c)}</span>
              <span css={chip(c.status)}>{STATUS[c.status].label}</span>
            </div>
            <div css={[small, css({ marginTop: 4 })]}>
              {date(c.createdAt)}
              {c.supersededBy && " · replaced by a newer proposal"}
            </div>
            {c.reviewNote && <div css={css({ marginTop: 6, fontSize: 13 })}>Reviewer: {c.reviewNote}</div>}
            <div css={css({ display: "flex", gap: 14, marginTop: 8 })}>
              <button
                css={linkButton}
                onClick={() => {
                  if (shown === c.id) return setShown(null);
                  setShown(c.id);
                  showChangeset(c);
                }}
              >
                {shown === c.id ? <EyeOff css={iconSize(13)} /> : <Eye css={iconSize(13)} />} {shown === c.id ? "Hide" : "Show"}
              </button>
              <button css={linkButton} onClick={() => showChangeset(c)}>
                <MapPin css={iconSize(13)} /> Go there
              </button>
              {open && (
                <>
                  <button css={linkButton} disabled={busy === c.id} onClick={() => edit(c)} title="Open it in Edit mode: submitting again replaces it">
                    <Pencil css={iconSize(13)} /> Edit
                  </button>
                  <button css={linkButton} disabled={busy === c.id} onClick={() => withdraw(c)}>
                    Withdraw
                  </button>
                </>
              )}
            </div>
            {shown === c.id && (
              <>
                <ViewToggle view={view} onChange={setView} />
                {error && <div css={css({ marginTop: 8, fontSize: 13, color: UI.danger })}>{error}</div>}
                {detail ? <Items detail={detail} /> : !error && <Loader2 css={[iconSize(15), css({ marginTop: 10, animation: `${spin} 1s linear infinite` })]} />}
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ReviewQueue() {
  const queue = useContribStore((s) => s.queue);
  const loadQueue = useContribStore((s) => s.loadQueue);
  const [index, setIndex] = useState(0);
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<ReviewView>("both");
  const item = queue[Math.min(index, queue.length - 1)];
  const { detail, error: loadError } = usePreview(item?.id ?? null, view);

  // fly over the changeset
  useEffect(() => {
    setRejecting(false);
    setNote("");
    setError(null);
    if (item) showChangeset(item);
  }, [item?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const stale = !!(detail?.stale || item?.stale || item?.status === "conflict");

  const decide = async (action: "approve" | "reject") => {
    if (!item || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (action === "approve") {
        await approveChangeset(item.id, stale);
        reviewOverlay.show(null);
        refreshOverlay(); // show the published change right away
        useAuthStore.getState().notify("Approved: now live for everyone");
      } else {
        await rejectChangeset(item.id, note.trim());
        useAuthStore.getState().notify("Rejected");
      }
      details.delete(item.id);
      await loadQueue();
    } catch (err) {
      setError(err instanceof ApiError || err instanceof Error ? err.message : String(err));
      if (err instanceof ApiError && err.code === "conflict") {
        details.delete(item.id);
        await loadQueue();
      }
    } finally {
      setBusy(false);
    }
  };

  // A approve · R reject · S skip (not while typing)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if ((t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) || e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k !== "a" && k !== "r" && k !== "s") return;
      e.preventDefault(); // the key must not land in the reason box that R focuses
      if (k === "a") decide("approve");
      else if (k === "r") setRejecting(true);
      else setIndex((i) => (queue.length ? (i + 1) % queue.length : 0));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!item) return <p css={[small, css({ marginTop: 16 })]}>The queue is empty.</p>;
  const since = item.author.githubSince ? new Date(item.author.githubSince).getFullYear() : null;

  return (
    <div>
      <div css={[small, css({ marginTop: 4 })]}>
        {Math.min(index, queue.length - 1) + 1} of {queue.length} · oldest first
      </div>
      <div css={card}>
        <div css={css({ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 })}>
          <span css={css({ fontSize: 15, fontWeight: 600 })}>{describeChangeset(item)}</span>
          <span css={chip(item.status)}>{STATUS[item.status].label}</span>
        </div>
        <div css={[small, css({ marginTop: 2 })]}>
          {item.items.length} {item.items.length === 1 ? "building" : "buildings"} · {date(item.createdAt)}
        </div>
        <blockquote css={css({ margin: "10px 0 0", padding: "6px 10px", borderLeft: `3px solid ${UI.fieldBorder}`, fontSize: 13, lineHeight: 1.4 })}>{item.comment}</blockquote>
        <div css={[small, css({ marginTop: 8 })]}>
          @{item.author.login}
          {since && ` · on GitHub since ${since}`} · {item.author.approved} of {item.author.reviewed} approved before
        </div>
        <ViewToggle view={view} onChange={setView} />
        {loadError && <div css={css({ marginTop: 8, fontSize: 13, color: UI.danger })}>{loadError}</div>}
        {detail ? <Items detail={detail} /> : !loadError && <Loader2 css={[iconSize(15), css({ marginTop: 10, animation: `${spin} 1s linear infinite` })]} />}
        {stale && (
          <div css={css({ display: "flex", gap: 6, marginTop: 10, fontSize: 13, color: UI.danger })}>
            <AlertTriangle css={iconSize(15)} />
            Some buildings changed after this was proposed. Approving applies only the changes listed.
          </div>
        )}
      </div>

      {rejecting && (
        <label css={css({ display: "block", marginTop: 12 })}>
          <span css={fieldLabel}>Reason (shown to the contributor)</span>
          <textarea css={[input, css({ height: 64, padding: "8px 10px", resize: "vertical" })]} value={note} onChange={(e) => setNote(e.target.value)} autoFocus />
        </label>
      )}
      {error && <div css={css({ marginTop: 10, fontSize: 13, color: UI.danger })}>{error}</div>}

      <div css={css({ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" })}>
        {rejecting ? (
          <>
            <button css={secondary} onClick={() => setRejecting(false)}>
              Back
            </button>
            <button
              css={[primaryButton, css({ padding: "0 16px", backgroundColor: "#dc2626", ":hover": { backgroundColor: "#b91c1c" } })]}
              disabled={busy || note.trim().length < 3}
              onClick={() => decide("reject")}
            >
              Reject
            </button>
          </>
        ) : (
          <>
            <button css={[primaryButton, css({ padding: "0 16px" })]} disabled={busy} onClick={() => decide("approve")} title="Approve (A)">
              {busy ? <Loader2 css={[iconSize(15), css({ animation: `${spin} 1s linear infinite` })]} /> : <Check css={iconSize(15)} />}
              {stale ? "Approve anyway" : "Approve"}
            </button>
            <button css={secondary} onClick={() => setRejecting(true)} title="Reject (R)">
              <X css={iconSize(15)} /> Reject
            </button>
            <button css={secondary} onClick={() => setIndex((i) => (i + 1) % queue.length)} disabled={queue.length < 2} title="Skip (S)">
              <SkipForward css={iconSize(15)} /> Skip
            </button>
          </>
        )}
      </div>
    </div>
  );
}

export function ContributionsPanel() {
  const panelKind = useContribStore((s) => s.panel);
  const setPanel = useContribStore((s) => s.setPanel);
  const isAdmin = useAuthStore((s) => s.user?.isAdmin ?? false);
  const open = panelKind === "mine" || (panelKind === "review" && isAdmin);
  // while it fades out the panel keeps its title and list (no flash of the other or empty state)
  const kind = useLastValue(panelKind);
  const mounted = usePresence(open);

  useEffect(() => {
    if (panelKind === "mine") useContribStore.getState().loadMine();
    if (panelKind === "review") useContribStore.getState().loadQueue();
    if (!panelKind) details.clear();
  }, [panelKind]);

  return (
    <aside
      aria-label={kind === "review" ? "Review queue" : "My contributions"}
      aria-hidden={!open}
      css={[
        panel,
        css({
          position: "fixed",
          top: UI.top + UI.barHeight + 8,
          left: UI.sideLeft,
          width: 372,
          maxHeight: `calc(100vh - ${UI.top + UI.barHeight + 8 + 60}px)`,
          overflowY: "auto",
          boxSizing: "border-box",
          borderRadius: 24,
          padding: "20px 22px 22px",
          zIndex: 22,
          transition: "opacity .2s, transform .2s",
          opacity: open ? 1 : 0,
          transform: open ? "none" : "translateX(-24px)",
          pointerEvents: open ? "auto" : "none",
          [mobile]: { left: 12, right: 12, width: "auto", top: 76 },
        }),
      ]}
    >
      <div css={css({ display: "flex", justifyContent: "space-between", alignItems: "center" })}>
        <h2 css={css({ margin: 0, fontSize: 20, fontWeight: 600 })}>{kind === "review" ? "Review queue" : "My contributions"}</h2>
        <button aria-label="Close" css={[pillButton, css({ width: 30, minWidth: 30, height: 30, backgroundColor: "transparent" })]} onClick={() => setPanel(null)}>
          <X css={iconSize(16)} />
        </button>
      </div>
      {mounted && (kind === "review" && isAdmin ? <ReviewQueue /> : <MyContributions />)}
    </aside>
  );
}
