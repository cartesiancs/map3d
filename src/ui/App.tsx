import { css } from "@emotion/react";
import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Space, goToPlace, tileManager } from "../three/Space";
import { TopBar } from "@/components/ui/TopBar";
import { SettingsPanel } from "@/components/ui/SettingsPanel";
import { BuildingPanel } from "@/components/ui/BuildingPanel";
import { DownloadMap } from "@/components/ui/DownloadMap";
import { MapContextMenu } from "@/components/ui/MapContextMenu";
import { ModeBar } from "@/components/edit/ModeBar";
import { EditToolbar } from "@/components/edit/EditToolbar";
import { EditPanel } from "@/components/edit/EditPanel";
import { EditDialogs } from "@/components/edit/EditDialogs";
import { ContributionsPanel } from "@/components/ui/ContributionsPanel";
import { LoadProgress } from "@/components/ui/LoadProgress";
import { UI, iconSize, spin } from "@/components/ui/styles";
import { START_VIEW, useAreaStore } from "@/state/areaStore";
import { useViewStore } from "@/state/viewStore";
import { useAuthStore } from "@/state/authStore";
import { useContribStore } from "@/state/contribStore";
import { changedDrafts, useEditStore } from "@/state/editStore";
import { BBox } from "@/api/osmSource";
import { exportAreaGLB } from "@/three/exportArea";
import { toScene } from "@/three/tiles/geo";

function StatusPill() {
  const { tiles, loading, failed } = useAreaStore((s) => s.stats);
  const firstLoad = tiles === 0;
  if (!(firstLoad && loading > 0) && !(failed > 0 && loading === 0 && firstLoad)) return null;
  return (
    <div
      role="status"
      css={css({
        position: "fixed",
        left: "50%",
        bottom: 32,
        transform: "translateX(-50%)",
        zIndex: 15,
        display: "flex",
        alignItems: "center",
        gap: 8,
        height: UI.barHeight,
        padding: "0 16px",
        borderRadius: UI.barHeight / 2,
        backgroundColor: UI.surface,
        color: UI.text,
        fontSize: 14,
        fontWeight: 500,
        whiteSpace: "nowrap",
      })}
    >
      {loading > 0 ? (
        <>
          <Loader2 css={[iconSize(15), css({ animation: `${spin} 1s linear infinite` })]} />
          {/* the first visit opens on Central Park; later visits open where the last one left off */}
          {!START_VIEW && tileManager.originId === 0 ? "Loading Central Park…" : "Loading…"}
        </>
      ) : (
        <>
          Could not load map data.
          <button
            onClick={() => tileManager.retryFailed()}
            css={css({ border: "none", background: "none", color: UI.accent, fontWeight: 600, cursor: "pointer", padding: 0, fontSize: 14 })}
          >
            Retry
          </button>
        </>
      )}
    </div>
  );
}

/** Credits required by the data licenses, shown while each source is on screen. */
function Attribution() {
  // the land / sea map is OpenStreetMap data too (coastline), covered by the first credit
  const terrain = useViewStore((s) => s.terrain);
  const link = css({ color: "inherit", pointerEvents: "auto" });
  return (
    <>
      © <a css={link} href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors · map3d
      contributors (<a css={link} href="https://opendatacommons.org/licenses/odbl/1-0/" target="_blank" rel="noreferrer">ODbL</a>)
      {terrain && (
        <>
          {" · Elevation: "}
          <a css={link} href="https://github.com/tilezen/joerd/blob/master/docs/attribution.md" target="_blank" rel="noreferrer">
            Terrain Tiles
          </a>{" "}
          (USGS, NOAA, Copernicus …)
        </>
      )}
    </>
  );
}

