import { css } from "@emotion/react";
import { Download, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { MapComponent } from "@/components/map/SelectMap";
import { BBox } from "@/api/osmSource";
import { useAreaStore } from "@/state/areaStore";
import { useViewStore } from "@/state/viewStore";
import { UI, iconSize, mobile, panel, pillButton, primaryButton, spin } from "./styles";

/** same limit as the original flow (lat span + lng span) */
const LARGE_AREA = 0.1;

type LatLngLike = { lat: number; lng: number };

function toBBox([a, b]: [LatLngLike, LatLngLike]): BBox {
  return {
    south: Math.min(a.lat, b.lat),
    north: Math.max(a.lat, b.lat),
    west: Math.min(a.lng, b.lng),
    east: Math.max(a.lng, b.lng),
  };
}

function sizeLabel(b: BBox) {
  const midLat = ((b.south + b.north) / 2) * (Math.PI / 180);
  const h = (b.north - b.south) * 111.32;
  const w = (b.east - b.west) * 111.32 * Math.cos(midLat);
  const f = (km: number) => (km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(1)} km`);
  return `${f(w)} × ${f(h)}`;
}

/** Expanding map card: drag a box (Select Box), then download that area as GLB. */
export function DownloadMap({
  open,
  busy,
  error,
  onClose,
  onDownload,
}: {
  open: boolean;
  busy: boolean;
  error: boolean;
  onClose: () => void;
  onDownload: (bbox: BBox) => void;
}) {
  // the map opens where the 3D view currently looks
  const center = useAreaStore((s) => s.center);
  // what the file will contain follows the settings
  const roads = useViewStore((s) => s.showRoads);
  const terrain = useViewStore((s) => s.terrain);
  const contents = ["buildings", roads && "roads", terrain && "terrain"].filter(Boolean).join(" + ");
  const [selection, setSelection] = useState<BBox | null>(null);
  useEffect(() => {
    if (!open) setSelection(null); // the map remounts empty on the next open
  }, [open]);
  const large = selection ? selection.north - selection.south + (selection.east - selection.west) > LARGE_AREA : false;

  return (
    <div
      aria-hidden={!open}
      css={css({
        position: "fixed",
        inset: 0,
        zIndex: 28,
        backgroundColor: UI.scrim,
        backdropFilter: "blur(6px)",
        transition: "opacity .2s",
        opacity: open ? 1 : 0,
        pointerEvents: open ? "auto" : "none",
      })}
      onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}
    >
      <div
        css={[
          panel,
          css({
            position: "absolute",
            top: 94,
            left: UI.sideLeft,
            right: UI.side,
            bottom: 38,
            borderRadius: 32,
            overflow: "hidden",
            transformOrigin: "top right",
            transition: "transform .25s cubic-bezier(.2,.8,.2,1)",
            transform: open ? "none" : "scale(0.2)",
            [mobile]: { top: 16 + UI.barHeight + 12, left: 12, right: 12, bottom: 12, borderRadius: 24 },
          }),
        ]}
      >
        {open && (
          <MapComponent
            height="100%"
            center={[center.lat, center.lng]}
            zoom={14}
            onDone={(pts) => setSelection(toBBox(pts))}
            onRemove={() => setSelection(null)}
          />
        )}

        <div
          css={css({
            position: "absolute",
            left: "50%",
            bottom: 20,
            transform: "translateX(-50%)",
            zIndex: 1000,
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: 6,
            paddingLeft: 18,
            borderRadius: 26,
            backgroundColor: UI.floating,
            boxShadow: `0 4px 20px ${UI.shadowStrong}`,
            whiteSpace: "nowrap",
            maxWidth: "calc(100% - 32px)",
            boxSizing: "border-box",
            fontSize: 14,
            color: UI.text,
            // too narrow for one row: the message on top, the buttons below
            [mobile]: {
              left: 12,
              right: 12,
              transform: "none",
              maxWidth: "none",
              flexWrap: "wrap",
              gap: 8,
              padding: 8,
              borderRadius: 25,
            },
          })}
        >
          <span
            css={css({
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              [mobile]: { flexBasis: "100%", whiteSpace: "normal", padding: "4px 8px 0", fontSize: 13, lineHeight: 1.4 },
            })}
          >
            {error && !busy
              ? "Could not load this area. Try again."
              : busy
                ? "Building the GLB…"
                : selection
                  ? large
                    ? `${sizeLabel(selection)} · ${contents} · large area, may be slow`
                    : `${sizeLabel(selection)} · ${contents}`
                  : "Click Select Box, then drag over the map"}
          </span>
          <button css={[pillButton, css({ padding: "0 14px", fontSize: 14, color: UI.text })]} onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            css={[primaryButton, css({ [mobile]: { flexGrow: 1 } })]}
            disabled={!selection || busy}
            onClick={() => selection && onDownload(selection)}
          >
            {busy ? (
              <Loader2 css={[iconSize(15), css({ animation: `${spin} 1s linear infinite` })]} />
            ) : (
              <Download css={iconSize(15)} />
            )}
            {large ? "Download anyway" : "Download GLB"}
          </button>
        </div>
      </div>
    </div>
  );
}
