import { css } from "@emotion/react";
import { useViewStore } from "@/state/viewStore";
import { useAreaStore } from "@/state/areaStore";
import { PerfLevel } from "@/three/tiles/levels";
import { UI, mobile, panel } from "./styles";

function Toggle({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label css={css({ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, cursor: "pointer" })}>
      <span>
        <span css={css({ display: "block", fontSize: 15, fontWeight: 600 })}>{label}</span>
        {hint && <span css={css({ display: "block", fontSize: 12, color: UI.icon, marginTop: 2 })}>{hint}</span>}
      </span>
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        css={css({
          appearance: "none",
          width: 40,
          height: 24,
          borderRadius: 12,
          backgroundColor: checked ? UI.accent : "#cfcfd4",
          position: "relative",
          cursor: "pointer",
          transition: "background-color .15s",
          flexShrink: 0,
          margin: 0,
          "::after": {
            content: '""',
            position: "absolute",
            top: 3,
            left: checked ? 19 : 3,
            width: 18,
            height: 18,
            borderRadius: 9,
            backgroundColor: "#ffffff",
            transition: "left .15s",
          },
        })}
      />
    </label>
  );
}

const LEVEL_OPTIONS: { value: PerfLevel; label: string }[] = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];

const LEVEL_HINT: Record<PerfLevel, string> = {
  low: "Smallest view distance, simple lighting",
  medium: "Balanced for most phones and laptops",
  high: "Farthest view distance, sharpest image",
};

function PerformancePicker() {
  const level = useViewStore((s) => s.level);
  const setLevel = useViewStore((s) => s.setLevel);
  return (
    <div>
      <span css={css({ display: "block", fontSize: 15, fontWeight: 600 })}>Performance</span>
      <span css={css({ display: "block", fontSize: 12, color: UI.icon, marginTop: 2 })}>{LEVEL_HINT[level]}</span>
      <div
        role="radiogroup"
        aria-label="Performance"
        css={css({ display: "flex", marginTop: 10, padding: 3, borderRadius: 12, backgroundColor: "#dcdce1" })}
      >
        {LEVEL_OPTIONS.map((o) => (
          <button
            key={o.value}
            role="radio"
            aria-checked={level === o.value}
            onClick={() => setLevel(o.value)}
            css={css({
              flex: 1,
              height: 30,
              border: "none",
              borderRadius: 9,
              cursor: "pointer",
              fontSize: 13,
              fontWeight: 600,
              color: level === o.value ? UI.text : UI.icon,
              backgroundColor: level === o.value ? "#ffffff" : "transparent",
              boxShadow: level === o.value ? "0 1px 3px rgba(0,0,0,0.1)" : "none",
              transition: "background-color .15s",
            })}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function SettingsPanel({ open }: { open: boolean }) {
  const showRoads = useViewStore((s) => s.showRoads);
  const setShowRoads = useViewStore((s) => s.setShowRoads);
  const terrain = useViewStore((s) => s.terrain);
  const setTerrain = useViewStore((s) => s.setTerrain);
  const groundMap = useViewStore((s) => s.groundMap);
  const setGroundMap = useViewStore((s) => s.setGroundMap);
  const stats = useAreaStore((s) => s.stats);

  return (
    <div
      role="dialog"
      aria-label="Settings"
      css={[
        panel,
        css({
          position: "fixed",
          top: UI.top + UI.barHeight + 8,
          left: UI.sideLeft,
          width: 360,
          minHeight: 194,
          boxSizing: "border-box",
          borderRadius: 24,
          padding: 22,
          display: "flex",
          flexDirection: "column",
          gap: 18,
          zIndex: 25,
          transformOrigin: "top left",
          transition: "opacity .15s, transform .15s",
          opacity: open ? 1 : 0,
          transform: open ? "none" : "scale(0.96) translateY(-6px)",
          pointerEvents: open ? "auto" : "none",
          [mobile]: { left: 16, right: 16, width: "auto", top: 16 + UI.barHeight + 8 },
        }),
      ]}
    >
      <PerformancePicker />
      <Toggle label="Terrain" hint="Elevation under buildings and roads" checked={terrain} onChange={setTerrain} />
      <Toggle label="Ground map" hint="Land and sea on the ground" checked={groundMap} onChange={setGroundMap} />
      <Toggle label="Roads" hint="Show the road network" checked={showRoads} onChange={setShowRoads} />
      <div css={css({ marginTop: "auto", fontSize: 12, color: UI.icon, lineHeight: 1.5 })}>
        {stats.buildings.toLocaleString()} buildings in {stats.tiles} tiles
        {stats.loading > 0 && ` · loading ${stats.loading}`}
        <br />
        Map data © OpenStreetMap contributors (ODbL)
      </div>
    </div>
  );
}