function App() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [downloadOpen, setDownloadOpen] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState(false);
  const select = useViewStore((s) => s.select);

  // who is signed in (GitHub, via the map3d API); also reads ?auth=… after coming back from GitHub
  useEffect(() => {
    useAuthStore.getState().init();
  }, []);

  // my proposals (badges, "Edit my proposal") and, for admins, the size of the review queue
  const authStatus = useAuthStore((s) => s.status);
  const isAdmin = useAuthStore((s) => s.user?.isAdmin ?? false);
  useEffect(() => {
    const contrib = useContribStore.getState();
    if (authStatus !== "signedIn") {
      contrib.clear();
      return;
    }
    contrib.loadMine();
    if (!isAdmin) return;
    contrib.loadQueue();
    const timer = window.setInterval(() => useContribStore.getState().loadQueue(), 120_000);
    return () => clearInterval(timer);
  }, [authStatus, isAdmin]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (useEditStore.getState().active) return; // Edit mode steps back on its own (three/edit/EditInput.tsx)
      const contrib = useContribStore.getState();
      contrib.setPanel(null);
      setSettingsOpen(false);
      if (!downloading) setDownloadOpen(false);
      select(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [downloading, select]);

  // Edit mode takes over the screen: the download panel closes; leaving the page warns about unsent changes
  const editing = useEditStore((s) => s.active);
  useEffect(() => {
    if (editing) {
      setDownloadOpen(false);
      setSettingsOpen(false);
    }
  }, [editing]);
  useEffect(() => {
    const onLeave = (e: BeforeUnloadEvent) => {
      const s = useEditStore.getState();
      if (s.active && changedDrafts(s).length) e.preventDefault();
    };
    window.addEventListener("beforeunload", onLeave);
    return () => window.removeEventListener("beforeunload", onLeave);
  }, []);
  // signing out ends Edit mode (changes stay saved on this device)
  useEffect(() => {
    if (authStatus !== "signedIn" && useEditStore.getState().active) useEditStore.getState().exit(true);
  }, [authStatus]);

  const handleDownload = async (bbox: BBox) => {
    setDownloading(true);
    setDownloadError(false);
    try {
      // the file follows the settings: roads only when shown, terrain (and buildings on it) when on
      const { showRoads, terrain } = useViewStore.getState();
      await exportAreaGLB(bbox, { roads: showRoads, terrain });
      setDownloadOpen(false);
      // show the downloaded area in the 3D view
      const lat = (bbox.south + bbox.north) / 2;
      const lng = (bbox.west + bbox.east) / 2;
      const [x, z] = toScene(tileManager.origin, lat, lng);
      const [ex, ez] = toScene(tileManager.origin, bbox.north, bbox.east);
      goToPlace(lat, lng, Math.max(300, Math.hypot(ex - x, ez - z) * 1.6));
    } catch (err) {
      console.error("Download failed:", err);
      setDownloadError(true);
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div css={css({ position: "fixed", inset: 0 })}>
      <Space />

      <TopBar
        settingsOpen={settingsOpen}
        onToggleSettings={() => setSettingsOpen((v) => !v)}
        downloadOpen={downloadOpen}
        onToggleDownload={() => {
          setSettingsOpen(false);
          setDownloadError(false);
          setDownloadOpen((v) => !v);
        }}
        downloading={downloading}
      />
      <SettingsPanel open={settingsOpen} />
      <BuildingPanel />
      <ContributionsPanel />
      <ModeBar />
      <EditPanel />
      <EditToolbar />
      <EditDialogs />
      <MapContextMenu />
      <DownloadMap
        open={downloadOpen}
        busy={downloading}
        error={downloadError}
        onClose={() => setDownloadOpen(false)}
        onDownload={handleDownload}
      />
      <StatusPill />

      {/* bottom edge, one row: the loading ring in the bottom left corner, the credits on the right. The ring keeps
          its place while hidden, so the credits never reflow, and they wrap beside it (phones) instead of under it. */}
      <div
        css={css({
          position: "fixed",
          right: 10,
          bottom: 6,
          left: 10,
          zIndex: 10,
          display: "flex",
          alignItems: "flex-end",
          gap: 8,
          pointerEvents: "none",
        })}
      >
        <LoadProgress />
        <div
          css={css({
            flex: 1,
            minWidth: 0,
            fontSize: 11,
            lineHeight: 1.4,
            textAlign: "right",
            color: UI.icon,
            textShadow: `0 0 3px ${UI.halo}`,
          })}
        >
          <Attribution />
        </div>
      </div>
    </div>
  );
}

export default App;
