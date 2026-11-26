import { css } from "@emotion/react";
import { useViewStore } from "@/state/viewStore";
import { Ruler } from "lucide-react";
import { UI, iconSize, mobile, panel, pillButton } from "./styles";
import { pendingFor, useContribStore } from "@/state/contribStore";
import { useAuthStore } from "@/state/authStore";
import { describeProposal, refOf } from "@/api/contributions";
import { tileManager } from "@/three/Space";
import { fromScene } from "@/three/tiles/geo";
import { useLastValue, useSwipeDown } from "./usePanel";
import { englishName, isEnglishText, isForeignNameKey } from "@/utils/english";

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const FACTS: [key: string, label: string, format?: (v: string) => string][] = [
  ["building", "Type", (v) => (v === "yes" ? "Building" : cap(v.replace(/_/g, " ")))],
  ["height", "Height", (v) => (/^[\d.]+$/.test(v) ? `${v} m` : v)],
  ["building:levels", "Levels"],
  ["amenity", "Facility", (v) => cap(v.replace(/_/g, " "))],
  ["denomination", "Denomination"],
  ["start_date", "Built"],
  ["architect", "Architect"],
  ["operator", "Operator"],
];
const SHOWN = new Set(["name", "description", "source", ...FACTS.map(([k]) => k)]);

/** Where the building comes from: OSM, an approved edit of it, or added on map3d (negative id) */
function source(id: number | undefined, tags: Record<string, string>) {
  if (id === undefined) return "";
  if (id < 0) return "Added on map3d";
  return tags["map3d:edited"] ? `OSM way ${id} · edited on map3d` : `OSM way ${id}`;
}

/** English only: address parts in another script are left out */
function address(tags: Record<string, string>) {
  return [
    [tags["addr:housenumber"], tags["addr:street"]].filter(isEnglishText).join(" "),
    tags["addr:district"],
    tags["addr:city"],
    tags["addr:postcode"],
  ]
    .filter(isEnglishText)
    .join(", ");
}

/** a language variant of a key (description:fr, inscription:ko, …), other than English */
const isOtherLanguageKey = (k: string) => /:[a-z]{2}(-[A-Za-z]{2,4})?$/.test(k) && !/:en(-[A-Za-z]{2,4})?$/.test(k);

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div css={css({ display: "flex", justifyContent: "space-between", gap: 16, padding: "7px 0", fontSize: 15 })}>
      <span css={css({ color: UI.icon, flexShrink: 0 })}>{label}</span>
      <span css={css({ textAlign: "right", wordBreak: "break-word" })}>{value}</span>
    </div>
  );
}

