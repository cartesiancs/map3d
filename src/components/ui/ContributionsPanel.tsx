// "My contributions" (everyone signed in) and the "Review queue" (admins), CONTRIBUTION-DESIGN.md §4.5–4.6.
// Both live in one panel on the left; picking an item flies the camera there. In the review queue the proposed
// height is drawn in the 3D view, so the admin sees the change before approving it.

import { css } from "@emotion/react";
import { useEffect, useState } from "react";
import { AlertTriangle, Check, Loader2, MapPin, SkipForward, X } from "lucide-react";
import { useContribStore } from "@/state/contribStore";
import { useAuthStore } from "@/state/authStore";
import {
  ApiError,
  Contribution,
  ReviewItem,
  Status,
  approveContribution,
  describeProposal,
  rejectContribution,
  withdrawContribution,
} from "@/api/contributions";
import { goToPlace, refreshOverlay, tileManager } from "@/three/Space";
import { buildingHeight } from "@/three/tiles/geo";
import { englishName } from "@/utils/english";
import { UI, iconSize, mobile, panel, pillButton, primaryButton, spin } from "./styles";
import { fieldLabel, input } from "./HeightEditor";

const STATUS: Record<Status, { label: string; bg: string; fg: string }> = {
  pending: { label: "Pending", bg: "#fef3c7", fg: "#92400e" },
  conflict: { label: "Needs review", bg: "#fee2e2", fg: "#991b1b" },
  approved: { label: "Approved", bg: "#dcfce7", fg: "#166534" },
  rejected: { label: "Rejected", bg: "#f4f4f5", fg: "#52525b" },
  withdrawn: { label: "Withdrawn", bg: "#f4f4f5", fg: "#71717a" },
};

const chip = (s: Status) =>
  css({ display: "inline-block", padding: "1px 8px", borderRadius: 9, fontSize: 11, fontWeight: 600, backgroundColor: STATUS[s].bg, color: STATUS[s].fg });
const small = css({ fontSize: 12, color: UI.icon });
const linkButton = css({ border: "none", background: "none", padding: 0, color: UI.accent, fontSize: 13, fontWeight: 600, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 4 });
const card = css({ backgroundColor: "#f7f7f9", borderRadius: 16, padding: "12px 14px", marginTop: 10 });
const date = (iso: string) => new Date(iso).toLocaleDateString("en", { year: "numeric", month: "short", day: "numeric" });

const buildingId = (ref: string | null) => (!ref ? null : ref.startsWith("new:") ? -Number(ref.slice(4)) : Number(ref.slice(4)));
const showOnMap = (c: Pick<Contribution, "lat" | "lng">) => goToPlace(c.lat, c.lng, 420);

