import { css } from "@emotion/react";
import { useViewStore } from "@/state/viewStore";
import { useAreaStore } from "@/state/areaStore";
import { ThemeChoice, useThemeStore } from "@/state/theme";
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
          backgroundColor: checked ? UI.accent : UI.controlOff,
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
            backgroundColor: UI.knob,
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

/** a row of options, one selected (performance, appearance) */
function Segmented<T extends string>({ label, hint, options, value, onChange }: { label: string; hint?: string; options: { value: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div>
      <span css={css({ display: "block", fontSize: 15, fontWeight: 600 })}>{label}</span>
      {hint && <span css={css({ display: "block", fontSize: 12, color: UI.icon, marginTop: 2 })}>{hint}</span>}
      <div role="radiogroup" aria-label={label} css={css({ display: "flex", marginTop: 10, padding: 3, borderRadius: 12, backgroundColor: UI.line })}>
        {options.map((o) => (
          <button
            key={o.value}
            role="radio"
            aria-checked={value === o.value}
            onClick={() => onChange(o.value)}
            css={css({
              flex: 1,
              height: 30,
              border: "none",
              borderRadius: 9,
              cursor: "pointer",
              fontSize: 13,
              fontWeight: 600,
              color: value === o.value ? UI.text : UI.icon,
              backgroundColor: value === o.value ? UI.raised : "transparent",
              boxShadow: value === o.value ? `0 1px 3px ${UI.shadowStrong}` : "none",
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

function PerformancePicker() {
  const level = useViewStore((s) => s.level);
  const setLevel = useViewStore((s) => s.setLevel);
  return <Segmented label="Performance" hint={LEVEL_HINT[level]} options={LEVEL_OPTIONS} value={level} onChange={setLevel} />;
}

const THEME_OPTIONS: { value: ThemeChoice; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

function AppearancePicker() {
  const choice = useThemeStore((s) => s.choice);
  const setChoice = useThemeStore((s) => s.setChoice);
  return <Segmented label="Appearance" options={THEME_OPTIONS} value={choice} onChange={setChoice} />;
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
      <AppearancePicker />
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
