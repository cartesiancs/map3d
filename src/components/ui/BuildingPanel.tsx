import { css } from "@emotion/react";
import { useViewStore } from "@/state/viewStore";
import { UI, mobile, panel } from "./styles";
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
  const selected = useViewStore((s) => s.selected);
  const select = useViewStore((s) => s.select);
  const tags = selected?.tags ?? {};
  const addr = address(tags);
  // English only: other-language names and values in other scripts are never shown
  const others = Object.entries(tags).filter(
    ([k, v]) => !SHOWN.has(k) && !k.startsWith("addr:") && !isForeignNameKey(k) && !isOtherLanguageKey(k) && isEnglishText(v),
  );
  const name = englishName(tags);
  const title = name ?? (addr || "Building");
  const description = [tags["description:en"], tags.description].find(isEnglishText);

  return (
    <aside
      aria-label="Building information"
      aria-hidden={!selected}
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
          opacity: selected ? 1 : 0,
          transform: selected ? "none" : "translateX(24px)",
          pointerEvents: selected ? "auto" : "none",
          [mobile]: {
            top: "auto",
            left: 12,
            right: 12,
            bottom: 12,
            width: "auto",
            maxHeight: "55vh",
            transform: selected ? "none" : "translateY(24px)",
          },
        }),
      ]}
    >
      <button
        aria-label="Close"
        onClick={() => select(null)}
        css={css({
          alignSelf: "center",
          border: "none",
          background: "transparent",
          padding: "14px 20px 0",
          cursor: "pointer",
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
      <div css={css({ overflowY: "auto", paddingTop: 36, userSelect: "text", [mobile]: { paddingTop: 20 } })}>
        <h2 css={css({ margin: 0, fontSize: 24, fontWeight: 600, lineHeight: 1.25, wordBreak: "break-word" })}>{title}</h2>
        {name && addr && <p css={css({ margin: "6px 0 0", fontSize: 14, color: UI.icon })}>{addr}</p>}
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
        <p css={css({ margin: "24px 0 0", fontSize: 12, color: UI.placeholder })}>OSM way {selected?.id}</p>
      </div>
    </aside>
  );
}