function MyContributions() {
  const mine = useContribStore((s) => s.mine);
  const loadMine = useContribStore((s) => s.loadMine);
  const [busy, setBusy] = useState<string | null>(null);

  const withdraw = async (c: Contribution) => {
    setBusy(c.id);
    try {
      await withdrawContribution(c.id);
      await loadMine();
    } catch (err) {
      useAuthStore.getState().notify(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  if (!mine.length) {
    return <p css={[small, css({ marginTop: 16, lineHeight: 1.5 })]}>Nothing yet. Right-click a building and choose “Set height…” to suggest a change.</p>;
  }
  return (
    <div>
      {mine.map((c) => (
        <div key={c.id} css={card}>
          <div css={css({ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 })}>
            <span css={css({ fontSize: 14, fontWeight: 600 })}>{describeProposal(c)}</span>
            <span css={chip(c.status)}>{STATUS[c.status].label}</span>
          </div>
          <div css={[small, css({ marginTop: 4 })]}>
            {c.ref ?? "new building"} · {date(c.createdAt)}
          </div>
          {c.reviewNote && <div css={css({ marginTop: 6, fontSize: 13 })}>Reviewer: {c.reviewNote}</div>}
          <div css={css({ display: "flex", gap: 14, marginTop: 8 })}>
            <button css={linkButton} onClick={() => showOnMap(c)}>
              <MapPin css={iconSize(13)} /> Show
            </button>
            {(c.status === "pending" || c.status === "conflict") && (
              <button css={linkButton} disabled={busy === c.id} onClick={() => withdraw(c)}>
                Withdraw
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

/** "a → b" for one field, from the building as it is now to the proposal */
function Change({ label, before, after }: { label: string; before: string | number | null | undefined; after: string | number | null | undefined }) {
  if (after == null) return null;
  return (
    <div css={css({ display: "flex", justifyContent: "space-between", fontSize: 14, padding: "3px 0" })}>
      <span css={css({ color: UI.icon })}>{label}</span>
      <span>
        <span css={css({ color: UI.icon })}>{before ?? "—"}</span> → <strong>{after}</strong>
      </span>
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
  const item: ReviewItem | undefined = queue[Math.min(index, queue.length - 1)];

  // fly to the building and draw the proposed height once its tile is loaded
  useEffect(() => {
    setRejecting(false);
    setNote("");
    setError(null);
    if (!item) return;
    showOnMap(item);
    const id = buildingId(item.ref);
    const height = item.proposal.height;
    if (id === null || height == null) return;
    let tries = 0;
    const timer = window.setInterval(() => {
      const found = tileManager.findBuilding(id);
      if (found || ++tries > 40) {
        clearInterval(timer);
        if (found) tileManager.previewHeight(found, height);
      }
    }, 250);
    return () => {
      clearInterval(timer);
      tileManager.previewHeight(null, null);
    };
  }, [item?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const decide = async (action: "approve" | "reject") => {
    if (!item || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (action === "approve") {
        await approveContribution(item.id, item.stale || item.status === "conflict");
        tileManager.previewHeight(null, null);
        refreshOverlay(); // show the published change right away
        useAuthStore.getState().notify("Approved: now live for everyone");
      } else {
        await rejectContribution(item.id, note.trim());
        useAuthStore.getState().notify("Rejected");
      }
      await loadQueue();
    } catch (err) {
      setError(err instanceof ApiError || err instanceof Error ? err.message : String(err));
      if (err instanceof ApiError && err.code === "conflict") await loadQueue();
    } finally {
      setBusy(false);
    }
  };

  // A approve · R reject · S skip (not while typing)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA") || e.metaKey || e.ctrlKey || e.altKey) return;
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

  const id = buildingId(item.ref);
  const tags = item.base?.tags ?? {};
  const name = item.current?.name ?? item.proposal.name ?? englishName(tags);
  const heightNow = item.current?.height ?? (item.base ? Math.round(buildingHeight(tags) * 10) / 10 : null);
  const levelsNow = item.current?.levels ?? tags["building:levels"];
  const since = item.author.githubSince ? new Date(item.author.githubSince).getFullYear() : null;

  return (
    <div>
      <div css={[small, css({ marginTop: 4 })]}>
        {Math.min(index, queue.length - 1) + 1} of {queue.length} · oldest first
      </div>
      <div css={card}>
        <div css={css({ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 })}>
          <span css={css({ fontSize: 15, fontWeight: 600 })}>{name ?? (item.kind === "create" ? "New building" : "Building")}</span>
          <span css={chip(item.status)}>{STATUS[item.status].label}</span>
        </div>
        <div css={[small, css({ marginTop: 2 })]}>
          {id === null ? "new building" : id < 0 ? "Added on map3d" : `OSM way ${id}`} · {date(item.createdAt)}
        </div>
        <div css={css({ marginTop: 10 })}>
          <Change label="Height" before={heightNow != null ? `${heightNow} m` : null} after={item.proposal.height != null ? `${item.proposal.height} m` : null} />
          <Change label="Levels" before={levelsNow} after={item.proposal.levels} />
          <Change label="Type" before={item.current?.buildingType ?? tags.building} after={item.proposal.buildingType} />
          <Change label="Name" before={name} after={item.proposal.name} />
          {item.proposal.footprint && <Change label="Shape" before="current" after={`${item.proposal.footprint.length} points`} />}
        </div>
        <blockquote css={css({ margin: "10px 0 0", padding: "6px 10px", borderLeft: "3px solid #d4d4d8", fontSize: 13, lineHeight: 1.4 })}>{item.comment}</blockquote>
        <div css={[small, css({ marginTop: 8 })]}>
          @{item.author.login}
          {since && ` · on GitHub since ${since}`} · {item.author.approved} of {item.author.reviewed} approved before
        </div>
        {(item.stale || item.status === "conflict") && (
          <div css={css({ display: "flex", gap: 6, marginTop: 10, fontSize: 13, color: "#991b1b" })}>
            <AlertTriangle css={iconSize(15)} />
            The building changed after this was proposed. Approving applies only the fields above.
          </div>
        )}
      </div>

      {rejecting && (
        <label css={css({ display: "block", marginTop: 12 })}>
          <span css={fieldLabel}>Reason (shown to the contributor)</span>
          <textarea css={[input, css({ height: 64, padding: "8px 10px", resize: "vertical" })]} value={note} onChange={(e) => setNote(e.target.value)} autoFocus />
        </label>
      )}
      {error && <div css={css({ marginTop: 10, fontSize: 13, color: "#b42318" })}>{error}</div>}

      <div css={css({ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" })}>
        {rejecting ? (
          <>
            <button css={[pillButton, css({ padding: "0 14px", fontSize: 14, fontWeight: 600, color: UI.text, backgroundColor: "#e0e0e5" })]} onClick={() => setRejecting(false)}>
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
              {item.stale || item.status === "conflict" ? "Approve anyway" : "Approve"}
            </button>
            <button css={[pillButton, css({ padding: "0 14px", fontSize: 14, fontWeight: 600, color: UI.text, backgroundColor: "#e0e0e5" })]} onClick={() => setRejecting(true)} title="Reject (R)">
              <X css={iconSize(15)} /> Reject
            </button>
            <button
              css={[pillButton, css({ padding: "0 14px", fontSize: 14, fontWeight: 600, color: UI.text, backgroundColor: "#e0e0e5" })]}
              onClick={() => setIndex((i) => (i + 1) % queue.length)}
              disabled={queue.length < 2}
              title="Skip (S)"
            >
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

  useEffect(() => {
    if (panelKind === "mine") useContribStore.getState().loadMine();
    if (panelKind === "review") useContribStore.getState().loadQueue();
  }, [panelKind]);

  return (
    <aside
      aria-label={panelKind === "review" ? "Review queue" : "My contributions"}
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
        <h2 css={css({ margin: 0, fontSize: 20, fontWeight: 600 })}>{panelKind === "review" ? "Review queue" : "My contributions"}</h2>
        <button aria-label="Close" css={[pillButton, css({ width: 30, minWidth: 30, height: 30, backgroundColor: "transparent" })]} onClick={() => setPanel(null)}>
          <X css={iconSize(16)} />
        </button>
      </div>
      {open && (panelKind === "review" ? <ReviewQueue /> : <MyContributions />)}
    </aside>
  );
}