export function BuildingPanel() {
  const current = useViewStore((s) => s.selected);
  // while the panel fades out it keeps showing the building it showed
  const selected = useLastValue(current);
  const select = useViewStore((s) => s.select);
  // Set height… takes the same place while open
  const editing = useContribStore((s) => s.heightEdit !== null);
  const mine = useContribStore((s) => s.mine);
  const signedIn = useAuthStore((s) => s.status === "signedIn");
  const open = !!current && !editing;
  const close = () => select(null);
  const swipe = useSwipeDown<HTMLElement>(close);
  const pending = selected ? pendingFor(mine, refOf(selected.id)) : undefined;
  const tags = selected?.tags ?? {};
  const addr = address(tags);
  // English only: other-language names and values in other scripts are never shown
  const others = Object.entries(tags).filter(
    ([k, v]) => !SHOWN.has(k) && !k.startsWith("addr:") && !k.startsWith("map3d:") && !isForeignNameKey(k) && !isOtherLanguageKey(k) && isEnglishText(v),
  );
  const name = englishName(tags);
  const title = name ?? (addr || "Building");
  const description = [tags["description:en"], tags.description].find(isEnglishText);

  return (
    <aside
      ref={swipe.ref}
      aria-label="Building information"
      aria-hidden={!open}
      css={[
        panel,
        css({
          position: "fixed",
          top: 94,
          right: UI.side,
          bottom: 84,
          width: 372,
          boxSizing: "border-box",
          borderRadius: 32,
          padding: "0 28px 28px",
          zIndex: 20,
          display: "flex",
          flexDirection: "column",
          transition: "opacity .2s, transform .2s",
          opacity: open ? 1 : 0,
          transform: open ? "none" : "translateX(24px)",
          pointerEvents: open ? "auto" : "none",
          [mobile]: {
            top: "auto",
            left: 12,
            right: 12,
            bottom: 12,
            width: "auto",
            maxHeight: "55vh",
            transform: open ? "none" : "translateY(24px)",
          },
        }),
      ]}
    >
      {/* drag down to close (touch: the whole header; mouse: the handle), or tap the handle */}
      <div {...swipe.handlers} css={css({ flexShrink: 0, display: "flex", flexDirection: "column", touchAction: "none" })}>
      <button
        aria-label="Close"
        data-drag-handle
        onClick={close}
        css={css({
          alignSelf: "center",
          touchAction: "none",
          cursor: "grab",
          ":active": { cursor: "grabbing" },
          border: "none",
          background: "transparent",
          padding: "14px 20px 0",
          flexShrink: 0,
          "::before": {
            content: '""',
            display: "block",
            width: 108,
            height: 4,
            borderRadius: 2,
            backgroundColor: UI.handle,
          },
        })}
      />
      <div css={css({ paddingTop: 36, userSelect: "text", [mobile]: { paddingTop: 20 } })}>
        <h2 css={css({ margin: 0, fontSize: 24, fontWeight: 600, lineHeight: 1.25, wordBreak: "break-word" })}>{title}</h2>
        {name && addr && <p css={css({ margin: "6px 0 0", fontSize: 14, color: UI.icon })}>{addr}</p>}
      </div>
      </div>
      <div css={css({ overflowY: "auto", userSelect: "text", minHeight: 0 })}>
        {description && <p css={css({ margin: "20px 0 0", fontSize: 16, lineHeight: 1.2 })}>{description}</p>}

        <div css={css({ marginTop: 22 })}>
          {FACTS.map(([k, label, format]) =>
            isEnglishText(tags[k]) ? <Row key={k} label={label} value={format ? format(tags[k]) : tags[k]} /> : null,
          )}
        </div>

        {others.length > 0 && (
          <details css={css({ marginTop: 18, fontSize: 14 })}>
            <summary css={css({ cursor: "pointer", color: UI.icon, fontWeight: 600, padding: "6px 0" })}>
              All tags ({others.length})
            </summary>
            {others.map(([k, v]) => (
              <div key={k} css={css({ display: "flex", justifyContent: "space-between", gap: 12, padding: "4px 0" })}>
                <span css={css({ color: UI.icon })}>{k}</span>
                <span css={css({ textAlign: "right", wordBreak: "break-all" })}>{v}</span>
              </div>
            ))}
          </details>
        )}
        {pending && (
          <p css={css({ margin: "20px 0 0", fontSize: 13, color: UI.pendingFg })}>Your proposal ({describeProposal(pending)}) is waiting for review.</p>
        )}
        {signedIn && selected && (
          <button
            onClick={() => {
              const info = tileManager.describe(selected.key, selected.index);
              if (!info) return;
              const ll = fromScene(tileManager.origin, info.center.x, info.center.z);
              useContribStore.getState().startHeightEdit({ ...selected, lat: ll.lat, lng: ll.lng, height: info.height });
            }}
            css={[pillButton, css({ marginTop: 18, padding: "0 14px", fontSize: 14, fontWeight: 600, color: UI.text, backgroundColor: UI.control, gap: 6, [mobile]: { display: "none" } })]}
          >
            <Ruler css={iconSize(15)} /> {pending ? "Edit my proposal" : "Set height…"}
          </button>
        )}
        <p css={css({ margin: "24px 0 0", fontSize: 12, color: UI.placeholder })}>{source(selected?.id, tags)}</p>
      </div>
    </aside>
  );
}
