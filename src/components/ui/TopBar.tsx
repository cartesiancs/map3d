import { css } from "@emotion/react";
import { Download, Github, Loader2, LocateFixed, Minus, Plus, Search, Settings, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { NamedBuilding, useAreaStore } from "@/state/areaStore";
import { useViewStore } from "@/state/viewStore";
import { City, loadCities, nearestCity, normalize, searchCities } from "@/data/cities";
import { goToPlace } from "@/three/Space";
import { UI, iconSize, mobile, pillButton, primaryButton, panel, spin } from "./styles";

const MAX_CITIES = 5;
const MAX_BUILDINGS = 6;
/** camera distance for a city overview (scene units, ≈ 4.8 km) */
const CITY_VIEW = 2200;

type Result = { kind: "city"; city: City } | { kind: "building"; building: NamedBuilding };

// country only: Natural Earth region names are often in the local language (e.g. "Nordrhein-Westfalen")
const cityLine = (c: City) => c.country;

/** Searches major cities (anywhere) and the named buildings of the tiles loaded around the view. */
function SearchBox() {
  const named = useAreaStore((s) => s.named);
  const focusBuilding = useViewStore((s) => s.focusBuilding);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [cities, setCities] = useState<City[] | null>(null);

  // the city list (≈ 390 KB gzip) is fetched the first time the search box is used
  const ensureCities = () => {
    if (!cities) loadCities().then(setCities).catch((err) => console.error("cities:", err));
  };

  const results = useMemo<Result[]>(() => {
    const q = normalize(query);
    if (!q) return [];
    const out: Result[] = cities ? searchCities(cities, query, MAX_CITIES).map((city) => ({ kind: "city", city })) : [];
    const seen = new Set<number>();
    let n = 0;
    for (const b of named) {
      if (n >= MAX_BUILDINGS) break;
      if (seen.has(b.id) || !(normalize(b.label).includes(q) || normalize(b.sub).includes(q))) continue;
      seen.add(b.id);
      out.push({ kind: "building", building: b });
      n++;
    }
    return out;
  }, [named, query, cities]);

  const pick = (r: Result) => {
    if (r.kind === "city") {
      goToPlace(r.city.lat, r.city.lng, CITY_VIEW);
      setQuery(r.city.name);
    } else {
      focusBuilding({ key: r.building.key, index: r.building.index });
      setQuery(r.building.label);
    }
    setOpen(false);
  };

  return (
    <div css={css({ position: "relative", width: 464, [mobile]: { width: "100%" } })}>
      <label
        css={css({
          height: UI.barHeight,
          borderRadius: UI.barHeight / 2,
          backgroundColor: UI.surface,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
          padding: "0 16px",
          color: UI.placeholder,
          cursor: "text",
        })}
      >
        <Search css={iconSize(15)} />
        <input
          value={query}
          placeholder="Search"
          aria-label="Search cities and buildings"
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
            ensureCities();
          }}
          onFocus={() => {
            setOpen(true);
            ensureCities();
          }}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && results[0]) pick(results[0]);
            if (e.key === "Escape") (e.target as HTMLInputElement).blur();
          }}
          css={css({
            border: "none",
            outline: "none",
            background: "transparent",
            fontSize: 14,
            fontWeight: 500,
            color: UI.text,
            width: query ? "100%" : 52,
            transition: "width .15s",
            userSelect: "text",
            "::placeholder": { color: UI.placeholder },
          })}
        />
      </label>
      {open && query.trim() && (
        <div
          css={[
            panel,
            css({
              position: "absolute",
              top: UI.barHeight + 8,
              left: 0,
              right: 0,
              borderRadius: 20,
              padding: 8,
              zIndex: 20,
              maxHeight: "min(70vh, 560px)",
              overflowY: "auto",
            }),
          ]}
        >
          {results.length === 0 ? (
            <div css={css({ padding: "10px 12px", fontSize: 14, color: UI.placeholder })}>
              {cities ? "No city or building found" : "Searching…"}
            </div>
          ) : (
            results.map((r, i) => {
              const first = i === 0 || results[i - 1].kind !== r.kind;
              return (
                <div key={r.kind === "city" ? `c${r.city.lat},${r.city.lng}` : `b${r.building.id}`}>
                  {first && (
                    <div css={css({ padding: "6px 12px 2px", fontSize: 11, fontWeight: 600, color: UI.placeholder, textTransform: "uppercase", letterSpacing: 0.4 })}>
                      {r.kind === "city" ? "Cities" : "Buildings nearby"}
                    </div>
                  )}
                  <button
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => pick(r)}
                    css={css({
                      display: "block",
                      width: "100%",
                      textAlign: "left",
                      border: "none",
                      background: "transparent",
                      borderRadius: 12,
                      padding: "8px 12px",
                      cursor: "pointer",
                      color: UI.text,
                      ":hover": { backgroundColor: UI.surfaceHover },
                    })}
                  >
                    {r.kind === "city" ? (
                      <>
                        <div css={css({ fontSize: 14, fontWeight: 600 })}>
                          {r.city.name}
                        </div>
                        <div css={css({ fontSize: 12, color: UI.icon, marginTop: 2 })}>{cityLine(r.city)}</div>
                      </>
                    ) : (
                      <>
                        <div css={css({ fontSize: 14, fontWeight: 600 })}>{r.building.label}</div>
                        {r.building.sub && <div css={css({ fontSize: 12, color: UI.icon, marginTop: 2 })}>{r.building.sub}</div>}
                      </>
                    )}
                  </button>
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

const GEO_ERRORS: Record<number, string> = {
  1: "Location permission was denied",
  2: "Your location is not available",
  3: "Finding your location took too long",
};

/**
 * Goes to the city you are in: the browser's position (asked once, with the browser's permission prompt)
 * is matched to the nearest major city. The position stays in the browser; nothing is sent anywhere.
 */
function LocateButton() {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const show = (text: string) => {
    setNote(text);
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setNote(null), 3500);
  };

  const locate = () => {
    if (!("geolocation" in navigator)) return show("This browser cannot share its location");
    setBusy(true);
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        try {
          const all = await loadCities();
          const { latitude, longitude } = pos.coords;
          const hit = nearestCity(all, latitude, longitude);
          if (!hit || hit.km > 100) {
            // far from every listed city (sea, wilderness): show the position itself
            goToPlace(latitude, longitude, CITY_VIEW);
            return show("Going to your location");
          }
          goToPlace(hit.city.lat, hit.city.lng, CITY_VIEW);
          show(`Going to ${hit.city.name}`);
        } finally {
          setBusy(false);
        }
      },
      (err) => {
        setBusy(false);
        show(GEO_ERRORS[err.code] ?? "Your location is not available");
      },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 10 * 60 * 1000 },
    );
  };

  return (
    <div css={css({ position: "relative", [mobile]: { display: "none" } })}>
      <button css={pillButton} aria-label="Go to my city" title="Go to my city" onClick={locate} disabled={busy}>
        {busy ? (
          <Loader2 css={[iconSize(16), css({ animation: `${spin} 1s linear infinite` })]} />
        ) : (
          <LocateFixed css={iconSize(16)} />
        )}
      </button>
      {note && (
        <div
          role="status"
          css={[
            panel,
            css({
              position: "absolute",
              top: UI.barHeight + 8,
              left: 0,
              whiteSpace: "nowrap",
              padding: "8px 14px",
              borderRadius: 14,
              fontSize: 13,
              fontWeight: 500,
            }),
          ]}
        >
          {note}
        </div>
      )}
    </div>
  );
}

export function TopBar({
  settingsOpen,
  onToggleSettings,
  downloadOpen,
  onToggleDownload,
  downloading,
}: {
  settingsOpen: boolean;
  onToggleSettings: () => void;
  downloadOpen: boolean;
  onToggleDownload: () => void;
  downloading: boolean;
}) {
  const zoom = useViewStore((s) => s.zoom);

  return (
    <div
      css={css({
        position: "fixed",
        top: UI.top,
        left: UI.sideLeft,
        right: UI.side,
        display: "grid",
        gridTemplateColumns: "1fr auto 1fr",
        alignItems: "center",
        gap: 16,
        zIndex: 30,
        pointerEvents: "none",
        "& > *": { pointerEvents: "auto" },
        [mobile]: { left: 16, right: 16, top: 16, gridTemplateColumns: "auto 1fr auto", gap: 8 },
      })}
    >
      <div css={css({ justifySelf: "start", display: "flex", gap: 8 })}>
        <button
          css={[pillButton, settingsOpen && css({ backgroundColor: UI.surfaceHover })]}
          aria-label="Settings"
          aria-expanded={settingsOpen}
          onClick={onToggleSettings}
        >
          <Settings css={iconSize(16)} />
        </button>
        <LocateButton />
      </div>

      <SearchBox />

      <div css={css({ justifySelf: "end", display: "flex", alignItems: "center", gap: 16, [mobile]: { gap: 8 } })}>
        <div
          css={css({
            display: "flex",
            height: UI.barHeight,
            borderRadius: UI.barHeight / 2,
            backgroundColor: UI.surface,
            overflow: "hidden",
            [mobile]: { display: "none" },
          })}
        >
          <button css={[pillButton, css({ width: 36, borderRadius: 0 })]} aria-label="Zoom in" onClick={() => zoom(0.7)}>
            <Plus css={iconSize(17)} />
          </button>
          <button css={[pillButton, css({ width: 36, borderRadius: 0 })]} aria-label="Zoom out" onClick={() => zoom(1.4)}>
            <Minus css={iconSize(17)} />
          </button>
        </div>
        <button
          css={pillButton}
          aria-label="GitHub"
          onClick={() => window.open("https://github.com/cartesiancs/map3d", "_blank", "noopener")}
        >
          <Github css={iconSize(18)} />
        </button>
        <button
          css={[primaryButton, css({ [mobile]: { padding: 0, width: UI.barHeight } })]}
          aria-label={downloadOpen ? "Close" : "Download"}
          onClick={onToggleDownload}
          disabled={downloading}
        >
          {downloading ? (
            <Loader2 css={[iconSize(15), css({ animation: `${spin} 1s linear infinite` })]} />
          ) : downloadOpen ? (
            <X css={iconSize(15)} />
          ) : (
            <Download css={iconSize(15)} />
          )}
          <span css={css({ [mobile]: { display: "none" } })}>
            {downloading ? "Preparing" : downloadOpen ? "Close" : "Download"}
          </span>
        </button>
      </div>
    </div>
  );
}
